import { defineAgent, WorkerOptions, cli, llm, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as inworld from '@livekit/agents-plugin-inworld';
import * as silero from '@livekit/agents-plugin-silero';
import { AudioFrame } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { z } from 'zod';

/** WAV (PCM16, mono) -> ReadableStream<AudioFrame> fuer session.say({ audio }). */
function wavToAudioStream(pfad, frameMs = 20) {
  try {
    if (!fs.existsSync(pfad)) return null;
    const buf = fs.readFileSync(pfad);
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    let pos = 12, fmt = null, pcm = null;
    while (pos + 8 <= buf.length) {
      const id = buf.toString('ascii', pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      const start = pos + 8;
      if (id === 'fmt ') {
        fmt = { channels: buf.readUInt16LE(start + 2), sampleRate: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14) };
      } else if (id === 'data') {
        pcm = buf.subarray(start, Math.min(start + size, buf.length));
        break;
      }
      pos = start + size + (size % 2);
    }
    if (!pcm || !fmt || fmt.bits !== 16) return null;
    const ab = new ArrayBuffer(pcm.byteLength);
    new Uint8Array(ab).set(pcm);
    const int16 = new Int16Array(ab);
    const spc = Math.floor((fmt.sampleRate * frameMs) / 1000);
    const frames = [];
    for (let i = 0; i < int16.length; i += spc) {
      const chunk = int16.slice(i, i + spc);
      frames.push(new AudioFrame(chunk, fmt.sampleRate, fmt.channels, chunk.length));
    }
    return new ReadableStream({ start(c) { for (const f of frames) c.enqueue(f); c.close(); } });
  } catch (e) {
    console.log('OPENER-WAV-FEHLER', e.message);
    return null;
  }
}

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PROMPT_FILE = process.env.PROMPT_FILE || `${HERE}system_prompt.txt`;
const INSTRUCTIONS = fs.existsSync(PROMPT_FILE)
  ? fs.readFileSync(PROMPT_FILE, 'utf8').trim()
  : (process.env.AGENT_PROMPT || 'Du bist Franzi, die freundliche Telefonassistenz.');

const CONTROLLER = process.env.CONTROLLER_URL || 'http://127.0.0.1:9100';
const SEARCH_URL = process.env.SEARCH_URL || 'https://jambonz.gofonia.de/tool/search';
const ORDER_URL = process.env.ORDER_URL || 'https://jambonz.gofonia.de/s2s/order';
const BACKEND = process.env.BACKEND_URL || '';
const JWT_SECRET = <REDACTED> || '';
const TENANT_ID = process.env.TENANT_ID || '';
const DEFAULT_TARGET = process.env.TRANSFER_TARGET || '';

const transferState = new Map();

function letzterNutzerText(session) {
  try {
    const items = session?.chatCtx?.items ?? [];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it?.role === 'user' && typeof it?.content === 'string' && it.content.trim()) return it.content;
    }
  } catch (_) {}
  return '';
}

const JA_WOERTER = ['stellen sie durch', 'stell durch', 'ja', 'jawohl', 'gerne', 'klar', 'okay', 'ok', 'genau', 'passt', 'durchstellen', 'verbinden', 'richtig'];
function istBestaetigung(text) {
  const t = (text || '').toLowerCase();
  return JA_WOERTER.some((w) => new RegExp('(^|[^a-z0-9])' + w.replace(/ /g, '\s+') + '([^a-z0-9]|$)', 'i').test(t));
}
function stateOf(room) {
  let s = transferState.get(room);
  if (!s) { s = { last_connect_at: 0, connected: false, in_progress: false, briefing_fertig: false }; transferState.set(room, s); }
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function jwt() {
  if (!JWT_SECRET) return '';
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ sub: 'admin', iat: now, exp: now + 3600 }));
  const s = b64url(crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest());
  return `${h}.${p}.${s}`;
}

