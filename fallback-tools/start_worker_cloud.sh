#!/bin/bash
# Startet einen Agent-Worker als Container — mit den Root-CAs, die TLS zu LiveKit Cloud braucht.
# Ohne CA-Mount bricht der Worker mit "no native root CA certificates found" ab bzw. nimmt keinen Job an.
#
# Umgebung:
#   WORKER_NAME    Containername, Default node-cascade-cloud
#   WORKER_ENV     env-Datei mit API-Key/Secret, LIVEKIT_URL, LLM-/TTS-Keys, Default ./worker-cloud.env
#   WORKER_DIR     Hostverzeichnis mit agent.js/package.json, Default /opt/node-cascade
#   NODE_IMAGE     Default node:22-slim
set -eu
WORKER_NAME=${WORKER_NAME:-node-cascade-cloud}
WORKER_ENV=${WORKER_ENV:-./worker-cloud.env}
WORKER_DIR=${WORKER_DIR:-/opt/node-cascade}
NODE_IMAGE=${NODE_IMAGE:-node:22-slim}

test -f "$WORKER_ENV" || { echo "env-Datei fehlt: $WORKER_ENV"; exit 1; }
test -d "$WORKER_DIR" || { echo "Workerverzeichnis fehlt: $WORKER_DIR"; exit 1; }
test -f /etc/ssl/certs/ca-certificates.crt || { echo "Root-CAs fehlen (ca-certificates installieren)"; exit 1; }

grep -q '^LIVEKIT_URL=' "$WORKER_ENV" || { echo "LIVEKIT_URL fehlt in $WORKER_ENV"; exit 1; }
echo "LIVEKIT_URL: $(grep '^LIVEKIT_URL=' "$WORKER_ENV" | cut -d= -f2-)"

docker rm -f "$WORKER_NAME" >/dev/null 2>&1 || true
docker run -d --name "$WORKER_NAME" --restart unless-stopped \
  --env-file "$WORKER_ENV" \
  -v "$WORKER_DIR:/app" \
  -v /etc/ssl/certs:/etc/ssl/certs:ro \
  -e NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
  -w /app "$NODE_IMAGE" node agent.js start >/dev/null

echo "Container gestartet, warte auf Registrierung ..."
sleep 12
docker logs "$WORKER_NAME" 2>&1 | grep -a "registered worker" | tail -2 \
  || { echo "KEINE Registrierung — Log prüfen:"; docker logs --tail 20 "$WORKER_NAME" 2>&1 | tail -20; exit 1; }
