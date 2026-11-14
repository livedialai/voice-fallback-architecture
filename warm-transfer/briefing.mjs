/**
 * Briefing fuer den Warm Transfer - LLM-formuliert, mit deterministischem Fallback im Aufrufer.
 *
 * Abhaengigkeiten: nur globales fetch (Node >= 18). Kein SDK, keine Imports.
 * Wichtig: thinking:{type:'disabled'} - ohne diesen Schalter liefern Reasoning-Modelle
 * (deepseek-v4.1-flash, gemma-4-31b) leeren content und finish_reason "length".
 */

const BRIEFING_SYSTEM = [
  'Du bist die digitale Telefonassistentin eines Supermarkts und bereitest ein kurzes muendliches Briefing',
  'fuer den Marktleiter vor, zu dem du den Anrufer gleich durchstellst.',
  'Nenne in zwei bis drei natuerlichen, gesprochenen Saetzen: wer anruft, worum es geht, was bestellt wurde',
  'und wohin geliefert wird - nur das, was wirklich in den Fakten steht, nichts erfinden.',
  'Steht keine Bestellung in den Fakten, erwaehne keine Bestellung. Steht keine Lieferung drin, keine Lieferung.',
  'Ist das Anliegen nur eine allgemeine Floskel, gib es neutral wieder, ohne es zu deuten.',
  'Keine Aufzaehlung, keine Anrede, keine Anredeformel, keine Frage am Ende, keine Regieanweisung,',
  'keine Wiederholung des Wortes Anliegen. Kuendige das Durchstellen nicht an und sage nicht',
  '"ich stelle jetzt durch" oder "soll ich durchstellen" - diese Frage stellt der Code. Maximal 60 Woerter.',
  'Antworte nur mit dem Briefing-Text.',
].join(' ');

/**
 * Baut die Fakten-Zeile, die dem Modell als User-Nachricht uebergeben wird.
 * Bewusst schlicht und faktenorientiert - das Modell formuliert daraus Prosa.
 */
export function baueFakten({ grund, name, posten, summe, strasse, hausnummer, plz, ort }) {
  return [
    'Anliegen: ' + (String(grund || '').trim() || 'Der Anrufer moechte mit einem Menschen sprechen.'),
    name ? 'Anrufer: ' + name + '.' : '',
    posten && posten.length ? 'Bestellung: ' + posten.map((p) => `${p.menge} x ${p.artikel}`).join(', ') + '. Summe ' + summe + '.' : '',
    strasse ? 'Lieferung: ' + [strasse, hausnummer, [plz, ort].filter(Boolean).join(' ')].filter(Boolean).join(' ') + '.' : '',
  ].filter(Boolean).join(' ');
}

/**
 * Fragt das LLM nach dem Briefing-Text.
 * @returns {Promise<string>} leerer String bei Fehler/Timeout - der Aufrufer nutzt dann den Fallback.
 */
export async function formuliereBriefing(fakten, {
  baseUrl = process.env.LLM_BASE_URL || 'https://api.melious.ai/v1',
  apiKey = <REDACTED> || '',
  model = process.env.LLM_MODEL || 'deepseek-v4.1-flash',
  timeoutMs = 2600,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + String(apiKey),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: BRIEFING_SYSTEM },
          { role: 'user', content: fakten },
        ],
        max_tokens: 160,
        temperature: 0.3,
        thinking: { type: 'disabled' },
      }),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const txt = d?.choices?.[0]?.message?.content || '';
    return String(txt).replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim();
  } finally {
    clearTimeout(timer);
  }
}

/** Prueft, ob der Text als Ansage brauchbar ist. */
export function briefingBrauchbar(text) {
  const t = String(text || '').trim();
  return t.length >= 40 && t.length <= 600;
}
