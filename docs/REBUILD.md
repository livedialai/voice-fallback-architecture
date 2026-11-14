# Nachbau — Schritt für Schritt

Ziel: eingehender Anruf → lokaler SFU mit Agent → automatischer Cloud-Fallback bei Ausfall →
Warmtransfer. Geschätzt: 1 Tag für einen erfahrenen Admin, wenn die Zugangsdaten da sind.

Platzhalter, die du ersetzen musst:

```
<SIP_PROXY_IP>       öffentliche IP des Proxy (Carrier zeigt hierher)
<MEDIA_NODE_IP>      IP des SFU/Bridge-Rechners
<WORKER_NODE_IP>     IP des Agent-Rechners (kann = media-node sein)
<TRANSFER_NODE_IP>   IP des Transfer-Controllers (kann = media-node sein)
<DID>                Telefonnummer des Kunden (mehrere Schreibweisen!)
<CARRIER_IP_1/2>     Quell-IPs deines Carriers (Trunk-Anbieter)
<CLOUD_SIP_HOST>     <random>.sip.livekit.cloud  (Dashboard → Telephony)
<CLOUD_EDGE_IP>      aufgelöste IP des Cloud-SIP-Hosts
<AGENT>              Name des Agenten (z. B. mein-agent)
<PREFIX>             Raum-Präfix der Dispatch-Rule (z. B. mein_)
```

---

## Schritt 1 — `media-node`: LiveKit SFU + SIP-Bridge

```bash
# LiveKit server + SIP bridge als Debian-Pakete/Binaries installieren (kein Selbstkompilieren nötig)
# Beide Dienste laufen als systemd-Units: livekit (SFU), livekit-sip (Bridge)

# Config SFU: media-node/livekit.yaml  → /etc/livekit/config.yaml
# Config Bridge: media-node/sip.yaml   → /etc/livekit/sip.yaml  (Pfad je nach Installation)

systemctl enable --now livekit livekit-sip
ss -ltnp | grep 7880            # SFU-API muss lauschen
```

Pflichtwerte in der SFU-Config: `port: 7880`, API-Key/Secret (identisch zum Worker),
Redis nur wenn du mehrere Knoten brauchst.
In der Bridge-Config: WS-URL des SFU (`ws://127.0.0.1:7880`), derselbe API-Key/Secret,
SIP-Port (`5070`), Trunk-Einstellungen für ausgehende Anrufe (Warmtransfer).

Prüfen: der Worker muss sich registrieren können (`registered worker` im Log).

## Schritt 2 — Cloud-Projekt vorbereiten

1. LiveKit-Cloud-Projekt anlegen, **API-Key + Secret** notieren.
2. Unter *Telephony* den **SIP-Host** ablesen: `<random>.sip.livekit.cloud` — **nicht** die Projekt-URL.
3. Dieselbe DID wie beim Carrier verwenden.

## Schritt 3 — `sip-proxy`: OpenSIPS

```bash
apt-get install -y opensips
cp sip-proxy/opensips.cfg /etc/opensips/opensips.cfg
# Anpassen: Carrier-IPs (Allow-List), <MEDIA_NODE_IP>, <CLOUD_SIP_HOST>, <CLOUD_EDGE_IP>
opensips -C -f /etc/opensips/opensips.cfg        # Syntaxprüfung (muss 0 sein)
systemctl restart opensips && systemctl is-active opensips
```

Allow-List nicht vergessen — **alles** außer den Carrier-IPs wird mit `403` abgewiesen
(auch deine eigenen Tests; siehe `PITFALLS.md`).

DNS-Auflösung des Cloud-Hosts testen: `dig +short <CLOUD_SIP_HOST>` muss IPs liefern.

## Schritt 4 — `worker-node`: Agent (zwei Container)

```bash
mkdir -p /opt/<agent> && cp -r worker/* /opt/<agent>/
cp worker/.env.example /root/worker-local.env     # LIVEKIT_URL = ws://<MEDIA_NODE_IP>:7880
cp worker/.env.example /root/worker-cloud.env     # LIVEKIT_URL = wss://<projekt>.livekit.cloud
# Je Datei: API-Key/Secret, LLM-, STT-, TTS-Keys, BACKEND_URL, TRANSFER_NUMBER, AGENT-Name
```

