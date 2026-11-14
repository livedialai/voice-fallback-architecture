#!/usr/bin/env bash
# LLM-Umschalter fuer den Node-Cascade-Worker.
# Jeder Wechsel ist EIN Befehl: ./switch_llm.sh <profil>
# Preflight laeuft VOR dem Restart: antwortet das Zielmodell nicht mit 200,
# wird nichts geaendert (kein "nur Opener"-Anruf mehr).
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/node-cascade/.env}"
UNIT="${UNIT:-node-cascade}"
KEY_DIR="${KEY_DIR:-/root/.secrets}"

# --- Profile: Base-URL, Modell, reasoning_effort (LEER = Parameter faellt weg) ---
profile() {
  case "$1" in
    melious)
      BASE="https://api.melious.ai/v1"; MODEL="deepseek-v4.1-flash"; EFFORT="none"
      KEYVAR="MELIOUS_API_KEY"; KEYFILE="$KEY_DIR/melious.env" ;;
    gemini-eu)
      BASE="https://router.requesty.ai/v1"; MODEL="vertex/gemini-3.1-flash-lite@eu"; EFFORT=""
      KEYVAR="REQUESTY_KEY"; KEYFILE="$KEY_DIR/requesty.env" ;;
    gemini-eu-flex)
      BASE="https://router.requesty.ai/v1"; MODEL="vertex/gemini-3.1-flash-lite@eu:flex"; EFFORT=""
      KEYVAR="REQUESTY_KEY"; KEYFILE="$KEY_DIR/requesty.env" ;;
    deepseek)
      BASE="https://api.deepseek.com/v1"; MODEL="deepseek-flash"; EFFORT=""
      KEYVAR="DEEPSEEK_API_KEY"; KEYFILE="$KEY_DIR/deepseek.env" ;;
    qwen)
      BASE="https://api.melious.ai/v1"; MODEL="qwen3.8-27b"; EFFORT="none"
      KEYVAR="MELIOUS_API_KEY"; KEYFILE="$KEY_DIR/melious.env" ;;
    *) echo "unbekanntes Profil: $1"; echo "verfuegbar: melious gemini-eu gemini-eu-flex deepseek qwen"; exit 2 ;;
  esac
}

[ $# -eq 1 ] || { echo "Aufruf: $0 <melious|gemini-eu|gemini-eu-flex|deepseek|qwen>"; exit 2; }
profile "$1"

# --- Key holen (nie im Klartext ausgeben) ---
KEY="$(grep -E "^${KEYVAR}=" "$KEYFILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
[ -n "$KEY" ] || { echo "FEHLER: ${KEYVAR} nicht in ${KEYFILE}"; exit 1; }

# --- Preflight: genau dieser Request muss 200 liefern, sonst kein Umschalten ---
echo "Preflight: ${MODEL} @ ${BASE}"
BODY=$(printf '{"model":"%s","messages":[{"role":"user","content":"sag kurz hallo"}],"max_tokens":16}' "$MODEL")
CODE=$(curl -s -o /tmp/switch_llm_probe.json -w '%{http_code}' -m 25 \
  -H "Authorization: <REDACTED> $KEY" -H 'Content-Type: application/json' \
  -d "$BODY" "${BASE%/}/chat/completions" || echo 000)
if [ "$CODE" != "200" ]; then
  echo "PREFLIGHT FEHLGESCHLAGEN: HTTP $CODE -- es wird NICHTS geaendert"
  head -c 300 /tmp/switch_llm_probe.json; echo; exit 1
fi
echo "Preflight ok (HTTP 200)"

# --- Snapshot, dann umschalten ---
BAK="${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
cp -a "$ENV_FILE" "$BAK"
sed -i \
  -e "s|^LLM_BASE_URL=.*|LLM_BASE_URL=${BASE}|" \
  -e "s|^LLM_MODEL=.*|LLM_MODEL=${MODEL}|" \
  -e "s|^LLM_API_KEY=<REDACTED>" \
  -e "s|^LLM_REASONING_EFFORT=.*|LLM_REASONING_EFFORT=${EFFORT}|" \
  "$ENV_FILE"

systemctl restart "$UNIT"
sleep 8
echo "--- aktiv ---"
sed -E 's/(KEY)=.*/\1=<gesetzt>/' "$ENV_FILE" | grep '^LLM_'
echo "status: $(systemctl is-active "$UNIT")"
echo "rollback: cp -a $BAK $ENV_FILE && systemctl restart $UNIT"
