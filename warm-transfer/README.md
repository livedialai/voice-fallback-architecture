# Warm-Transfer-Briefing (LLM-formuliert)

Der Agent stellt nicht mehr stumm durch, sondern **formuliert vor dem Durchstellen ein Briefing
für den Menschen am anderen Ende** — aus dem, was er im Gespräch wirklich erfahren hat — und fragt
danach, ob durchgestellt werden soll.

```
Anrufer ──▶ Agent ──▶ Controller ──▶ Ziel (Marktleiter)
                        │
                        ├─ klingelt
                        └─ Agent spricht (parallel formuliert):
                           "Frau Meier fragt zu ihrer Bestellung nach: zwei Vollmilch und
                            eine Butter, insgesamt 12,40 Euro. Geliefert werden soll an die
                            Hauptstraße 5 in 28195 Bremen. Soll ich durchstellen?"
```

## Warum das nicht trivial ist

Drei Dinge sind beim ersten Versuch schiefgegangen. Alle drei sind in `briefing.mjs` und
`integration.md` berücksichtigt:

### 1. Reasoning-Modelle liefern leeren Text

`deepseek-v4.1-flash` (und `gemma-4-31b`) sind Reasoning-Modelle. Ohne Schalter schicken sie
erst 600–700 Zeichen `reasoning_content`, laufen in `max_tokens` und liefern **`content = ""`**
mit `finish_reason: "length"`.

```
ohne Parameter              content 0 Zeichen     reasoning 683 Zeichen    finish=length
thinking: {type:disabled}   content 196 Zeichen   reasoning 0              finish=stop
reasoning_effort: "none"    content 200 Zeichen   reasoning 0              finish=stop
```

→ Immer `thinking: { type: 'disabled' }` mitsenden. `reasoning_effort: "none"` wirkt bei
DeepSeek Flash auch, ist aber nicht bei jedem Modell gleich zuverlässig.

### 2. Der Sprech-Kanal entscheidet über die Phasen

`session.generateReply()` ist ein **voller LLM-Turn**: Der Agent generiert eine Antwort, spricht
sie, danach ist der Turn abgeschlossen. Während des Sprechens hört er nicht zu, und nach dem Turn
ist die Gesprächsphase eine andere — das Briefing ging ins Leere, die Frage kam nie, der Anrufer
hörte Stille.

`session.say(text, …)` ist eine **reine TTS-Ansage**: Der Agent bleibt im Zuhören-Modus, hört
danach die Antwort des Zielteilnehmers als echten Turn und kann darauf reagieren.

```js
// falsch
session.generateReply({ instructions: `Sage wortgleich: "${text}"` });

// richtig
const handle = session.say(text, { allowInterruptions: false, addToChatCtx: true });
await handle.waitForPlayout();   // erst danach ist das Briefing "fertig"
```

### 3. Das LLM stellt zu früh durch

Im Testlog rief das Modell `durchstellen()` **zwei Sekunden nach dem Klingeln** auf — bevor
irgendjemand das Briefing gehört hatte. Der Controller nahm es an, die Verbindung stand, das
Briefing lief danach ins Leere.

Zwei Gegenmaßnahmen:

- **Harte Sperre im Tool**: `durchstellen()` wird abgelehnt, solange `briefing_fertig === false`
  ist, und gibt dem Modell eine klare Anweisung zurück („Du bist still, warte auf die Antwort").
  Erst `waitForPlayout()` setzt das Flag.
- **Klarer Tool-Rückgabewert** von `verbinden()`: „Der Code spricht jetzt Briefing und Frage —
  nicht du. Du bist STUMM, bis der Zielteilnehmer antwortet."

## Latenz: Briefing parallel zum Klingeln

Der Transfer-Aufbau dauert 5–7 s (Controller wählt, Ziel klingelt). Formuliert man das Briefing
erst danach, ist es 2–3 s zu spät — das Ziel ist schon am Apparat.

Deshalb startet der LLM-Call **mit** dem Transfer und wird erst später awaited:

```js
const briefingPromise = formuliereBriefing(fakten).catch(() => '');   // sofort starten
await fetch(`${CONTROLLER}/v1/transfer`, { … });                      // 5–7 s, parallel
// … warten bis Phase AI_BRIEFING …
const llmBrief = await briefingPromise;                               // ist längst fertig
```

Gemessen: 352–578 ms pro Briefing (DeepSeek V4.1 Flash, `thinking: disabled`, 66 Output-Tokens).

## Fallback

Wenn das Modell nichts Brauchbares liefert (leer, < 40 Zeichen, > 600 Zeichen, HTTP-Fehler,
Timeout 2,6 s), spricht der Code die **deterministische** Ansage — dieselbe wie vorher:

```
Hier ist Ihre digitale Assistentin, ich habe einen Anrufer fuer Sie.
Anliegen: … Anrufer: … Bestellung: … Lieferung: …
Soll ich durchstellen?
```

Der Transfer funktioniert also auch, wenn der LLM-Call ausfällt.

## Bekannte Einschränkung

Das Modell übernimmt Formulierungen aus dem `grund`-Feld des Agenten. Sagt der Agent dort
„es ging um eine Bestellung", obwohl der Anrufer nur eine Frage hatte, steht das auch im Briefing.
Gegenmittel: `grund` knapper halten („Frage zum Liefertermin") oder im System-Prompt schärfen:
nur Fakten nennen, keine Interpretation.

## Dateien

| Datei | Inhalt |
|---|---|
| `briefing.mjs` | `formuliereBriefing()` + `BRIEFING_SYSTEM`, ohne Abhängigkeiten außer `fetch` (Node ≥ 18) |
| `integration.md` | Die vier Einbaustellen im Agenten, mit Code und Reihenfolge |
| `test-briefing.mjs` | Trockentest ohne Telefonie: drei Fälle, gibt die formulierten Briefings aus |

## Umgebung

```
LLM_BASE_URL   https://api.melious.ai/v1
LLM_MODEL      deepseek-v4.1-flash
LLM_API_KEY    <key>
CONTROLLER_URL http://<controller>:9101
TRANSFER_NUMBER +49…
```