function authHeaders() {
  const t = jwt();
  return t ? { Authorization: <REDACTED> ${t}` } : {};
}

function normalizeNr(v) {
  const d = String(v || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+49')) return '0' + d.slice(3);
  if (d.startsWith('+')) return '0' + d.slice(1);
  if (d.startsWith('0049')) return '0' + d.slice(4);
  if (d.startsWith('49') && d.length > 11) return '0' + d.slice(2);
  return d;
}

async function ladeWeiterleitungen() {
  if (!BACKEND) return [];
  const url = `${BACKEND}/api/settings/forwards${TENANT_ID ? `?tenant_id=${TENANT_ID}` : ''}`;
  const r = await fetch(url, { headers: { ...authHeaders() } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const list = Array.isArray(data) ? data : (data.forwards || data.items || data.data || []);
  return Array.isArray(list) ? list : [];
}

async function zielAufloesen(ziel) {
  const raw = String(ziel || '').trim();
  try {
    const fw = await ladeWeiterleitungen();
    const n = normalizeNr(raw).replace(/^0/, '');
    for (const f of fw) {
      const name = String(f.name || f.label || f.bezeichnung || '').toLowerCase();
      const num = normalizeNr(f.destination || f.number || f.nummer || f.phone || f.ziel || '');
      if (name && raw.toLowerCase().includes(name)) return num;
      if (num && n && num.replace(/^0/, '').endsWith(n)) return num;
    }
  } catch (e) {
    console.log('FORWARDS-FEHLER', e.message);
  }
  const d = normalizeNr(raw);
  if (/^0\d{6,}$/.test(d)) return d;
  // Wie 07: der Markt-Anschluss fuer "mit einem Menschen sprechen"
  const markt = String(process.env.TRANSFER_NUMBER || '').trim();
  if (markt) return normalizeNr(markt) || markt;
  return normalizeNr(DEFAULT_TARGET) || DEFAULT_TARGET;
}

function toE164(v) {
  let d = String(v || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  d = d.replace(/^0+/, '');
  if (!d.startsWith('49')) d = '49' + d;
  return '+' + d;
}

function toSipLoad(v) {
  let d = String(v || '').replace(/[^\d]/g, '');
  d = d.replace(/^0+/, '');
  if (!d.startsWith('49')) d = '49' + d;
  return '0049' + d.slice(2);
}

let CURRENT_PROMPT = INSTRUCTIONS;

// ===== 1:1 aus /opt/workers/s2s-edeka/lib/agent.js (07-Stack) =====
const calls = new Map();
const pendingBriefings = new Map();

// Briefing fuer den Warm Transfer: formuliert der Agent selbst aus den bekannten Fakten.
// Fallback im Aufrufer bleibt der deterministische Satz, wenn hier nichts Brauchbares kommt.
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

async function formuliereBriefing(fakten) {
  const base = String(process.env.LLM_BASE_URL || 'https://api.melious.ai/v1').replace(/\/+$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2600);
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + String(process.env.LLM_API_KEY || ''),
      },
      body: JSON.stringify({
        model: String(process.env.LLM_MODEL || 'deepseek-v4.1-flash'),
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
    const txt = d && d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : '';
    return String(txt || '').replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim();
  } finally {
    clearTimeout(timer);
  }
}
// 1:1 aus dem 07-Worker
const PHRASES = {
  warten: 'Einen Moment bitte, ich schaue nach.',
  notiert: 'Notiert.',
  weiter: 'Was darf es noch sein?',
  nicht_gefunden: 'Das habe ich leider nicht im Sortiment. Wonach moechten Sie noch suchen?',
  unklar: 'Da bin ich mir gerade nicht sicher. Sagen Sie mir bitte noch einmal, was Sie moechten.',
  nicht_erreicht: 'Ich konnte leider niemanden im Markt erreichen. Wie kann ich Ihnen sonst helfen?',
  ablehnung: 'Der Mitarbeiter ist gerade nicht am Platz. Ich bin wieder fuer Sie da. Was kann ich noch fuer Sie tun?',
  upsell_opener: 'Moechten Sie noch etwas dazu?',
  danke_feedback: 'Vielen Dank fuer Ihr Feedback, das nehme ich mir zu Herzen.',
  verabschiedung: 'Vielen Dank fuer Ihren Anruf. Auf Wiederhoeren!',
};
const eur = (n) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + ' Euro';
const LIEFER_FELDER = ['name', 'strasse', 'hausnummer', 'plz', 'ort', 'etage'];

function callState(room) {
  if (!calls.has(room)) calls.set(room, { cart: [], liefer: {}, orderNo: null, closed: false });
  return calls.get(room);
}
function packSize(artikel) {
  const m = String(artikel).match(/(\d+)\s*[x×]\s*[\d,.]+\s*l/i);
  return m ? Math.max(1, Number(m[1])) : 1;
}
function cartView(room) {
  const st = callState(room);
  const summe = st.cart.reduce((s2, i) => s2 + i.menge * i.preis, 0);
  return {
    posten: st.cart.map((i) => ({ artikel: i.artikel, menge: i.menge, gebinde: i.gebinde, einzelpreis: eur(i.preis), zeilensumme: eur(i.menge * i.preis) })),
    anzahl_positionen: st.cart.length,
    summe: eur(summe),
  };
}
function cartAdd(room, { artikel, menge, preis, einheit }) {
  const st = callState(room);
  const pack = packSize(artikel);
  let gebinde = Math.max(1, Number(menge) || 1);
  let flaschen = null;
  const willFlaschen = String(einheit || '').toLowerCase().startsWith('flasch') || Number(menge) > 1;
  if (pack > 1 && willFlaschen) {
    gebinde = Math.max(1, Math.ceil(Number(menge) / pack));
    flaschen = gebinde * pack;
  }
  const vorhanden = st.cart.find((i) => i.artikel.toLowerCase() === String(artikel).toLowerCase());
  if (vorhanden) vorhanden.menge += gebinde;
  else st.cart.push({ artikel: String(artikel), menge: gebinde, preis: Number(preis) || 0, gebinde: pack, flaschen });
  return { ...cartView(room), hinweis: pack > 1 ? `Artikel ist ein Gebinde mit ${pack} Einheiten.` : undefined };
}
function lieferSpeichern(room, args) {
  const st = callState(room);
  for (const f of LIEFER_FELDER) {
    const v = args?.[f];
    if (v !== undefined && String(v).trim() !== '') st.liefer[f] = String(v).trim();
  }
  const fehlt = LIEFER_FELDER.filter((f) => !st.liefer[f]);
  return {
    gespeichert: st.liefer,
    fehlt,
    hinweis: fehlt.length ? `Es fehlen noch: ${fehlt.join(', ')}. Frage nur diese Felder.` : 'Alle Lieferdaten liegen vor.',
  };
}
async function abschluss(room) {
  const st = callState(room);
  const v = cartView(room);
  const adresse = [st.liefer.strasse, st.liefer.hausnummer, [st.liefer.plz, st.liefer.ort].filter(Boolean).join(' '), st.liefer.etage ? `Etage ${st.liefer.etage}` : '']
    .filter(Boolean).join(', ');
  const fehlt = LIEFER_FELDER.filter((f) => !st.liefer[f]);
  let orderNo = st.orderNo || null;
  if (!fehlt.length && st.cart.length > 0 && !orderNo) {
    try {
      const res = await fetch(ORDER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          call_sid: room, quelle: 's2s',
          kunde: st.liefer.name || '', strasse: st.liefer.strasse || '', hausnummer: st.liefer.hausnummer || '',
          plz: st.liefer.plz || '', ort: st.liefer.ort || '', etage: st.liefer.etage || '',
          positionen: st.cart.map((i) => ({ artikel: i.artikel, menge: i.menge, einzelpreis_num: i.preis })),
        }),
        signal: AbortSignal.timeout(8000),
      });
      const out = await res.json();
      if (out?.ok) { orderNo = out.order_no; st.orderNo = orderNo; }
      console.log('BESTELLUNG', orderNo);
    } catch (err) {
      console.log('BESTELLUNG-FEHLER', err.message);
    }
  }
  st.closed = true;
  return {
    bestellnummer: orderNo,
    positionen: v.posten,
    summe: v.summe,
    kunde: st.liefer.name || '',
    lieferanschrift: adresse,
    fehlende_lieferdaten: fehlt,
  };
}
// ===== Ende 07-Logik =====
let TC = {};

const TRANSFER_RULES = `

WARMTRANSFER-REGELN:
- Wenn der Anrufer mit einem Mitarbeiter, Kollegen, Ziel, einer Weiterleitung oder einer Nummer verbunden werden moechte, musst du zwingend das Tool verbinden() aufrufen. Du darfst eine Weiterleitung niemals nur simulieren oder verbal ankuendigen.
- Erkenne Ablehnung des ANRUFERS bei 'nein', 'nicht verbinden', 'nicht durchstellen', 'doch nicht', 'keine Verbindung', 'spaeter', 'eigentlich nicht', 'vergiss es', 'nicht noetig', 'ich wollte nur fragen', 'lasst das' - dann verbinden() NICHT aufrufen und im Gespraech bleiben. Bei Unklarheit nachfragen, ob verbunden werden soll.
- Bei Warm Transfer spricht der Code automatisch die Ansage 'Einen Moment bitte' an den Anrufer, waehlt das Ziel und spricht dem Zielteilnehmer das Briefing mit dem Transkript. Du musst die Ansage und das Briefing NICHT selbst sprechen und keine weiteren Schritte einleiten.
- Nachdem das Briefing und die Frage 'Soll ich durchstellen?' gesprochen wurden, bist du mit dem Zielteilnehmer verbunden. Frage NICHT erneut. Warte auf die Antwort des Zielteilnehmers. Sprich den Zielteilnehmer niemals mit einem Namen an, auch wenn der Name im Gespraech gefallen ist.
- Erkenne die Zustimmung auch bei 'durchstellen', 'stellen Sie durch', 'verbinden', 'ja bitte', 'ok' - nicht nur bei einem einfachen 'ja'.
- Rufe durchstellen() auf, sobald der Zielteilnehmer zustimmt - ohne weitere Rueckfrage. Bei Ablehnung des Zielteilnehmers rufe sofort warm_transfer_abbrechen() auf; das Tool sagt dem Zielteilnehmer den Abschied und trennt ihn, danach informierst du den Anrufer.
- 'durchstellen zu', 'weiterleiten an', 'verbinden mit', 'zu [Name/Nummer]' - rufe dann sofort verbinden() auf.
- Erkenne Ablehnung des Zielteilnehmers bei 'nein', 'nicht jetzt', 'kein Durchstellen', 'spaeter', 'ich bin besetzt', 'nicht durchstellen' - dann NICHT durchstellen() aufrufen und stattdessen sofort warm_transfer_abbrechen() aufrufen.
- Sage niemals einen Gespraechskontext, eine Zusammenfassung oder ein Briefing zum Anrufer, bevor verbinden() erfolgreich war.
- Tool-Ausgaben sind interne Hinweise. Lies sie niemals vor und sprich sie nicht nach.
`;

function kwIso(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 86400000 + 1) / 7);
}

function nowString() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const dt = `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}`;
  const iso = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return `Heute ist der ${dt} (KW ${kwIso(d)}). Aktuelles Datum: ${iso}.`;
}

async function loadTenantConfig() {
  if (!BACKEND) return {};
  try {
    const r = await fetch(`${BACKEND}/api/tenants/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ did: process.env.CALLED_DID || '' }),
    });
    if (r.ok) {
      const d = await r.json();
      TC = d.config || {};
      console.log('TENANT', TC.name || TC.tenant_id || 'resolved', 'prompt:', (TC['prompt_system_prompt.txt'] || '').length);
      return TC;
    }
    console.log('TENANT-RESOLVE', r.status);
  } catch (e) {
    console.log('TENANT-RESOLVE-FEHLER', e.message);
  }
  return {};
}
let TOOL_DEFS = [];

