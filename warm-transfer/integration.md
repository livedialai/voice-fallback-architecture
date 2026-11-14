# Einbau in einen bestehenden LiveKit-Node-Agenten

Vier Stellen. Reihenfolge ist wichtig — jede einzelne hat im Test einen eigenen Fehler verursacht.

## 1. State: Flag für „Briefing ist fertig gesprochen"

```js
function stateOf(room) {
  let s = transferState.get(room);
  if (!s) {
    s = { last_connect_at: 0, connected: false, in_progress: false, briefing_fertig: false };
    transferState.set(room, s);
  }
  return s;
}
```

## 2. Briefing-LLM parallel zum Transfer starten

Direkt **vor** dem `fetch` an den Controller, damit der Call läuft, während das Ziel klingelt:

```js
st.in_progress = true;
st.last_connect_at = now;
st.briefing_fertig = false;

const stCall = callState(roomName);
const vCart = cartView(roomName);
const ld = stCall.liefer || {};
const fakten = baueFakten({
  grund,
  name: ld.name,
  posten: vCart.posten,
  summe: vCart.summe,
  strasse: ld.strasse,
  hausnummer: ld.hausnummer,
  plz: ld.plz,
  ort: ld.ort,
});
const briefingPromise = formuliereBriefing(fakten).catch((e) => {
  console.log('BRIEFING-FALLBACK', String((e && e.message) || e).slice(0, 120));
  return '';
});

const r = await fetch(`${CONTROLLER}/v1/transfer`, { /* … */ });   // 5-7 s, laeuft parallel
```

## 3. Sprechen: `session.say`, nicht `generateReply`

```js
async function sprecheMitRetry(session, text, label) {
  for (let i = 1; i <= 3; i += 1) {
    console.log('SPRECHE', label, 'versuch', i);
    try {
      const handle = session.say(text, { allowInterruptions: false, addToChatCtx: true });
      if (handle && typeof handle.waitForPlayout === 'function') {
        await handle.waitForPlayout();
        return true;
      }
      const gestartet = await warteAufState(session, ['speaking'], 3000);
      if (gestartet) return true;
    } catch (e) {
      console.log('SPRECHE-FEHLER', e.message);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  console.log('SPRECHE-FEHLGESCHLAGEN', label);
  return false;
}
```

Nach dem Warten auf die Phase `AI_BRIEFING` (oder `chef_answered`):

```js
const llmBrief = await briefingPromise;                    // ist laengst fertig
let ansage = 'Hier ist Ihre digitale Assistentin, ich habe einen Anrufer fuer Sie. ' + fakten;
if (briefingBrauchbar(llmBrief)) {
  ansage = llmBrief;
  console.log('BRIEFING-LLM', JSON.stringify(ansage.slice(0, 200)));
} else {
  console.log('BRIEFING-FALLBACK', 'LLM-Text unbrauchbar', JSON.stringify(String(llmBrief || '').slice(0, 80)));
}

setTimeout(async () => {
  try { session.interrupt({ force: true }); } catch (_) {}
  await warteAufState(session, ['listening', 'idle'], 6000);
  const ok = await sprecheMitRetry(session, ansage + ' Soll ich durchstellen?', 'BRIEFING');
  if (ok) {
    stateOf(roomName).briefing_fertig = true;      // erst jetzt darf durchgestellt werden
    await warteAufState(session, ['listening', 'idle'], 25000);
  }
}, 900);
```

## 4. Sperre im `durchstellen`-Tool

```js
const durchstellen = llm.tool({
  description: 'Schliesst den Warmtransfer ab. Nur aufrufen, wenn der Zielteilnehmer ausdruecklich zugestimmt hat.',
  parameters: z.object({}),
  execute: async () => {
    const st = stateOf(roomName);
    if (st.connected) return 'Anrufer und Zielteilnehmer sind bereits verbunden.';
    if (!st.briefing_fertig) {
      st.in_progress = false;
      return 'Noch NICHT durchstellen: das Briefing und die Frage sind noch nicht gesprochen. '
        + 'Du bist still, bis der Zielteilnehmer geantwortet hat. Antworte jetzt nicht selbst, '
        + 'rufe kein weiteres Tool auf und warte auf seine Antwort.';
    }
    // … Controller-Call /v1/briefing-complete …
  },
});
```

Und der Rückgabewert von `verbinden()`:

```
OK. Der Transfer laeuft. Der Code spricht jetzt das Briefing und die Frage "Soll ich durchstellen?"
- nicht du. Du bist STUMM, bis der Zielteilnehmer antwortet. Rufe durchstellen() NICHT auf,
bevor du ein klares Ja gehoert hast. Bei Nein: warm_transfer_abbrechen().
```

## 5. Abschied bei Ablehnung

```js
const h = session.say('Alles klar, ich stelle nicht durch. Auf Wiederhoeren.',
  { allowInterruptions: false, addToChatCtx: true });
if (h && typeof h.waitForPlayout === 'function') await h.waitForPlayout();
else await new Promise((res) => setTimeout(res, 4000));
```

Erst danach `/v1/cancel` am Controller rufen — sonst hört das Ziel den Abschied nicht mehr.

## Prüfliste nach dem Einbau

1. `BRIEFING-LLM` erscheint **vor** `TRANSFER-ANTWORT`? → Parallelisierung greift.
2. `BRIEFING-FERTIG briefing=ok` vor `DURCHSTELLEN`? → Sperre und Reihenfolge stimmen.
3. Nach `BRIEFING-FERTIG` kommt `received user transcript`? → Der Agent hört wieder zu.
4. Bei „nein" kommt `ABLEHNEN` und der Abschied wird hörbar gesprochen, **bevor** der Transfer abbricht.
