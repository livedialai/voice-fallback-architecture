# Belege (Rohauszüge)

Originalauszüge aus Logs und Antworten der laufenden Anlage. Sie zeigen, **wie** der Beweis aussieht,
den man für "Fallback funktioniert" führen muss.

| Datei | Was sie zeigt |
|---|---|
| `cloud_fallback_200OK.txt` | Testanruf über die Cloud: `100 → 180 → 200 OK`, Track-ID, Agent-Opener |
| `cloud_fallback_vorher_404.txt` | Fehlerbild **vor** dem Fix: `404 Not found` (falscher SIP-Host im Trunk) |
| `cloud_worker_err.txt` | Worker scheitert am Connect (kein CA-Zertifikat im Container) |
| `cloud_worker_CA_fehler.txt` | derselbe Fehler im Container-Log |
| `e2e_anruf.txt` | Ende-zu-Ende-Anruf: Klingeln, Annahme, Raum, Agent-Job |

**Hinweis zur Lesbarkeit:** Bezeichner (Agent-Name, Raum-Präfix) sind in diesen Auszügen auf die
neutralen Muster `voice-agent` / `tenant_` umgestellt. **Messwerte sind unverändert**: SIP-Codes,
Zeitstempel, Track-/Job-/Raum-IDs, Fehlertexte.

Die konkreten Zeichenketten der laufenden Instanz stehen bewusst nur in den Code-Dateien
(`../worker/.env.example`, `../worker/deploy/*.service`).
