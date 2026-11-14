# fallback-tools — Werkzeuge zum Bauen, Testen und Beweisen

| Skript | Zweck | läuft auf |
|---|---|---|
| `create_cloud_sip.py` | Inbound-Trunk + Dispatch-Rule in der LiveKit Cloud anlegen/angleichen (idempotent) | beliebig (braucht API-Key) |
| `test_sip_call.py` | SIP-Testanruf (UDP), zeigt alle Statuscodes + BYE | erlaubter Host |
| `failover_test.sh` | Beweis: mitschneiden + Testanruf → wohin ging der Anruf? | `sip-proxy` |
| `fix_cloud_destination.py` | Fallback-Zeile (`$ru`/`$du`) in laufender OpenSIPS-Config setzen (Backup + Syntaxcheck + Neustart) | `sip-proxy` |
| `start_worker_cloud.sh` | Cloud-Worker-Container **mit CA-Mount** starten | `worker-node` |
| `list_cloud_rooms.py` | Räume + Teilnehmer der Cloud: wer war im Anruf (SIP + Agent)? | beliebig (braucht API-Key) |

## Konfiguration

Alle Skripte lesen ihre Werte aus Umgebungsvariablen. Beispiel:

```bash
export LIVEKIT_URL="wss://<projekt>.livekit.cloud"
export LIVEKIT_API_KEY="<KEY>"
export LIVEKIT_API_SECRET="<SECRET>"
export CLOUD_DIDS="004947195464009,4947195464009"
export CLOUD_ALLOWED="<SIP_PROXY_IP>/32,<CARRIER_IP>/32"
export CLOUD_AGENT="voice-agent"
export CLOUD_ROOM_PREFIX="tenant_"
```

Oder alles in eine env-Datei schreiben und `CLOUD_ENV=/pfad/dazu.env` setzen.

## Typischer Ablauf

```bash
# 1) Cloud-Objekte prüfen / anlegen
./create_cloud_sip.py list
./create_cloud_sip.py apply

# 2) Normalbetrieb: nimmt der lokale Weg an?
SIP_TARGET=127.0.0.1:5070 SIP_HOST=127.0.0.1 DID=004947195464009 ./test_sip_call.py

# 3) Ausfall simulieren (auf dem media-node):
systemctl stop livekit

# 4) Beweis führen (auf dem sip-proxy):
DID=004947195464009 CLOUD_HOST=<CLOUD_SIP_HOST> ./failover_test.sh

# 5) Ergebnis: Raum + Teilnehmer in der Cloud
./list_cloud_rooms.py 5

# 6) Rückweg: lokale SFU wieder starten und Gegenprobe
systemctl start livekit
DID=004947195464009 CLOUD_HOST=<CLOUD_SIP_HOST> ./failover_test.sh   # Erwartung: 0 Pakete zur Cloud
```

Belege einer echten Prüfung: `evidence/`.
