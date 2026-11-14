#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CPU-/RAM-Dauerlogging fuer den Node-Cascade-Worker (Default: alle 10 s).

Liest ausschliesslich /proc + die systemd-CGroup des Workers -> keine Pakete,
kein Eingriff in agent.js, Worker laeuft unangetastet weiter.

Gemessen wird pro Intervall:
  procs              Prozesse der Service-CGroup (Node = 1 Worker-Prozess je Kette,
                     kein Prozess pro Call -> Calls sind an CPU/RSS erkennbar)
  cpu_pct_1core      CPU-Auslastung in % EINES Kerns (100 % = 1 Kern voll)
  cpu_ms             verbrauchte CPU-Millisekunden im Intervall
  rss_mb             Summe RSS (physischer Speicher) der Prozesse
  sys_cpu_pct        CPU-Auslastung des ganzen Systems
  sys_steal_pct      Steal-Anteil (fremde VM/Hypervisor) -> Shared-CPU-Nachweis
  ncpu               sichtbare Kerne

Ausgabe: stdout (-> journald) und CSV (Default /var/log/node-cascade-metrics.csv).
"""
import argparse
import os
import time

CLK_TCK = os.sysconf("SC_CLK_TCK")
PAGE = os.sysconf("SC_PAGE_SIZE")


def cgroup_pids(unit: str):
    """Alle PIDs der systemd-Unit (cgroup v2). Faellt auf MainPID zurueck."""
    path = f"/sys/fs/cgroup/system.slice/{unit}/cgroup.procs"
    try:
        with open(path) as f:
            return [int(x) for x in f.read().split()]
    except OSError:
        pass
    # Fallback: MainPID + Kinder aus /proc
    try:
        with open(f"/run/systemd/system/{unit}") as f:
            pass
    except OSError:
        pass
    pids = []
    mp = None
    try:
        import subprocess
        out = subprocess.run(
            ["systemctl", "show", "-p", "MainPID", "--value", unit],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        mp = int(out) if out.isdigit() and int(out) > 1 else None
    except Exception:
        mp = None
    if mp:
        pids.append(mp)
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                with open(f"/proc/{entry}/stat") as f:
                    ppid = int(f.read().rsplit(") ", 1)[1].split()[1])
                if ppid in pids:
                    pids.append(int(entry))
            except Exception:
                continue
    return pids


def cpu_ticks(pid: int):
    try:
        with open(f"/proc/{pid}/stat") as f:
            fields = f.read().rsplit(") ", 1)[1].split()
        return int(fields[11]) + int(fields[12])  # utime + stime
    except Exception:
        return None


def rss_mb(pid: int):
    try:
        with open(f"/proc/{pid}/statm") as f:
            return int(f.read().split()[1]) * PAGE / 1048576.0
    except Exception:
        return None


def system_cpu():
    """(busy_pct, steal_pct) des Gesamtsystems aus /proc/stat."""
    fields = []
    with open("/proc/stat") as f:
        for line in f:
            if line.startswith("cpu "):
                fields = [int(x) for x in line.split()[1:]]
                break
    if not fields:
        return None
    idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
    steal = fields[7] if len(fields) > 7 else 0
    total = sum(fields)
    return total, idle, steal


def main():
    ap = argparse.ArgumentParser(description="CPU/RAM-Logging fuer einen systemd-Worker")
    ap.add_argument("--unit", default="node-cascade.service")
    ap.add_argument("--interval", type=float, default=10.0)
    ap.add_argument("--csv", default="/var/log/node-cascade-metrics.csv")
    a = ap.parse_args()

    header = "ts,procs,cpu_pct_1core,cpu_ms,rss_mb,sys_cpu_pct,sys_steal_pct,ncpu\n"
    if not os.path.exists(a.csv) or os.path.getsize(a.csv) == 0:
        with open(a.csv, "w") as f:
            f.write(header)

    print(
        f"[metrics] start unit={a.unit} interval={a.interval:g}s csv={a.csv} ncpu={os.cpu_count()}",
        flush=True,
    )

    prev = {}
    prev_sys = system_cpu()
    while True:
        time.sleep(a.interval)

        pids = cgroup_pids(a.unit)
        cur = {}
        tot_rss = 0.0
        tot_dticks = 0
        for pid in pids:
            t = cpu_ticks(pid)
            r = rss_mb(pid)
            if t is None or r is None:
                continue
            cur[pid] = t
            tot_rss += r
            tot_dticks += max(0, t - prev.get(pid, t))
        prev = cur

        cpu_pct = 100.0 * (tot_dticks / CLK_TCK) / a.interval
        cpu_ms = 1000.0 * tot_dticks / CLK_TCK

        sys_cpu_pct = sys_steal_pct = -1.0
        now_sys = system_cpu()
        if prev_sys and now_sys:
            total = now_sys[0] - prev_sys[0]
            idle = now_sys[1] - prev_sys[1]
            steal = now_sys[2] - prev_sys[2]
            if total > 0:
                sys_cpu_pct = 100.0 * (total - idle) / total
                sys_steal_pct = 100.0 * steal / total
        prev_sys = now_sys

        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        line = (
            f"{ts},{len(cur)},{cpu_pct:.1f},{cpu_ms:.0f},{tot_rss:.0f},"
            f"{sys_cpu_pct:.1f},{sys_steal_pct:.1f},{os.cpu_count()}\n"
        )
        print(
            f"[metrics] {ts} procs={len(cur)} cpu={cpu_pct:.1f}%/1Kern ({cpu_ms:.0f} ms/{a.interval:g}s) "
            f"rss={tot_rss:.0f} MB sys={sys_cpu_pct:.1f}% steal={sys_steal_pct:.1f}%",
            flush=True,
        )
        try:
            with open(a.csv, "a") as f:
                f.write(line)
        except OSError as e:
            print(f"[metrics] CSV-Schreibfehler: {e}", flush=True)


if __name__ == "__main__":
    main()
