/**
 * Trockentest ohne Telefonie: drei Fakten-Faelle durch das LLM, Ausgabe der Briefings.
 *
 *   LLM_API_KEY=... node test-briefing.mjs
 *
 * Liest LLM_BASE_URL / LLM_MODEL / LLM_API_KEY aus der Umgebung
 * (oder aus einer .env, wenn sie per --env-file geladen wird).
 */
import { baueFakten, formuliereBriefing, briefingBrauchbar } from './briefing.mjs';

const FAELLE = [
  {
    label: 'Bestellung mit Lieferung',
    fakten: baueFakten({
      grund: 'Frage zur Bestellung',
      name: 'Frau Meier',
      posten: [{ menge: 2, artikel: 'Vollmilch' }, { menge: 1, artikel: 'Butter' }],
      summe: '12,40 Euro',
      strasse: 'Hauptstrasse', hausnummer: '5', plz: '28195', ort: 'Bremen',
    }),
  },
  {
    label: 'Nur Anliegen, keine Daten',
    fakten: baueFakten({ grund: 'Der Anrufer moechte mit einem Menschen sprechen.' }),
  },
  {
    label: 'Beschwerde',
    fakten: baueFakten({
      grund: 'Beschwerde ueber die letzte Lieferung',
      name: 'Herr Yilmaz',
      strasse: 'Am Wall', hausnummer: '12', plz: '28195', ort: 'Bremen',
    }),
  },
];

let fehler = 0;
for (const f of FAELLE) {
  const t0 = Date.now();
  const text = await formuliereBriefing(f.fakten);
  const ms = Date.now() - t0;
  const ok = briefingBrauchbar(text);
  if (!ok) fehler += 1;
  console.log(`\n${f.label}  (${ms} ms, ${text.length} Zeichen, ${ok ? 'OK' : 'FALLBACK'})`);
  console.log(`  FAKTEN:   ${f.fakten}`);
  console.log(`  BRIEFING: ${text || '(leer -> Fallback greift)'}`);
}

console.log(`\n${FAELLE.length - fehler}/${FAELLE.length} brauchbar`);
process.exit(fehler === 0 ? 0 : 1);
