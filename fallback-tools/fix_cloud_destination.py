#!/usr/bin/env python3
"""Setzt in einer OpenSIPS-Config die Cloud-Fallback-Zeile korrekt ($ru + $du) und startet neu.

Hintergrund: Steht im failure_route nur "$du = sip:<nummer>@<cloud-host>", bricht OpenSIPS die
Branch still ab ("tm:update_uac_dst: no valid destination found") — der Anrufer bekommt nur 503 und
es geht KEIN Paket zur Cloud. Korrekt ist: $ru = Cloud-Host (Projekt-Zuordnung) UND
$du = Cloud-Edge-IP (Versand).

Aufruf:
  fix_cloud_destination.py --host <cloud-sip-host> --ip <cloud-edge-ip> [--cfg /etc/opensips/opensips.cfg]
                           [--no-restart]
"""
import argparse, datetime, os, re, shutil, subprocess, sys

ap = argparse.ArgumentParser()
ap.add_argument('--host', required=True, help='z. B. ab12cd.sip.livekit.cloud')
ap.add_argument('--ip', required=True, help='Edge-IP des Cloud-SIP-Hosts')
ap.add_argument('--cfg', default='/etc/opensips/opensips.cfg')
ap.add_argument('--no-restart', action='store_true')
args = ap.parse_args()

src = open(args.cfg).read()
backup = '%s.bak-%s' % (args.cfg, datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))

new_ru = '        $ru = "sip:" + $rU + "@%s";' % args.host
new_du = '        $du = "sip:%s:5060";' % args.ip

# 1) vorhandene Zeilen im failure_route[sfu_down]-Block ersetzen
block_re = re.compile(r'(failure_route\[sfu_down\]\s*\{.*?\n\})', re.S)
m = block_re.search(src)
if not m:
    sys.exit('failure_route[sfu_down] nicht gefunden in %s' % args.cfg)
block = m.group(1)

replaced_ru = re.sub(r'\s*\$ru\s*=\s*"[^"]*";', '\n' + new_ru, block, count=1)
if not re.search(r'\$ru\s*=', block):
    replaced_ru = replaced_ru.replace('failure_route[sfu_down] {', 'failure_route[sfu_down] {', 1)
    replaced_ru = re.sub(r'(\{\s*\n)', r'\1' + new_ru + '\n', replaced_ru, count=1)
replaced = re.sub(r'\s*\$du\s*=\s*"[^"]*";', '\n' + new_du, replaced_ru, count=1)
if not re.search(r'\$du\s*=', block):
    replaced = re.sub(r'(\$ru\s*=\s*"[^"]*";\n)', r'\1' + new_du + '\n', replaced, count=1)

if replaced == block:
    print('keine Aenderung noetig')
else:
    shutil.copy2(args.cfg, backup)
    open(args.cfg, 'w').write(src.replace(block, replaced))
    print('Backup:', backup)
    print('neu   :', new_ru.strip())
    print('neu   :', new_du.strip())

chk = subprocess.run(['opensips', '-C', '-f', args.cfg], capture_output=True, text=True)
print('Syntaxpruefung exit =', chk.returncode)
if chk.returncode != 0:
    print(chk.stdout[-400:], chk.stderr[-400:])
    print('ACHTUNG: Config nicht uebernommen — Backup zurueckspielen:', backup)
    sys.exit(1)

if not args.no_restart:
    subprocess.run(['systemctl', 'restart', 'opensips'])
    print('opensips:', subprocess.run(['systemctl', 'is-active', 'opensips'],
                                      capture_output=True, text=True).stdout.strip())