Starten (Container B **mit CA-Mount**, sonst Fehlerbild 3):

```bash
docker run -d --name <agent>-local --restart unless-stopped \
  --env-file /root/worker-local.env -v /opt/<agent>:/app -w /app \
  node:22-slim node agent.js start

docker run -d --name <agent>-cloud --restart unless-stopped \
  --env-file /root/worker-cloud.env -v /opt/<agent>:/app \
  -v /etc/ssl/certs:/etc/ssl/certs:ro -e NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
  -w /app node:22-slim node agent.js start
```

Prüfen: `docker logs <agent>-local | grep "registered worker"` (dauert ~10 s nach SFU-Start),
`docker logs <agent>-cloud | grep "registered worker"`.

## Schritt 5 — Cloud-Objekte (Trunk + Dispatch-Rule)

```bash
export LIVEKIT_URL=wss://<projekt>.livekit.cloud
export LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=…
export CLOUD_DIDS='+49…,0049…,49…,0…'         # alle Schreibweisen!
export CLOUD_ALLOWED='<SIP_PROXY_IP>/32,<CARRIER_IP_1>/32'
export CLOUD_AGENT=<AGENT> CLOUD_ROOM_PREFIX=<PREFIX>
python3 fallback-tools/create_cloud_sip.py apply     # idempotent
python3 fallback-tools/create_cloud_sip.py list      # Kontrolle
```

Kontrolle: `allowedAddresses` enthält die Proxy-IP, `roomConfig.agents` enthält `<AGENT>`.

## Schritt 6 — Warmtransfer

1. Transfer-Controller auf `transfer-node` installieren (HTTP `:9101`, Endpunkt `/v1/transfer`).
   Er baut ausgehende Anrufe über die SIP-Bridge des `media-node` auf und führt die Phasen
   (`RINGING` → `AI_BRIEFING` → `BRIDGING`).
2. Im Agenten die vier Einbaustellen umsetzen: `warm-transfer/integration.md`.
3. `briefing.mjs` kopieren, `LLM_*` / `CONTROLLER_URL` / `TRANSFER_NUMBER` setzen.
4. Trockentest: `node warm-transfer/test-briefing.mjs`.

## Schritt 7 — Abnahme (die vier Tests, in dieser Reihenfolge)

| Test | Vorgehen | Erwartung |
|---|---|---|
| Normalweg | SFU an, Anruf auf `<DID>` | Agent antwortet; **kein** Cloud-Paket im Mitschnitt |
| Fallback | auf `media-node`: `systemctl stop livekit`, dann Anruf | Proxy-Log „→ Fallback Cloud"; INVITE zum Cloud-Edge; 200 OK; Cloud-Worker-Log zeigt Job + Agent spricht |
| Rückweg | `systemctl start livekit`, ~10 s warten, Anruf | wieder lokal, **kein** Cloud-Paket |
| Warmtransfer | Anruf, „bitte verbinden" | Wartemusik → Ziel klingelt → Briefing hörbar → Ziel antwortet → **dann** Durchstellen |

Beweismittel: Paketmitschnitt (`tcpdump`), Proxy-Log, beide Worker-Logs, Cloud-Raumliste
(`fallback-tools/list_cloud_rooms.py`). Ohne diese Belege gilt der Test als **nicht** bestanden.

## Schritt 8 — Betrieb

- Nach jeder Config-Änderung: Backup, Syntaxprüfung, Neustart, **ein** Testanruf, Mitschnitt prüfen.
- Wartungsfenster: SFU aus → Anrufe laufen über die Cloud; SFU an → sofort wieder lokal (spart Cloud-Kosten).
- Logs immer binär-sicher lesen: `grep -a` (Bridge-Logs enthalten Steuerzeichen).
- Rollback: Backup-Datei zurückkopieren, Dienst neu starten. Keine Hot-Patches an laufender Funktionalität.