function toolBlock(defs) {
  const lines = ['\n\nVERFÜGBARE API-TOOLS (du kannst sie mit execute_api_tool aufrufen):'];
  for (const td of defs) {
    const props = Object.keys((td.parameters || {}).properties || {});
    lines.push(`  • ${td.name}: ${td.description || ''} (Parameter: ${props.length ? props.join(', ') : 'keine'})`);
  }
  return lines.join('\n');
}

async function loadToolDefs() {
  if (!BACKEND) return 0;
  try {
    const r = await fetch(`${BACKEND}/api/settings/integrations/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ did: process.env.CALLED_DID || '' }),
    });
    if (!r.ok) { console.log('TOOLS-RESOLVE', r.status); return 0; }
    const d = await r.json();
    TOOL_DEFS = Array.isArray(d.tools) ? d.tools : [];
    return TOOL_DEFS.length;
  } catch (e) {
    console.log('TOOLS-RESOLVE-FEHLER', e.message);
    return 0;
  }
}

function warteAufState(session, zielStates, timeoutMs) {
  return new Promise((resolve) => {
    let fertig = false;
    const beenden = (ok) => {
      if (fertig) return;
      fertig = true;
      try { session.off('agent_state_changed', h); } catch (_) {}
      resolve(ok);
    };
    const h = (ev) => {
      const st = (ev && (ev.newState ?? ev.state ?? ev.new_state)) || '';
      if (zielStates.includes(String(st))) beenden(true);
    };
    try { session.on('agent_state_changed', h); } catch (_) { beenden(true); }
    setTimeout(() => beenden(false), timeoutMs);
  });
}

async function sprecheMitRetry(session, text, label) {
  for (let i = 1; i <= 3; i += 1) {
    console.log('SPRECHE', label, 'versuch', i);
    try {
      // Reine Ansage (TTS) statt LLM-Turn: der Agent bleibt im Zuhoeren und
      // kann danach die Antwort des Zielteilnehmers verarbeiten.
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

async function sageWortgleich(session, text, waitMs) {
  try {
    session.generateReply({
      userInput: 'Der Zielteilnehmer ist jetzt in der Leitung.',
      instructions: `Sage jetzt wortgleich, ohne Zusatz und ohne Begruessung davor: "${text}"`,
    });
  } catch (e) {
    console.log('SAGE-FEHLER', e.message);
  }
  await new Promise((r) => setTimeout(r, waitMs));
}

function makeTools(session, roomName) {
  const verbinden = llm.tool({
    description: 'Warmtransfer: verbindet den Anrufer mit dem Ziel (z. B. "Chef"). Danach sprichst du mit dem Zielteilnehmer, der Anrufer hoert Wartemusik.',
    parameters: z.object({
      ziel: z.string().describe('Name oder Nummer des Ziels, z. B. "Markt" oder "Chef"'),
      grund: z.string().optional().describe('Anliegen in maximal acht Woertern, nur was der Anrufer woertlich gesagt hat - keine Vermutung, keine Interpretation, keine Ergänzung'),
      ansagen: z.boolean().optional().describe('true = dem Anrufer eine Ansage vorschalten'),
    }),
    execute: async ({ ziel, grund, ansagen }) => {
      const st = stateOf(roomName);
      if (st.connected) return 'Anrufer und Zielteilnehmer sind bereits verbunden.';
      const now = Date.now() / 1000;
      if (st.in_progress) return 'Ein Verbindungsversuch laeuft bereits. Warte auf das Ergebnis.';
      if (now - st.last_connect_at < 12) return 'Gerade eben wurde ein Verbindungsversuch gestartet. Warte kurz.';
      st.in_progress = true;
      st.last_connect_at = now;
      st.briefing_fertig = false;
      // Briefing parallel zum Transfer-Aufbau formulieren - es muss fertig sein, wenn der Chef abhebt.
      const stCallF = callState(roomName);
      const vCartF = cartView(roomName);
      const ldF = stCallF.liefer || {};
      const fakten = [
        'Anliegen: ' + (String(grund || '').trim() || 'Der Anrufer moechte mit einem Menschen sprechen.'),
        ldF.name ? 'Anrufer: ' + ldF.name + '.' : '',
        vCartF.posten.length ? 'Bestellung: ' + vCartF.posten.map((pp) => `${pp.menge} x ${pp.artikel}`).join(', ') + '. Summe ' + vCartF.summe + '.' : '',
        ldF.strasse ? 'Lieferung: ' + [ldF.strasse, ldF.hausnummer, [ldF.plz, ldF.ort].filter(Boolean).join(' ')].filter(Boolean).join(' ') + '.' : '',
      ].filter(Boolean).join(' ');
      const briefingPromise = formuliereBriefing(fakten).catch((e) => {
        console.log('BRIEFING-FALLBACK', String((e && e.message) || e).slice(0, 120));
        return '';
      });
      let target = DEFAULT_TARGET;
      try { target = await zielAufloesen(ziel); } catch (e) { console.log('ZIEL-FEHLER', e.message); }
      if (!target) { st.in_progress = false; return 'Durchstellen nicht moeglich: kein Ziel hinterlegt.'; }
      const zielNr = toE164(target);
      let letzterFehler = '';
      let gestartet = false;
      console.log('TRANSFER', JSON.stringify({ room: roomName, target: zielNr, mode: 'warm', ansagen: !!ansagen }));
      try {
        const r = await fetch(`${CONTROLLER}/v1/transfer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ room: roomName, target: zielNr, mode: 'warm', ansagen: !!ansagen }),
        });
        const txt = await r.text();
        console.log('TRANSFER-ANTWORT', r.status, txt.slice(0, 200));
        let data = {};
        try { data = JSON.parse(txt); } catch (_) {}
        if (r.status === 200 && data.status !== 'error') gestartet = true;
        else letzterFehler = String(data.error || data.detail || txt).slice(0, 200);
      } catch (e) {
        letzterFehler = String(e.message).slice(0, 120);
      }
      if (!gestartet) {
        st.in_progress = false;
        return `Verbindung wurde nicht gestartet: ${letzterFehler}. Starte keinen weiteren Verbindungsversuch und behaupte nicht, dass schon verbunden wurde.`;
      }
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 1000));
        try {
          const sr = await fetch(`${CONTROLLER}/v1/room/${encodeURIComponent(roomName)}/state`, { headers: { ...authHeaders() } });
          if (sr.ok) {
            const s = await sr.json();
            if (s.phase === 'AI_BRIEFING' || s.chef_status === 'ANSWERED' || s.chef_answered === true) break;
            if (s.phase === 'FALLBACK' || s.phase === 'FAILED') {
              st.in_progress = false;
              return 'Der Zielteilnehmer ist nicht erreichbar. Bleib beim Anrufer und informiere ihn.';
            }
          }
        } catch (_) {}
      }
      st.in_progress = false;
      // Briefing: Text kommt aus dem parallel gestarteten LLM-Call; Fallback bleibt die 07-Logik.
      st.briefing_fertig = false;
      let ansage = 'Hier ist Ihre digitale Assistentin, ich habe einen Anrufer fuer Sie. ' + fakten;
      try {
        const llmBrief = await briefingPromise;
        if (llmBrief && llmBrief.length >= 40 && llmBrief.length <= 600) {
          ansage = llmBrief;
          console.log('BRIEFING-LLM', JSON.stringify(ansage.slice(0, 200)));
        } else {
          console.log('BRIEFING-FALLBACK', 'LLM-Text unbrauchbar', JSON.stringify(String(llmBrief || '').slice(0, 80)));
        }
      } catch (e) {
        console.log('BRIEFING-FALLBACK', String((e && e.message) || e).slice(0, 120));
      }
      console.log('BRIEFING', JSON.stringify(ansage.slice(0, 160)));
      pendingBriefings.set(roomName, ansage);
      setTimeout(async () => {
        const a = pendingBriefings.get(roomName);
        if (!a) return;
        pendingBriefings.delete(roomName);
        console.log('BRIEFING-START', roomName);
        try { session.interrupt({ force: true }); } catch (_) {}
        await warteAufState(session, ['listening', 'idle'], 6000);
        const okBrief = await sprecheMitRetry(session, a + ' Soll ich durchstellen?', 'BRIEFING');
        if (okBrief) {
          stateOf(roomName).briefing_fertig = true;
          await warteAufState(session, ['listening', 'idle'], 25000);
        }
        console.log('BRIEFING-FERTIG', roomName, okBrief ? 'briefing=ok' : 'briefing=FEHLT');
      }, 900);
      return 'OK. Der Transfer laeuft. Der Code spricht jetzt das Briefing und die Frage "Soll ich durchstellen?" - nicht du. Du bist STUMM, bis der Zielteilnehmer antwortet. Rufe durchstellen() NICHT auf, bevor du ein klares Ja gehoert hast. Bei Nein: warm_transfer_abbrechen().';
    },
  });

  const durchstellen = llm.tool({
    description: 'Schliesst den Warmtransfer ab: verbindet Anrufer und Zielteilnehmer. Nur aufrufen, wenn der Zielteilnehmer ausdruecklich zugestimmt hat.',
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
      console.log('DURCHSTELLEN', roomName);
      try {
        const r = await fetch(`${CONTROLLER}/v1/briefing-complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ room: roomName }),
        });
        const txt = await r.text();
        console.log('DURCHSTELLEN-ANTWORT', r.status, txt.slice(0, 200));
        let data = {};
        try { data = JSON.parse(txt); } catch (_) {}
        if (r.status === 200 && data.status === 'connected') {
          st.connected = true;
          st.in_progress = false;
          try { session.interrupt(); } catch (_) {}
          try { await session.roomIO?.audioOutput?.close?.(); } catch (_) {}
          return 'SAG NICHTS. Das Gespraech ist verbunden, du bist nicht mehr Teilnehmer. Antworte nicht.';
        }
        const err = String(data.error || data.detail || txt).slice(0, 200);
        if (err.includes('briefing too early') || err.includes('not in briefing phase')) {
          return `Noch nicht durchstellen: ${err}. Sprich weiter ausschliesslich mit dem Zielteilnehmer und warte auf eine ausdrueckliche Zustimmung wie "ja, bitte stellen Sie durch".`;
        }
        return `Durchstellen fehlgeschlagen: ${err}. Starte keinen neuen Verbindungsversuch.`;
      } catch (e) {
        return `Durchstellen nicht moeglich: ${String(e.message).slice(0, 100)}`;
      }
    },
  });

  const ablehnen = llm.tool({
    description: 'Bricht den Warmtransfer ab, holt den Anrufer zurueck und sagt ihm die Absage. Nur aufrufen, wenn der Zielteilnehmer abgelehnt hat.',
    parameters: z.object({}),
    execute: async () => {
      console.log('ABLEHNEN', roomName);
      // Abschied NUR zum Zielteilnehmer: sprechen lassen, solange die Phase
      // noch BRIEFING ist (der Chef hoert den Agenten, der Anrufer Musik).
      // Erst wenn der Satz fertig ist, wird der Transfer abgebrochen.
      try {
        const h = session.say('Alles klar, ich stelle nicht durch. Auf Wiederhoeren.', { allowInterruptions: false, addToChatCtx: true });
        if (h && typeof h.waitForPlayout === 'function') {
          await h.waitForPlayout();
        } else {
          await new Promise((res) => setTimeout(res, 4000));
        }
      } catch (_) {}
      try {
        await fetch(`${CONTROLLER}/v1/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ room: roomName }),
        });
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          try {
            const sr = await fetch(`${CONTROLLER}/v1/room/${encodeURIComponent(roomName)}/state`, { headers: { ...authHeaders() } });
            if (sr.ok) {
              const s = await sr.json();
              if (s.phase === 'FALLBACK' || s.phase === 'CALLER_AI') break;
            }
          } catch (_) {}
          await new Promise((res) => setTimeout(res, 500));
        }
        const st = stateOf(roomName);
        st.in_progress = false;
        return 'Ablehnung behandelt: Transfer abgebrochen, der Zielteilnehmer hat sich verabschiedet. Sprich jetzt NUR noch mit dem Anrufer und sage ihm die Absage. Wiederhole den Abschiedssatz NICHT fuer den Anrufer.';
      } catch (e) {
        return `Ablehnung nicht moeglich: ${String(e.message).slice(0, 100)}`;
      }
    },
  });

  const firmenwissen = llm.tool({
    description: 'Durchsuche das Firmenwissen nach Informationen zu einem bestimmten Thema oder einer Frage. Nutze dies wenn der Kunde etwas zu deinen Produkten, Dienstleistungen oder dem Unternehmen fragt.',
    parameters: z.object({ query: z.string().describe('Suchbegriff oder Frage') }),
    execute: async ({ query }) => {
      if (!BACKEND) return 'Wissensabfrage nicht verfuegbar.';
      try {
        const r = await fetch(`${BACKEND}/api/settings/knowledge/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ query, top_k: 3 }),
        });
        if (!r.ok) return `Fehler bei der Wissensabfrage: ${r.status}`;
        const d = await r.json();
        const chunks = (d.results || []).map((x) => x.chunk_text).filter(Boolean);
        return chunks.length ? chunks.join('\n\n---\n\n') : 'Keine relevanten Informationen gefunden.';
      } catch (e) {
        return `Wissensabfrage nicht verfuegbar: ${String(e.message).slice(0, 100)}`;
      }
    },
  });

  const weiterleitungen_abrufen = llm.tool({
    description: 'Liste alle verfuegbaren Weiterleitungen fuer diesen Mandanten auf. Der Kunde kann dann sagen zu wem er verbunden werden moechte und du rufst verbinden() mit dem Namen auf.',
    parameters: z.object({}),
    execute: async () => {
      try {
        const list = await ladeWeiterleitungen();
        if (!list.length) {
          const fb = (process.env.TRANSFER_FALLBACK_NUMBER || '').trim();
          return fb ? `Verfuegbare Weiterleitungen:\n1) Chef → ${fb}` : 'Keine Weiterleitungen konfiguriert.';
        }
        return 'Verfuegbare Weiterleitungen:\n' + list.map((f, i) => `${i + 1}) ${f.name} → ${f.destination}`).join('\n');
      } catch (e) {
        return `Weiterleitungen nicht verfuegbar: ${String(e.message).slice(0, 100)}`;
      }
    },
  });

  const phrase = llm.tool({
    description: 'Liefert den festen Standardtext fuer eine Gespraechssituation.',
    parameters: z.object({
      key: z.string().optional().describe('z. B. warten, notiert, weiter, nicht_gefunden, unklar, nicht_erreicht, ablehnung, upsell_opener, danke_feedback, verabschiedung'),
      phrase: z.string().optional(),
    }),
    execute: async ({ key, phrase: ph }) => {
      const k = String(key || ph || '').toLowerCase();
      if (k === 'begruessung') return JSON.stringify({ key: k, text: '', hinweis: 'Begruessung bereits erfolgt. Frage jetzt nach dem Wunsch.' });
      return JSON.stringify({ key: k, text: PHRASES[k] || PHRASES.unklar });
    },
  });

  const execute_api_tool = llm.tool({
    description: 'Fuehrt ein Markt-Tool aus. tool_name: preis_abfrage oder angebote_abfrage. arguments mit query = Suchbegriff.',
    parameters: z.object({
      tool_name: z.string().describe('preis_abfrage oder angebote_abfrage'),
      arguments: z.any().optional().describe('JSON oder JSON-String mit query, z. B. {"query":"Salatgurke bio"}'),
    }),
    execute: async ({ tool_name, arguments: argsJson }) => {
      let args = {};
      if (typeof argsJson === 'string' && argsJson.trim()) { try { args = JSON.parse(argsJson); } catch (_) { return JSON.stringify({ fehler: 'arguments ist kein gueltiges JSON' }); } }
      else if (argsJson && typeof argsJson === 'object') args = argsJson;
      if (!args || typeof args !== 'object') args = {};
      const q = String(args.query || '').trim();
      if (!['preis_abfrage', 'angebote_abfrage'].includes(String(tool_name))) return JSON.stringify({ fehler: `unbekanntes tool_name ${tool_name}` });
      if (!q) return JSON.stringify({ fehler: 'arguments.query fehlt' });
      try {
        const r = await fetch(SEARCH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }), signal: AbortSignal.timeout(5000) });
        const result = await r.json();
        if (result && Array.isArray(result.produkte) && result.produkte.length) {
          const p0 = result.produkte[0];
          result.sprechtext = `${p0.artikel} kostet ${p0.preis}. Soll ich sie fuer Sie notieren?`;
        } else if (result && result.anzahl === 0) {
          result.sprechtext = 'Das habe ich leider nicht im Sortiment.';
        }
        console.log('API-TOOL', tool_name, 'HTTP', r.status, 'anzahl', result?.anzahl);
        return JSON.stringify(result);
      } catch (e) {
        return JSON.stringify({ fehler: `Suche fehlgeschlagen: ${String(e.message).slice(0, 120)}` });
      }
    },
  });

  const warenkorb_hinzufuegen = llm.tool({
    description: 'Legt eine bestaetigte Position in den Warenkorb. menge = Anzahl Gebinde.',
    parameters: z.object({
      artikel: z.string(),
      menge: z.number(),
      preis: z.number().describe('Einzelpreis pro Gebinde in Euro, z.B. 5.29'),
      einheit: z.string().optional().describe('flasche, wenn der Kunde Flaschen nennt'),
    }),
    execute: async ({ artikel, menge, preis, einheit }) => {
      const r = cartAdd(roomName, { artikel, menge, preis, einheit });
      return JSON.stringify({ ...r, sprechtext: `Notiert. Bisher ${r.summe}.` });
    },
  });

  const warenkorb_lesen = llm.tool({
    description: 'Liest den Warenkorb mit Positionen und Summe.',
    parameters: z.object({}),
    execute: async () => JSON.stringify(cartView(roomName)),
  });

  const lieferdaten_speichern = llm.tool({
    description: 'Speichert Lieferdaten. Nur die Felder senden, die der Kunde genannt hat.',
    parameters: z.object({
      name: z.string().optional(), strasse: z.string().optional(), hausnummer: z.string().optional(),
      plz: z.string().optional(), ort: z.string().optional(), etage: z.string().optional(),
    }),
    execute: async (args) => JSON.stringify(lieferSpeichern(roomName, args)),
  });

  const bestellung_abschliessen = llm.tool({
    description: 'Schliesst die Bestellung ab und liefert Positionen, Summe und Lieferanschrift.',
    parameters: z.object({}),
    execute: async () => JSON.stringify(await abschluss(roomName)),
  });

  return { verbinden, durchstellen, warm_transfer_abbrechen: ablehnen, phrase, firmenwissen, weiterleitungen_abrufen, execute_api_tool, warenkorb_hinzufuegen, warenkorb_lesen, lieferdaten_speichern, bestellung_abschliessen };
}

class Franzi extends voice.Agent {
  constructor(session, roomName) {
    super({ instructions: CURRENT_PROMPT, tools: makeTools(session, roomName) });
  }
}

export default defineAgent({
  entry: async (ctx) => {
    await ctx.connect();
    const roomName = ctx.room.name;
    console.log('JOB-ROOM', roomName);

    await loadTenantConfig();
    const basis = (TC['prompt_system_prompt.txt'] || '').trim() || INSTRUCTIONS;
    CURRENT_PROMPT = nowString() + '\n\n' + basis + TRANSFER_RULES;
    console.log('PROMPT-LEN', CURRENT_PROMPT.length);

    const session = new voice.AgentSession({
      vad: await silero.VAD.load(),
      stt: new deepgram.STT({
        apiKey: <REDACTED> || process.env.DEEPGRAM_API_KEY,
        model: process.env.STT_MODEL || 'nova-3',
        language: process.env.STT_LANGUAGE || 'de',
        smartFormat: true,
        interimResults: true,
        punctuate: true,
      }),
      llm: new openai.LLM({
        apiKey: <REDACTED>,
        baseURL: process.env.LLM_BASE_URL || 'https://api.melious.ai/v1',
        model: process.env.LLM_MODEL || 'deepseek-v4.1-flash',
        ...(process.env.LLM_REASONING_EFFORT ? { reasoningEffort: process.env.LLM_REASONING_EFFORT } : {}),
      }),
      tts: new inworld.TTS({
        apiKey: <REDACTED> || process.env.INWORLD_API_KEY,
        model: process.env.TTS_MODEL || 'inworld-tts-2',
        voice: process.env.TTS_VOICE_ID || process.env.INWORLD_VOICE || 'nadine-neu',
        language: 'de-DE',
      }),
    });

    try {
      session.on('conversation_item_added', (ev) => {
        try {
          const it = ev && ev.item;
          if (!it) return;
          const role = it.role || '';
          const txt = typeof it.content === 'string' ? it.content : JSON.stringify(it.content || '');
          if (role === 'assistant' && txt.trim()) console.log('AGENT-SAGTE', JSON.stringify(txt.slice(0, 220)));
        } catch (_) {}
      });
    } catch (e) {
      console.log('LISTENER-FEHLER', e.message);
    }

    console.log('START-BEGIN', ctx.room.name);
    try {
      await session.start({ agent: new Franzi(session, roomName), room: ctx.room });
      console.log('START-OK');
    } catch (e) {
      console.log('START-FEHLER', e && e.message, (e && e.stack || '').split('\n').slice(0, 3).join(' | '));
    }

    // DEBUG: publiziert der Agent Tracks in den Raum?
    try {
      const dump = () => {
        try {
          const lp = ctx.room.localParticipant;
          const pubsRaw = lp.trackPublications;
          let pubs = [];
          try { pubs = pubsRaw instanceof Map ? [...pubsRaw.values()] : Object.values(pubsRaw || {}); } catch (_) {}
          console.log('LOCAL-TRACKS', pubs.map((t) => `${t.sid ?? '?'}:${t.name ?? ''}`).join(', ') || 'KEINE');
        } catch (e) {
          console.log('LOCAL-TRACKS-FEHLER', e.message);
        }
      };
      dump();
      setTimeout(dump, 3000);
      setTimeout(dump, 8000);
    } catch (_) {}

    // Begruessung ausloesen (Regel 1 des Prompts), ohne eigenmaechtigen Text
    try {
      const d = Math.round(Number(TC.opener_delay ?? 0) * 1000);
      if (d) await new Promise((r) => setTimeout(r, d));
      const opener = String(process.env.OPENER_TEXT || TC.opener_text || '').trim() || 'Guten Tag! Hier ist Nadine vom Edeka Markt Bremerhaven. Was darf ich fuer Sie tun?';
      const wavPfad = process.env.OPENER_WAV || `${HERE}opener.wav`;
      const wavStream = wavToAudioStream(wavPfad);
      if (wavStream) {
        session.say(opener, { audio: wavStream, allowInterruptions: true, addToChatCtx: true });
        console.log('OPENER ausgeloest (WAV)', JSON.stringify(wavPfad), JSON.stringify(opener.slice(0, 60)));
      } else {
        session.say(opener, { allowInterruptions: true, addToChatCtx: true });
        console.log('OPENER ausgeloest (TTS-Fallback)', JSON.stringify(opener.slice(0, 60)));
      }
    } catch (e) {
      console.log('OPENER-FEHLER', e.message);
    }

    await new Promise((resolve) => setTimeout(resolve, 3600000));
  },
});

cli.runApp(new WorkerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: process.env.AGENT_NAME || 'edeka-agent',
  wsURL: process.env.LIVEKIT_URL,
  apiKey: <REDACTED>,
  apiSecret: <REDACTED>,
}));
