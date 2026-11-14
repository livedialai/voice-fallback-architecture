# Stolperfallen (gesammelt, alle real erlebt)

## SIP / Proxy

| Problem | Ursache | Lösung |
|---|---|---|
| Fallback-Log erscheint, aber **kein Paket** verlässt den Proxy; Anrufer bekommt nur `503` | in der `failure_route` nur `$du` auf den Hostnamen gesetzt → OpenSIPS bricht die Branch still ab (`tm:update_uac_dst: no valid destination found`) | **`$ru` (Cloud-Host) *und* `$du` (Cloud-Edge-IP) setzen** |
| Testanruf vom eigenen Rechner → `403 Forbidden` | Allow-List lässt nur Carrier-IPs durch | für Tests die Test-IP temporär in die Allow-List (beide Stellen: OPTIONS + INVITE) und danach zurücknehmen |
| Mehrere Schreibweisen der Nummer führen zu `404 No trunk found` | Carrier liefert `+49…`, `0049…`, `49…` oder `0…` | DID in **allen** Formaten in den Trunk (`numbers`) |
| Cloud antwortet gar nicht bei Test mit reiner IP im R-URI | Cloud braucht den SIP-Host im R-URI, um das Projekt zu finden | R-URI-Host = `<random>.sip.livekit.cloud`, Versand an die Edge-IP |
| Failover greift nicht bei „Busy" | `failure_route` prüft nur `408|5xx` | bewusst so; `486/480` als weitere Bedingung aufnehmen, wenn gewünscht |
| `/etc/hosts`-Eintrag hilft nicht | OpenSIPS nutzt seinen eigenen Resolver (DNS), nicht die Hosts-Datei | DNS-Auflösung des Cloud-Hosts sicherstellen (`dig +short`) |
| Bridge-Logs „leer", obwohl Traffic da ist | Log enthält Binärzeichen | `grep -a` benutzen |

## Worker / Agent

| Problem | Ursache | Lösung |
|---|---|---|
| Container startet, nimmt aber keinen Job an: `ConnectError: no native root CA certificates found` | TLS zu LiveKit Cloud ohne Root-CAs im Container | `/etc/ssl/certs:/etc/ssl/certs:ro` mounten + `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` |
| Anruf klingelt dauerhaft, niemand spricht | Dispatch-Rule ohne `roomConfig.agents` → kein Worker-Dispatch | `roomConfig.agents = [{ agentName: <AGENT> }]` |
| Job kommt an, aber falscher Worker/kein Worker | `LIVEKIT_AGENT_NAME` ≠ `agentName` der Rule | Namen identisch halten |
| Agent startet nach SFU-Neustart nicht sofort | Worker-Registrierung braucht ~10 s | Reihenfolge: erst SFU, dann 10 s warten, dann testen |
| Leerer LLM-Text, `finish_reason: length` | Reasoning-Modell ohne Schalter | `thinking: { type: 'disabled' }` mitsenden |
| Agent „denkt" hörbar lange | Reasoning im Sprach-Agenten | Reasoning abschalten, Modellwechsel per **einem** Befehl (`worker/scripts/switch_llm.sh`) |

## Warmtransfer

| Problem | Ursache | Lösung |
|---|---|---|
| Briefing wird nie gehört, Anrufer hört Stille | `session.generateReply()` beendet den Turn | `session.say(text, { allowInterruptions: false, addToChatCtx: true })` + `waitForPlayout()` |
| Durchstellen passiert sofort nach dem Klingeln | LLM ruft das Tool zu früh | harte Sperre im Tool bis `briefing_fertig === true` |
| Briefing kommt 2–3 s zu spät | LLM-Call erst nach dem Transferaufbau | LLM-Call **parallel** zum Transfer starten, später awaiten |
| LLM liefert nichts Brauchbares | Timeout/Fehler | deterministische Ansage als Fallback (Code spricht selbst) |

## Betrieb / Vorgehen

- **Nie** an Funktionierendem patchen (z. B. Warmtransfer), nur weil man es „aufräumen" will.
- **Ein** Schritt → **eine** Messung. Vor jeder Änderung Backup, danach Syntaxprüfung + Neustart + Testanruf.
- Erst **melden, wenn gemessen**: Paketmitschnitt + beide Worker-Logs + Cloud-Raumliste.
- Test immer aus der **Zielumgebung** (echter Anruf von außen), nicht „direkt am Server".
- Kostenneutral heißt: lokaler SFU, **kein** Cloud-Job im Cloud-Worker-Log. Immer nachprüfen.
- Der Proxy hängt per **SIP-Registrierung** am Anbieter (Auffrischung alle **300 s**). Nach einem
  Maschinenwechsel dauert es bis zu 5 Minuten, bis Anrufe wieder ankommen — das ist kein Fehler.
- Zugangsdaten (API-Keys, Redis-Passwort, SIP-Secrets) **nie** in Doku oder Repo — nur in
  `.env`-Dateien auf den Maschinen; Beispielwerte leer lassen.
