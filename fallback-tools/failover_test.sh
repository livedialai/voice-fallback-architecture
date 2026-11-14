#!/bin/bash
# Beweist den Cloud-Fallback: mitschneiden, Testanruf auslösen, Belege ausgeben.
#
# Läuft auf dem sip-proxy (oder einem Host, der in der Proxy-Allow-List steht).
# Vorher: lokalen SFU ausmachen (media-node):  systemctl stop livekit
#
# Umgebung:
#   DID            angerufene Nummer, in Carrier-Schreibweise (z. B. 004947195464009)
#   CLOUD_HOST     <random>.sip.livekit.cloud        (Ziel im R-URI)
#   SIP_TARGET     Ziel des Testanrufs, Default 127.0.0.1:5070
#   CALLER         eigene Nummer, Default 015112345678
#   DUMP           Mitschnittdatei, Default /tmp/failover_tcp.txt
#   WAIT           Wartezeit für die Antworten, Default 45
set -u
DID=${DID:?DID setzen}
CLOUD_HOST=${CLOUD_HOST:?CLOUD_HOST setzen}
SIP_TARGET=${SIP_TARGET:-127.0.0.1:5070}
CALLER=${CALLER:-015112345678}
DUMP=${DUMP:-/tmp/failover_tcp.txt}
WAIT=${WAIT:-45}

HERE=$(cd "$(dirname "$0")" && pwd)
rm -f "$DUMP"
echo "== Anruf auslösen (Ziel $SIP_TARGET, DID $DID)"
timeout $((WAIT + 20)) tcpdump -n -i any -A -s0 'udp port 5060 or udp port 5070' > "$DUMP" 2>/dev/null &
DUMPPID=$!
sleep 2
SIP_TARGET="$SIP_TARGET" CALLER="$CALLER" WAIT="$WAIT" python3 "$HERE/test_sip_call.py" "$DID" | sed 's/^/   /'
sleep 2
kill $DUMPPID 2>/dev/null

echo
echo "== Geht der Fallback-Anruf zur Cloud?"
awk -v h="$CLOUD_HOST" '/^INVITE sip:/ {print "   " $2}' "$DUMP" | sort -u | sed 's/^/   /'
if grep -aq "INVITE sip:.*@$CLOUD_HOST" "$DUMP"; then
  echo "   => R-URI zeigt auf $CLOUD_HOST  (OK)"
else
  echo "   => KEIN INVITE Richtung $CLOUD_HOST gefunden  (Fallback hat nicht ausgelöst!)"
fi

echo
echo "== Antworten der Cloud / des Proxys"
grep -aoE 'SIP/2\.0 [0-9]{3}[^\r]*' "$DUMP" | sort -u | sed 's/^/   /'

echo
echo "== Proxy-Log (Fallback-Ereignisse, 10 min)"
journalctl -u opensips --since "10 min ago" --no-pager 2>/dev/null \\
  | grep -a "Fallback Cloud\\|all_down\\|no valid destination" | tail -5 | sed 's/^/   /'
echo
echo "Fertig. Belege: $DUMP"
