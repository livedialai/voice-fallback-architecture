# Rollen → konkrete Werte einer laufenden Installation

Die Doku benutzt nur Rollennamen. Diese Tabelle ist die Übersetzung für die **laufende** Instanz
(Stand 14.11.2026). Für einen Nachbau ersetzt du die Werte durch deine eigenen.

Die Bezeichner `voice-agent` (Agent-Name) und `tenant_` (Raum-Präfix) sind neutrale Muster.
Die konkreten Zeichenketten der eigenen Instanz sind frei wählbar und stehen in den Code-Dateien
(`worker/.env.example`, `worker/deploy/*.service`) — wichtig: **Worker und Cloud-Dispatch-Rule
müssen denselben Namen benutzen**, sonst klingelt es nur und kein Agent spricht.

## Maschinen

| Rolle | Adresse | Dienst | Anmerkung |
|---|---|---|---|
| `carrier` | `188.246.0.82`, `193.31.27.79` | SIP-Trunk (sipload) | liefert die DID an den Proxy |
| `sip-proxy` | `212.87.214.201` | OpenSIPS, `udp/5070` | Zugang nur per SSH-Key `id_ed25519_pizzafamily` |
| `media-node` | `45.131.109.251` | LiveKit SFU 1.13.6 + `livekit-sip` | `tcp/7880` API, `udp/5070` SIP-IN, `udp/7882` ICE |
| `worker-node` | `46.165.215.154` | Docker, Container `node-cascade-local` + `node-cascade` | Agent `voice-agent` |
| `transfer-node` | `78.159.111.149:9101` | Transfer-Controller | `POST /v1/transfer` |

## Nummer und Cloud

| Wert | Inhalt |
|---|---|
| DID (Beispiel) | `047195464009` |
| DID-Schreibweisen | `+4947…`, `004947195464009`, `4947195464009`, `047195464009` |
| Cloud-Projekt | `tenant-3c7vpm7p` (URL) |
| **Cloud-SIP-Host** | `5beqaaytte8.sip.livekit.cloud` (≠ Projekt-URL!) |
| Cloud-Edge-IPs | `161.115.161.120` (verifiziert), laut DNS auch `161.115.183.249/.252` |
| Raum-Präfix | `tenant_` |

## Cloud-Objekte (SIP)

| Objekt | ID | Inhalt |
|---|---|---|
| Inbound-Trunk | `ST_UHhA23tSULKM` | `numbers: []` (= alle Nummern), `allowedAddresses`: die sechs `/32`-Einträge oben |
| Dispatch-Rule | `SDR_GLVzYnJmi6R9` | `dispatchRuleIndividual`, `roomPrefix: tenant_`, `trunkIds: [ST_UHhA23tSULKM]`, `roomConfig.agents: [{agent_name: "voice-agent"}]` |

> Historie: Vorher existierten Objekte mit falscher/fehlender Agent-Bindung (`roomConfig.agents` fehlte)
> — Folge: Freizeichen ohne Agent. Ein früherer Trunk hieß `ST_kLHCSny3gSRj`, eine frühere Rule
> `SDR_wBd82kh2W7JP`-Familie; maßgeblich ist **immer** der Stand aus `create_cloud_sip.py list`.

## Umgebungen auf dem `worker-node`

| Datei | Zweck |
|---|---|
| `/root/worker-local.env` | `LIVEKIT_URL=ws://45.131.109.251:7880` (lokaler SFU) |
| `/root/worker-cloud.env` | `LIVEKIT_URL=wss://tenant-3c7vpm7p.livekit.cloud` (Fallback) |

Beide enthalten dieselben LLM-/STT-/TTS-Keys und `LIVEKIT_AGENT_NAME=voice-agent`.

## Prüf-Kommandos (laufende Instanz)

```bash
# Proxy: Fallback-Ereignisse der letzten Stunde
journalctl -u opensips --since "1 hour ago" | grep -a "Fallback Cloud"

# Proxy: Config
grep -n -A6 'failure_route\[sfu_down\]' /etc/opensips/opensips.cfg

# Media-Node: SFU-Zustand
systemctl is-active livekit livekit-sip; ss -ltnp | grep 7880

# Worker-Node: welcher Weg wurde benutzt?
docker logs --since 10m node-cascade-local 2>&1 | grep -a "received job request"
docker logs --since 10m node-cascade      2>&1 | grep -a "received job request"
```
