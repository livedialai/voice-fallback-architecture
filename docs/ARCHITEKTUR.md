# Architektur im Detail

Alle Diagramme benutzen nur **Rollennamen**. Konkrete Werte einer laufenden Installation: [`ROLLEN.md`](ROLLEN.md).

Inhaltsverzeichnis: [Gesamtbild](#1-gesamtbild) · [Normalweg](#2-weg-a-normalweg-lokal) · [Fallback](#3-weg-b-fallback-cloud) · [Warmtransfer](#4-weg-c-warmtransfer) · [Wartung](#5-weg-d-wartung-sfu-aus--an) · [Ports](#6-ports-und-protokolle)

---

## 1. Gesamtbild

```
        Anrufer (Telefon)
              │
              │  wählt DID
              ▼
——————————————————————————————————————————————————————————————————————————
   carrier                     SIP-Trunk des Kunden
   · liefert eingehende Anrufe an eine feste Ziel-IP (sip-proxy)
   · Quell-IPs (bekannt) : <carrier-ip-1>, <carrier-ip-2>
—————————┬————————————————————————————————————————————————————————————————
          │  INVITE  sip:<DID>@<carrier-domain>     UDP/5060 (bzw. /5070)
          ▼
——————————————————————————————————————————————————————————————————————————
   sip-proxy                   OpenSIPS 3.x        udp/5070
   · Allow-List: nur <carrier-ip-1/2> (alles andere 403)
   · OPTIONS von erlaubten Quellen → 200 OK (Carrier-Monitoring)
   · INVITE-Ziel PRIO 1:  media-node:5070
   · t_on_failure("sfu_down")  →  bei 408 oder 5xx PRIO 2: LiveKit Cloud
   · t_on_failure("all_down")  →  wenn auch die Cloud scheitert: 503
—————————————————————┬————————————————————————————————————————————————————
                     │  INVITE (prio1)                                   ▲
                     ▼                                                   │ 408/5xx
——————————————————————————————————————————————————————————————————————————  │
   media-node          LiveKit SFU (self-hosted) + LIVEKIT-SIP-BRIDGE      │
   · tcp/7880  WebSocket/API (SFU-Signaling)                               │
   · udp/5070  SIP-Eingang der Bridge (Einladungen vom sip-proxy)          │
   · udp/7882  WebRTC/ICE (Medien, Opus)                                   │
   · Raum: <praefix>_<caller>_<random>                                     │
   · Redis (lokal) für SFU-State                                           │
—————————————————————┬————————————————————————————————————————————————————  │
                     │  WebRTC (Audio)                                   │
                     ▼                                                   │
——————————————————————————————————————————————————————————————————————————  │
   worker-node         Agent-Worker (Node.js, @livekit/agents)             │
   · Container A: LIVEKIT_URL = ws(s)://media-node   → lokaler Betrieb     │
   · Container B: LIVEKIT_URL = wss://<projekt>.livekit.cloud → Fallback   │
   · agent_name aus LIVEKIT_AGENT_NAME (muss zur Dispatch-Rule passen)     │
   · LLM/TTS per HTTP (LLM: OpenAI-kompatibel, TTS: Inworld/… )            │
—————————————————————┬————————————————————————————————————————————————————  │
                     │  bei Bedarf Warmtransfer                          │
                     ▼                                                   │
——————————————————————————————————————————————————————————————————————————  │
   transfer-node       Controller  HTTP :9101  POST /v1/transfer           │
   · legt den Anrufer auf Wartemusik, ruft das Ziel über media-node        │
——————————————————————————————————————————————————————————————————————————  │
                                                                          │
   Fallback-Zweig (prio2), nur wenn prio1 408/5xx antwortet:              │
—————————————————————————————————————————————————————————————————————————— ◀
   LiveKit Cloud (managed SFU)
   · SIP-Trunk        numbers = <DID in allen Formaten>
                      allowed_addresses = [<sip-proxy-ip>/32, …]
   · Dispatch-Rule    roomPrefix = <praefix>_
                      roomConfig.agents = [{ agentName: <agent> }]
   · Cloud-Worker-Container im worker-node nimmt den Job an
——————————————————————————————————————————————————————————————————————————
```

## 2. Weg A: Normalweg (lokal)

```
Anrufer ──INVITE──▶ sip-proxy ──INVITE──▶ media-node (SIP-Bridge)
                                              │  legt SIP-Teilnehmer in den Raum
                                              │  Raum-ID: <praefix>_<caller>_<random>
                                              │
                       100 → 180 → 200 OK ◀───┘
                                              │
                                              ▼
                                     worker-node (lokaler Container)
                                     Agent tritt dem Raum bei, spielt Opener-WAV
```

Merkmale:
- Im Paketmitschnitt auf dem `sip-proxy` sieht man **kein** Paket zum Cloud-Edge.
- Im Worker-Log des **lokalen** Containers steht `received job request` + Raumname.
- Kostenneutral: es werden **keine** Cloud-Minuten verbraucht.

## 3. Weg B: Fallback (Cloud)

```
Anrufer ──INVITE──▶ sip-proxy ──INVITE──▶ media-node:5070
                                              │
                            408 / 5xx (SFU aus, Bridge tot, Raum nicht baubar)
                                              │
                                              ▼
                                    failure_route[sfu_down]
                                    xlog("lokale SFU antwortet $T_reply_code -> Fallback Cloud")
                                    $ru = "sip:" + $rU + "@<cloud-sip-host>"
                                    $du = "sip:<cloud-edge-ip>:5060"
                                    t_on_failure("all_down"); t_relay()
                                              │
                                              ▼
                                     LiveKit Cloud  →  200 OK
                                              │
                                              ▼
                                     Cloud-Worker (worker-node, Container B)
                                     Agent spricht — Anrufer hört nur ~2–4 s Verzögerung
```

Merkmale:
- Paketmitschnitt zeigt `INVITE sip:<DID>@<cloud-sip-host>` **zum Cloud-Edge**.
- Cloud-Konsole: neuer Raum `<praefix>_<caller>_<random>` mit Teilnehmer `sip_<caller>` **und** `agent-<jobID>`.
- Die Cloud belegt Minuten → nur im Ausfall gewollt.

## 4. Weg C: Warmtransfer

```
Anrufer ──▶ Agent (worker-node)
              │  1) Tool "verbinden"(grund, rufnummer)
              ▼
        transfer-node  ──  HTTP POST /v1/transfer
              │             · Anrufer → Wartemusik
              │             · Ziel wird über media-node gerufen (SIP out)
              ▼
        Ziel klingelt (Phase RINGING)
              │
              │  2) parallel: LLM formuliert Briefing (thinking: disabled)
              ▼
        Agent spricht Briefing (Phase AI_BRIEFING)
        "… Anliegen: … Anrufer: … Bestellung: … Lieferung: … Soll ich durchstellen?"
              │
              ▼  3) Ziel antwortet → echter Turn beim Agenten
        Agent: Tool "durchstellen"   ← nur erlaubt, wenn briefing_fertig == true
              │
              ▼
        Bridge verbindet Anrufer ↔ Ziel; Agent tritt aus der Leitung
```

Phasen werden im Transfer-Controller geführt; der Agent darf erst nach dem Briefing durchstellen. Fallstricke (Reasoning-LLMs, `say` statt `generateReply`, verfrühtes Durchstellen): [`WARMTRANSFER.md`](WARMTRANSFER.md).

## 5. Weg D: Wartung (SFU aus / an)

```
SFU ausschalten (media-node):   systemctl stop livekit
   → Anrufe laufen ab sofort über den Cloud-Fallback (Weg B)
   → Beweis: Mitschnitt auf sip-proxy zeigt INVITE zum Cloud-Edge

SFU wieder scharf (media-node): systemctl start livekit
   → ca. 5 s bis Port 7880 antwortet, ~10 s bis der lokale Worker registriert ist
   → Beweis: Testanruf → 100/180/200 OK, KEIN Paket zur Cloud

Reihenfolge-Regel: SFU zuerst, Worker danach prüfen
   (Container A verbindet sich bei Neustart automatisch neu)
```

Wichtig: Ein **einzelner** Ausfall der Bridge bei laufendem SFU führt nicht zwangsläufig zum Fallback — der Proxy schaltet nur bei `408` (Timeout) oder `5xx` um. Antwortet die Bridge mit `486`/`480`, greift der Fallback **nicht** (siehe `PITFALLS.md`).

## 6. Ports und Protokolle

| Rolle | Port/Proto | Zweck | Richtung |
|---|---|---|---|
| sip-proxy | udp/5070 | SIP-Eingang vom Carrier | eingehend |
| sip-proxy | udp/5070 → media-node | SIP-Weiterleitung prio1 | ausgehend |
| sip-proxy | udp/5060 → Cloud-Edge | SIP-Weiterleitung prio2 (Fallback) | ausgehend |
| media-node | udp/5070 | SIP-Eingang der Bridge | eingehend (vom Proxy) |
| media-node | tcp/7880 | SFU WebSocket/API | eingehend (Worker) |
| media-node | udp/7882 | WebRTC/ICE Medien | beidseitig |
| worker-node | ausgehend | WS(S) zum SFU, HTTPS zu LLM/TTS, HTTP zum Controller | ausgehend |
| transfer-node | tcp/9101 | HTTP `/v1/transfer` | eingehend (Worker) |

Alle Ports sind konfigurierbar — die Werte stammen aus den Configs in `media-node/` und `sip-proxy/`.
