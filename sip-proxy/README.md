# sip-proxy — OpenSIPS mit Cloud-Fallback

Rolle: nimmt den Anruf vom Carrier an (nur von erlaubten IPs), leitet ihn **erst lokal** an den
`media-node` und bei `408`/`5xx` automatisch an die **LiveKit Cloud**.

## Datei

`opensips.cfg` → `/etc/opensips/opensips.cfg`. Platzhalter ersetzen:

| Platzhalter | Bedeutung |
|---|---|
| `<CARRIER_IP_1/2>` | Quell-IPs des Carriers (Allow-List, beide Stellen: OPTIONS + INVITE) |
| `<MEDIA_NODE_IP>` | IP des SFU/Bridge-Rechners (prio1) |
| `<CLOUD_SIP_HOST>` | `<random>.sip.livekit.cloud` (Dashboard → Telephony) |
| `<CLOUD_EDGE_IP>` | aufgelöste IP dieses Hosts (`dig +short <CLOUD_SIP_HOST>`) |
| `<DB_PASS>` | Passwort des lokalen OpenSIPS-MySQL-Users |

## Deploy / Änderungen

```bash
cp opensips.cfg /etc/opensips/opensips.cfg            # vorher Backup der alten Datei!
opensips -C -f /etc/opensips/opensips.cfg             # Syntaxpruefung, muss 0 liefern
systemctl restart opensips && systemctl is-active opensips
```

Für eine **laufende** Installation die Fallback-Zeile setzen (Backup + Syntaxprüfung + Neustart
macht das Skript selbst):

```bash
fallback-tools/fix_cloud_destination.py --host <CLOUD_SIP_HOST> --ip <CLOUD_EDGE_IP>
```

## Logs / Diagnose

```bash
journalctl -u opensips -f | grep -a "INVITE\|Fallback\|REJECT"     # -a wegen Binaerzeichen
journalctl -u opensips --since "1 hour ago" | grep -a "Fallback Cloud"
```

Erwartete Zeilen im Normalbetrieb: `INVITE <von> -> <nummer> von <carrier-ip> | prio1 lokale SFU`.
Beim Ausfall: `lokale SFU antwortet 503 -> Fallback Cloud fuer <nummer>` — und **danach muss ein
INVITE an den Cloud-Host rausgehen** (mit `tcpdump` prüfen, siehe `docs/FALLBACK.md`).

## Wichtige Eigenschaft der Allow-List

Der Proxy weist **alles** ab, was nicht in der Allow-List steht — auch deine eigenen Testanrufe
(`403 Forbidden`). Für Tests die eigene IP temporär ergänzen (an **beiden** Stellen im Config-File)
und danach wieder entfernen. Genau dafür ist `<TEST_IP>` im Kommentar der Config vorgesehen.

## Fallstrick (teuer gelernt)

Nur `$du` auf den Cloud-Host zu setzen reicht **nicht**: OpenSIPS bricht die Branch dann still ab
(`tm:update_uac_dst: no valid destination found`), der Anrufer bekommt nur `503` und es geht kein
Paket zur Cloud. Korrekt ist `$ru = sip:<DID>@<CLOUD_SIP_HOST>` **und** `$du = sip:<CLOUD_EDGE_IP>:5060`.
