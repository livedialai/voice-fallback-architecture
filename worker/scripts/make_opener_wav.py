#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Erzeugt den Opener-WAV fuer den Node-Cascade-Worker (Inworld TTS, 24 kHz PCM16 mono).

Der Opener wird EINMAL synthetisiert und danach in jedem Call nur noch abgespielt
(kein TTS-Call, keine Kosten). Format muss PCM16/mono/24 kHz sein - das ist genau
das, was Inworld liefert und was agent.js als AudioFrames einliest.

Aufruf:
    python3 scripts/make_opener_wav.py [TEXT] [--out PFAD] [--env PFAD]

Ohne TEXT wird OPENER_TEXT aus der .env genommen. Voice/Modell kommen aus
TTS_VOICE_ID / TTS_MODEL, der Key aus TTS_API_KEY (Fallback INWORLD_API_KEY).
"""
import argparse
import base64
import json
import pathlib
import struct
import sys
import urllib.request

RATE = 24000


def env_get(pfad, key, default=None):
    p = pathlib.Path(pfad)
    if not p.exists():
        return default
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return default


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("text", nargs="?", default=None, help="Opener-Wortlaut")
    ap.add_argument("--out", default=None, help="Ziel-WAV (Default: OPENER_WAV oder ./opener.wav)")
    ap.add_argument("--env", default=None, help=".env-Pfad (Default: ./.env)")
    args = ap.parse_args()

    hier = pathlib.Path(__file__).resolve().parent.parent
    env_pfad = args.env or str(hier / ".env")
    out = args.out or env_get(env_pfad, "OPENER_WAV") or str(hier / "opener.wav")

    key = env_get(env_pfad, "TTS_API_KEY") or env_get(env_pfad, "INWORLD_API_KEY")
    if not key:
        sys.exit("FEHLER: kein TTS_API_KEY / INWORLD_API_KEY in " + env_pfad)
    voice = env_get(env_pfad, "TTS_VOICE_ID") or "nadine-neu"
    model = env_get(env_pfad, "TTS_MODEL") or "inworld-tts-2"
    text = args.text or env_get(env_pfad, "OPENER_TEXT")
    if not text:
        sys.exit("FEHLER: kein Text (Argument oder OPENER_TEXT in der .env)")

    body = json.dumps({
        "text": text,
        "voiceId": voice,
        "modelId": model,
        "audioConfig": {"audioEncoding": "PCM", "sampleRateHertz": RATE},
        "language": "de-DE",
    }).encode()

    req = urllib.request.Request(
        "https://api.inworld.ai/tts/v1/voice:stream",
        data=body,
        headers={
            # Inworld erwartet "Basic <key>" DIREKT - der Key ist bereits base64.
            # Nicht nochmal base64-kodieren (sonst 403).
            "Authorization": "Basic " + key,
            "Content-Type": "application/json",
        },
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=90) as r:
        raw = r.read().decode("utf-8", "replace")

    # Antwort ist NDJSON: eine JSON-Zeile pro Audio-Chunk.
    pcm = bytearray()
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        b64 = (obj.get("result") or {}).get("audioContent")
        if b64:
            pcm += base64.b64decode(b64)

    if not pcm:
        sys.exit("FEHLER: keine Audio-Daten in der Antwort: " + raw[:200])

    # WAV-Header (PCM16, mono, RATE)
    daten = bytes(pcm)
    hdr = b"RIFF" + struct.pack("<I", 36 + len(daten)) + b"WAVEfmt "
    hdr += struct.pack("<IHHIIHH", 16, 1, 1, RATE, RATE * 2, 2, 16)
    hdr += b"data" + struct.pack("<I", len(daten))
    pathlib.Path(out).write_bytes(hdr + daten)

    dauer = len(daten) / (RATE * 2)
    print(f"OK  {out}  {len(hdr)+len(daten)} Bytes  {dauer:.2f} s  voice={voice} model={model}")


if __name__ == "__main__":
    main()
