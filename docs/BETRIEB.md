# Betrieb: Grenzen des Konzepts und akzeptiertes Risiko

Bewusst ungeschminkt. Wer das Konzept bewertet, findet hier die Schwachstellen — und für die
wichtigste die getroffene Entscheidung.

## 1. Grenzen (Stand 14.11.2026)

| # | Grenze | Wirkung | Gegenmittel (nicht eingebaut) |
|---|---|---|---|
| 1 | Fallback greift nur bei `408`/`5xx` | Antwortet der `media-node` mit `200 OK`, aber Bridge oder Agent fehlt, hört der Anrufer Stille — kein Fallback | Vorab-Prüfung (Canary-Anruf alle N Minuten, Agent-Registrierung prüfen) vor dem Annehmen |
| 2 | Keine Rücknahme-/Rückprüfung | Während eines Ausfalls zahlt jeder Anruf erst den lokalen Timeout; nach der Rückkehr testet niemand automatisch | Circuit-Breaker + Wiedereinschalt-Test |
| 3 | Cloud-Edge-IP im Ziel fest verdrahtet | Ändert der Anbieter die Edge-IP, fällt der Fallback genau im Ausfall aus | Ziel zur Laufzeit auflösen (DNS), nicht pinnen |
| 4 | Kein Alarm | Wer den Fallback nutzt, sieht man nur im Raum-Log | Schwellwert-Meldung (z. B. „mehr als 1 Fallback/Tag") |
| 5 | `sip-proxy` ist Single Point | Stirbt er, hat der Carrier kein Ziel mehr | akzeptiert — siehe Abschnitt 2 |
| 6 | Keine belastbare Kapazitätszahl | „0,5 vCPU / 250 MB je Anruf" ist Annahme, nicht gemessen | Lasttest mit N gleichzeitigen Anrufen und Audioqualität messen |

## 2. Akzeptiertes Risiko: `sip-proxy` als Single Point

**Entscheidung des Betreibers (14.11.2026):** Der Proxy ist bewusst der Single Point of Failure —
akzeptiert, weil er praktisch nicht wartungsbedürftig und in Minuten ersetzbar ist.

Warum das trägt:
- 72 Zeilen Konfiguration, ein Dienst (`opensips`), sonst nichts auf der Maschine.
- Kein Anrufzustand: die lokale Datenbank dient nur der Modulkonfiguration (`uac_registrant`),
  nicht dem Gespräch.
- Läuft im Normalbetrieb monatelang unbeobachtet; ein Ausfall wäre ein Konfigurations- oder
  Maschinenproblem, kein Lastproblem.
- Anbindung per SIP-Registrierung (alle 300 s erneuert), **kein fest verdrahtetes Adressziel beim
  Anbieter** — und keine Benutzerverwaltung mit Personen, nur die Anschluss-Zugänge in der kleinen
  lokalen Datenbank. Damit ist der Ersatz unabhängig von der IP.

Ersatz, in dieser Reihenfolge:

1. **Snapshot zurückrollen** (VM/Container) → Konfiguration **und** die kleine lokale Datenbank sind
   wieder da, der Dienst registriert sich selbst. Vorteil: sonst nichts zu tun.
2. **Vorgehaltener VPS**: Konfiguration + Datenbank einspielen, Dienst starten. **Eine andere IP ist
   kein Hindernis** — der Proxy meldet sich beim Anbieter per Registrierung an (`uac_registrant`,
   Auffrischung alle 300 s), das Anrufziel folgt dem Registrierungs-Contact. Es müssen **keine
   Zugänge neu beantragt werden**: die Zugänge der Anschlüsse liegen in der Datenbank und wandern mit.
3. **Notfallweg ohne Proxy**: die DID beim Anbieter direkt auf `<CLOUD_SIP_HOST>` zeigen lassen.
   Die Anrufe landen dann direkt im Cloud-Fallback; der Cloud-Trunk erlaubt die Carrier-IPs bereits.

Dadurch bleibt das Ausfallfenster auf die Umschaltzeit begrenzt (Snapshot-Restore bzw. Reaktion des
Carriers). Bewusst **kein** Keepalived/HA-Doppel: Aufwand und Fehlerfläche stünden in keinem
Verhältnis zur Ausfallwahrscheinlichkeit.

### Prüfliste nach einem Ersatz (bei anderer IP)

- **Anbieter:** nichts zu tun — das Anrufziel folgt der Registrierung (bis 300 s Wartezeit).
- **Ersatzmaschine:** eigene Adresse in den Allow-Listen des Konfigfiles (eingehende Quellen, `OPTIONS`).
- **Cloud:** neue Adresse in der Erlaubnisliste des Inbound-Trunks (`fallback-tools/create_cloud_sip.py`).
- **Registrierung prüfen:** Log des Dienstes — „registriert" bzw. Fehlschlag wird dort ausgegeben.
- **Gegenprobe:** `bash fallback-tools/failover_test.sh` — erwartet: Anruf wird lokal angenommen;
  `media-node` kurz stoppen → **derselbe** Anruf läuft über die Cloud (`200 OK`).

## 3. Warum die Grenzen aus Abschnitt 1 vertretbar sind

Punkt 1 (Agent fehlt trotz `200 OK`) bleibt die einzige Lücke mit Kundenwirkung. Alle übrigen sind
Betriebs- oder Messpunkte, keine Konzeptfehler: Das Grundmuster „erst lokal, bei Ausfall in die
Cloud, derselbe Anruf" ist deterministisch, kostenneutral im Normalbetrieb und mit einem einzigen
Anruf überprüfbar.

