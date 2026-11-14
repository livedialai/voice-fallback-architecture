# media-node — LiveKit SFU + SIP-Bridge

Rolle: nimmt den SIP-Anruf vom `sip-proxy` an und macht daraus einen Raum, in dem der Agent sitzt.
Fällt dieser Dienst aus, springt der Cloud-Fallback ein (`docs/FALLBACK.md`).

## Bestandteile

| Dienst | Aufgabe | Port |
|---|---|---|
| `livekit` | SFU: Räume, WebRTC, Signaling | `tcp/7880` (API/WS), `udp/7881` (TCP-ICE), `udp/7882` (UDP-ICE) |
| `livekit-sip` | SIP-Bridge: SIP ↔ Raum | `udp/5070` (SIP-Eingang) |
| `redis` | SFU-State (bei Einzelknoten optional, von der Bridge aber genutzt) | `127.0.0.1:6379` |

## Dateien

| Datei | Ziel | Inhalt |
|---|---|---|
| `livekit.yaml` | `/etc/livekit/config.yaml` | Vorlage der SFU-Config (Keys, Ports, Redis) |
| `sip.yaml` | Bridge-Config (Pfad je nach Installation) | Vorlage der Bridge-Config (API-Key, WS-URL, SIP-Port) |

Vorlagen enthalten `<>`-Platzhalter — vor dem Deploy ersetzen. Beide brauchen **denselben**
API-Key/Secret wie die Worker-Container.

## Betrieb

```bash
systemctl enable --now livekit livekit-sip
systemctl is-active livekit livekit-sip     # beide "active"
ss -ltnp | grep 7880                        # SFU-API lauscht
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7880   # -> 200

# Ausfall simulieren (Fallback-Test):
systemctl stop livekit      # Anrufe laufen ab jetzt über die Cloud
systemctl start livekit     # ~5 s bis Port 7880 antwortet, ~10 s bis der lokale Worker registriert ist
```

## Anmerkungen

- `use_external_ip: true` bzw. `external_ip: "<MEDIA_NODE_IP>"` setzen, sonst scheitert der Medienstrom
  hinter NAT/Cloud (der Anruf wird angenommen, aber man hört nichts).
- Kein Selbstkompilieren nötig — es gibt fertige Pakete/Binaries für Server und SIP-Bridge
  (`docs/REBUILD.md`, Schritt 1).
- LiveKit-Version der laufenden Instanz: siehe `docs/ROLLEN.md`.
