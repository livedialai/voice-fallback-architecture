#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Lastmessung fuer den Node-Cascade-Worker: CPU% und RSS der Worker-Prozesse.

Liest direkt /proc (keine Zusatzpakete). Sinnvoll WAEHREND eines echten Anrufs:
so sieht man, was ein Call wirklich an CPU/RAM zieht, und kann die parallele
Kapazitaet der Kiste hochrechnen (Calls = Kerne / CPU-Anteil-pro-Call).

Aufruf:
    python3 scripts/load_probe.py --seconds 30
    python3 scripts/load_probe.py --seconds 30 --pattern agent.js --interval 1
"""
import argparse
import os
import time


def cpu_times():
    v = [int(x) for x in open("/proc/stat").readline().split()[1:]]
    idle = v[3] + (v[4] if len(v) > 4 else 0)
    return sum(v), idle


def procs(pattern):
    """PIDs + RSS (Seiten) + utime+stime (Ticks) aller passenden Prozesse."""
    aus = {}
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode("utf-8", "replace")
            if pattern not in cmd:
                continue
            stat = open(f"/proc/{pid}/stat").read()
            felder = stat.rsplit(")", 1)[1].split()
            utime, stime = int(felder[11]), int(felder[12])
            rss = int(felder[21]) * (os.sysconf("SC_PAGE_SIZE") // 1024)  # MB
            aus[pid] = (rss, utime + stime)
        except (OSError, IndexError, ValueError):
            continue
    return aus


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=30)
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--pattern", default="agent.js")
    args = ap.parse_args()

    hz = os.sysconf("SC_CLK_TCK")
    kerne = os.cpu_count() or 1

    t0, i0 = cpu_times()
    prev = procs(args.pattern)
    if not prev:
        print(f"KEIN Prozess mit Muster '{args.pattern}' gefunden - laeuft der Worker?")
        return

    cpu_spitzen, rss_werte, sys_werte = [], [], []
    n = max(1, int(args.seconds / args.interval))
    for _ in range(n):
        time.sleep(args.interval)
        t1, i1 = cpu_times()
        dt = t1 - t0
        sys_cpu = 100.0 * (1 - (i1 - i0) / dt) if dt > 0 else 0.0
        t0, i0 = t1, i1

        jetzt = procs(args.pattern)
        job_pid = max(jetzt, key=lambda p: jetzt[p][1] - prev.get(p, (0, 0))[1], default=None)
        cpu_job = 0.0
        for pid, (rss, ticks) in jetzt.items():
            alt = prev.get(pid)
            if alt:
                cpu_job = max(cpu_job, 100.0 * (ticks - alt[1]) / (hz * args.interval))
        prev = jetzt

        rss_sum = sum(v[0] for v in jetzt.values())
        cpu_spitzen.append(cpu_job)
        rss_werte.append(rss_sum)
        sys_werte.append(sys_cpu)
        print(f"  t={len(cpu_spitzen):3d}s  Job-CPU={cpu_job:5.1f}%  RSS(alle)={rss_sum:5d} MB  Prozesse={len(jetzt)}  System-CPU={sys_cpu:4.1f}%")

    cpu_max = max(cpu_spitzen)
    print("\n--- Ergebnis ---")
    print(f"Kerne:                    {kerne}")
    print(f"CPU pro Call (max):       {cpu_max:.1f}% von 1 Kern")
    print(f"RSS gesamt (max):         {max(rss_werte)} MB")
    print(f"System-CPU (avg):         {sum(sys_werte)/len(sys_werte):.1f}%")
    if cpu_max > 0:
        print(f"-> parallele Calls/Kiste: ~{kerne / (cpu_max / 100.0):.0f} (CPU-limitiert)")


if __name__ == "__main__":
    main()
