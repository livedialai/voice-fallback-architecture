# worker — Sprach-Agent (Node.js, `@livekit/agents`)

Rolle: tritt dem Raum bei, spricht den Opener, führt das Gespräch (LLM/STT/TTS) und baut bei Bedarf
den Warmtransfer auf. **Derselbe Code läuft zweimal** — einmal gegen den lokalen SFU, einmal gegen
die LiveKit Cloud (Fallback).

## Dateien

| Datei | Inhalt |
|---|---|
| `agent.js` | Agent: Session, Tools (u. a. `verbinden`, `durchstellen`), Opener-WAV, Transfer-Anbindung |
| `system_prompt.txt` | System-Prompt des Agenten (Wortlaut ist Teil des Produkts!) |
| `.env.example` | alle nötigen Umgebungsvariablen (Werte leer) |
| `deploy/*.service` | systemd-Units (Alternative zum Container-Betrieb) |
| `scripts/switch_llm.sh` | Modellwechsel mit **einem** Befehl (kein Konfig-Basteln) |
| `scripts/make_opener_wav.py` | Opener als WAV vorproduzieren (deterministisch, ohne TTS im Anruf) |
| `scripts/worker_metrics.py`, `scripts/load_probe.py` | Betriebsmetriken / Lasttest |

## Zwei Container (Kern des Fallbacks)

```bash
# A) lokaler Betrieb
docker run -d --name <agent>-local --restart unless-stopped \
  --env-file /root/worker-local.env -v /opt/<agent>:/app -w /app \
  node:22-slim node agent.js start

# B) Cloud-Fallback — CA-Mount ist PFLICHT
docker run -d --name <agent>-cloud --restart unless-stopped \
  --env-file /root/worker-cloud.env -v /opt/<agent>:/app \
  -v /etc/ssl/certs:/etc/ssl/certs:ro -e NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
  -w /app node:22-slim node agent.js start
```

(fertiges Skript: `../fallback-tools/start_worker_cloud.sh`)

Unterschied der beiden env-Dateien:

| Variable | Container A (lokal) | Container B (Cloud) |
|---|---|---|
| `LIVEKIT_URL` | `ws://<MEDIA_NODE_IP>:7880` | `wss://<projekt>.livekit.cloud` |
| `LIVEKIT_AGENT_NAME` | `<AGENT>` | `<AGENT>` (identisch!) |

Alles andere (LLM/STT/TTS-Keys, Backend, `TRANSFER_NUMBER`) ist gleich.

## Prüfen

```bash
docker logs <agent>-local | grep -a "registered worker"     # Registrierung (nach SFU-Start ~10 s)
docker logs <agent>-cloud  | grep -a "registered worker"
docker logs --since 5m <agent>-cloud | grep -a "received job request"   # Job angenommen?
docker logs --since 5m <agent>-cloud | grep -a "Guten Tag"              # Opener gesprochen?
```

## Wichtige Eigenschaften

- **Sprach-Agent darf nicht „tief nachdenken":** Reasoning-Modelle abschalten
  (`thinking: {type:'disabled'}` bzw. `LLM_REASONING_EFFORT=none`), sonst steigt die Latenz und
  der Nutzer hört Pausen. Modellwechsel nur über `scripts/switch_llm.sh`.
- **Opener ist ein WAV**, keine TTS-Ausgabe im Anruf — der erste Satz muss deterministisch sein.
- **Ein Turn = ein Tool-Aufruf** und kurze Tool-Antworten: alles andere erzeugt Hörpausen.
- **Personenbezug/Wortlaut nicht ändern**, wenn die Anlage beim Kunden produktiv läuft — Prompts sind
  Vertragsbestandteil.
