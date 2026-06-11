#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   ESO pastočių duomenų kasdienis atnaujinimas
   ═══════════════════════════════════════════════════════════════

   Ką daro šis skriptas:
     1. Parsisiunčia 4 sluoksnių duomenis iš ArcGIS FeatureServer API
        (nuorodos — scripts/api_urls.json, paimtos iš
        „Linkai ESO pastociu.xlsx").
     2. Palygina naujus duomenis su esamais Data/*.json failais
        (tik dominančius laukus, žr. DATASETS.watch).
     3. Perrašo Data/*.json failus naujais duomenimis
        (formatas paliekamas toks pat — žemėlapio kodas nekeičiamas).
     4. Sugeneruoja Data/change_log.json pokyčių žurnalą frontend'ui.

   Paleidimas lokaliai:   node scripts/update_data.js
   Reikalavimai:          Node.js >= 18 (naudojamas built-in fetch),
                          jokių npm priklausomybių.
*/

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT     = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'Data');
const URLS_F   = path.join(__dirname, 'api_urls.json');
const LOG_F    = path.join(DATA_DIR, 'change_log.json');

/* Kiek paskutinių paleidimų istorijos saugoti change_log.json faile */
const HISTORY_LIMIT = 30;

/* ─────────────────────────────────────────────────────────────
   SLUOKSNIŲ KONFIGŪRACIJA
   ─────────────────────────────────────────────────────────────
   keyOf  — stabilus objekto identifikatorius palyginimui.
            OBJECTID ArcGIS sluoksniuose gali pasikeisti perpublikavus
            servisą, todėl pirmenybė teikiama pavadinimui:
              · 35 kV  → nameproduct + transformatorius (F35kV_TP_GT),
                         nes ta pati pastotė turi T-1 ir T-2 įrašus;
              · 110 kV → PAS_PAVADINIMAS.
            Jei pavadinimo nėra — krentama atgal į OBJECTID_1.
   watch  — laukai, kurių pokyčiai registruojami žurnale.
*/
const DATASETS = [
  {
    file:    '35 kV.json',
    layer:   '35 kV VE ESO',
    voltage: '35 kV',
    keyOf:  a => (a.nameproduct != null && a.F35kV_TP_GT != null)
                   ? `${a.nameproduct}|${a.F35kV_TP_GT}`
                   : (a.nameproduct != null ? String(a.nameproduct) : `OID:${a.OBJECTID_1}`),
    nameOf: a => [a.nameproduct, a.F35kV_TP_GT].filter(v => v != null && v !== '').join(' '),
    watch: [
      'Laisva_galia_35110_surib',
      'TPlanksti_laisvaN1',
      'Laisva_galia_EK\u012e_vir\u0161balansin\u0117',   // Laisva_galia_EKĮ_viršbalansinė
    ],
  },
  {
    file:    'ESO_yra_Litgrid_yra.json',
    layer:   '110 kV — ESO laisva yra, Litgrid yra',
    voltage: '110 kV',
    keyOf:  a => a.PAS_PAVADINIMAS != null ? String(a.PAS_PAVADINIMAS) : `OID:${a.OBJECTID_1}`,
    nameOf: a => a.PAS_PAVADINIMAS || `OBJECTID ${a.OBJECTID_1}`,
    watch: ['LaisvaSUN1', 'SuN1naktine', 'LaisvaEEKI', 'INV_metai'],
  },
  {
    file:    'ESO_yra_Litgrid_nera.json',
    layer:   '110 kV — ESO laisva yra, Litgrid n\u0117ra',
    voltage: '110 kV',
    keyOf:  a => a.PAS_PAVADINIMAS != null ? String(a.PAS_PAVADINIMAS) : `OID:${a.OBJECTID_1}`,
    nameOf: a => a.PAS_PAVADINIMAS || `OBJECTID ${a.OBJECTID_1}`,
    watch: ['LaisvaSUN1', 'SuN1naktine', 'LaisvaEEKI', 'INV_metai'],
  },
  {
    file:    'ESO_nevaldoma.json',
    layer:   '110 kV — nevaldoma / saugios generacijos riba',
    voltage: '110 kV',
    keyOf:  a => a.PAS_PAVADINIMAS != null ? String(a.PAS_PAVADINIMAS) : `OID:${a.OBJECTID_1}`,
    nameOf: a => a.PAS_PAVADINIMAS || `OBJECTID ${a.OBJECTID_1}`,
    watch: ['LaisvaSUN1', 'SuN1naktine', 'LaisvaEEKI', 'INV_metai'],
  },
];

/* ─────────────────────────────────────────────────────────────
   REIKŠMIŲ PALYGINIMAS
   ─────────────────────────────────────────────────────────────
   "12.5" (string) ir 12.5 (number) laikomi LYGIAIS.
   null / undefined laikomi lygiais tarpusavyje.
   Skaičiai lyginami su maža paklaida dėl float formato.
*/
function valuesEqual(a, b) {
  const aEmpty = (a === null || a === undefined || a === '');
  const bEmpty = (b === null || b === undefined || b === '');
  if (aEmpty && bEmpty) return true;
  if (aEmpty !== bEmpty) return false;

  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    return Math.abs(na - nb) < 1e-9;
  }
  return String(a).trim() === String(b).trim();
}

/* Normalizuota reikšmė žurnalui (kad string "12.5" būtų saugomas kaip 12.5) */
function normValue(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

/* ─────────────────────────────────────────────────────────────
   ARCGIS FEATURESERVER UŽKLAUSA (su puslapiavimu)
   ─────────────────────────────────────────────────────────────
   Priima ir "plikas" sluoksnio nuorodas (.../FeatureServer/0),
   ir pilnas query nuorodas (.../FeatureServer/0/query?...).
*/
async function fetchArcgis(rawUrl) {
  const base = rawUrl.includes('/query')
    ? rawUrl
    : rawUrl.replace(/\/+$/, '') + '/query';

  let offset = 0;
  let meta = null;
  const allFeatures = [];

  for (;;) {
    const u = new URL(base);
    if (!u.searchParams.get('where'))     u.searchParams.set('where', '1=1');
    u.searchParams.set('outFields', '*');
    u.searchParams.set('f', 'json');
    u.searchParams.set('returnGeometry', 'true');
    if (offset > 0) u.searchParams.set('resultOffset', String(offset));

    const res = await fetch(u, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${u.href}`);
    }
    const json = await res.json();
    if (json.error) {
      throw new Error(`ArcGIS klaida: ${JSON.stringify(json.error)} — ${u.href}`);
    }
    if (!Array.isArray(json.features)) {
      throw new Error(`Atsakyme n\u0117ra "features" masyvo — ${u.href}`);
    }

    allFeatures.push(...json.features);
    if (!meta) meta = json;

    if (json.exceededTransferLimit && json.features.length > 0) {
      offset += json.features.length;       // kitas puslapis
    } else {
      break;
    }
  }

  meta.features = allFeatures;
  return meta;
}

/* ─────────────────────────────────────────────────────────────
   SENŲ IR NAUJŲ DUOMENŲ PALYGINIMAS
*/
function buildIndex(json, ds) {
  const map = new Map();
  (json.features || []).forEach(f => {
    const attrs = f.attributes || {};
    map.set(ds.keyOf(attrs), attrs);
  });
  return map;
}

function diffDataset(oldJson, newJson, ds, timestamp) {
  const changes = [];
  if (!oldJson) return changes;            // pirmas paleidimas — nėra su kuo lyginti

  const oldMap = buildIndex(oldJson, ds);
  const newMap = buildIndex(newJson, ds);

  for (const [key, newAttrs] of newMap) {
    const oldAttrs = oldMap.get(key);

    if (!oldAttrs) {
      changes.push({
        type: 'added',
        name: ds.nameOf(newAttrs),
        voltage: ds.voltage,
        layer: ds.layer,
        file: ds.file,
        field: null,
        old_value: null,
        new_value: null,
        timestamp,
      });
      continue;
    }

    for (const field of ds.watch) {
      if (!valuesEqual(oldAttrs[field], newAttrs[field])) {
        changes.push({
          type: 'changed',
          name: ds.nameOf(newAttrs),
          voltage: ds.voltage,
          layer: ds.layer,
          file: ds.file,
          field,
          old_value: normValue(oldAttrs[field]),
          new_value: normValue(newAttrs[field]),
          timestamp,
        });
      }
    }
  }

  for (const [key, oldAttrs] of oldMap) {
    if (!newMap.has(key)) {
      changes.push({
        type: 'removed',
        name: ds.nameOf(oldAttrs),
        voltage: ds.voltage,
        layer: ds.layer,
        file: ds.file,
        field: null,
        old_value: null,
        new_value: null,
        timestamp,
      });
    }
  }

  return changes;
}

/* ─────────────────────────────────────────────────────────────
   MAIN
*/
async function main() {
  if (!fs.existsSync(URLS_F)) {
    console.error('Tr\u016bksta scripts/api_urls.json — \u012fra\u0161ykite API nuorodas i\u0161 "Linkai ESO pastociu.xlsx".');
    process.exit(1);
  }
  const urls = JSON.parse(fs.readFileSync(URLS_F, 'utf8'));
  const now  = new Date().toISOString();

  const allChanges = [];
  let updatedAnything = false;

  for (const ds of DATASETS) {
    const url = urls[ds.file];
    if (!url || /PASTE|\u012eKLIJUOK/i.test(url)) {
      console.warn(`[praleista] ${ds.file} — n\u0117ra API nuorodos api_urls.json faile.`);
      continue;
    }

    console.log(`[siun\u010diama] ${ds.file} \u2190 ${url}`);
    const fresh = await fetchArcgis(url);

    const filePath = path.join(DATA_DIR, ds.file);
    let old = null;
    if (fs.existsSync(filePath)) {
      try {
        old = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        console.warn(`[\u012fsp\u0117jimas] nepavyko perskaityti seno ${ds.file}: ${e.message}`);
      }
    }

    const changes = diffDataset(old, fresh, ds, now);
    allChanges.push(...changes);
    console.log(`[palyginta] ${ds.file}: ${changes.length} poky\u010di(\u0173), objekt\u0173: ${fresh.features.length}`);

    fs.writeFileSync(filePath, JSON.stringify(fresh, null, 2), 'utf8');
    updatedAnything = true;
  }

  /* — Žurnalo failas — */
  let log = { last_update: null, changes: [], history: [] };
  if (fs.existsSync(LOG_F)) {
    try { log = JSON.parse(fs.readFileSync(LOG_F, 'utf8')); } catch (e) { /* pradedame iš naujo */ }
  }
  if (!Array.isArray(log.history)) log.history = [];

  log.last_update = now;
  log.changes = allChanges;
  log.history.unshift({ timestamp: now, changes_count: allChanges.length, changes: allChanges });
  log.history = log.history.slice(0, HISTORY_LIMIT);

  fs.writeFileSync(LOG_F, JSON.stringify(log, null, 2), 'utf8');

  console.log('────────────────────────────────────');
  console.log(`Atnaujinta: ${now}`);
  console.log(`I\u0161 viso poky\u010di\u0173: ${allChanges.length}`);
  if (!updatedAnything) {
    console.warn('N\u0117 vienas sluoksnis nebuvo atnaujintas — patikrinkite api_urls.json.');
    process.exitCode = 2;
  }
}

/* Eksportai testavimui; main() paleidžiamas tik kai skriptas
   vykdomas tiesiogiai (node scripts/update_data.js). */
module.exports = { valuesEqual, diffDataset, DATASETS };

if (require.main === module) {
  main().catch(err => {
    console.error('KLAIDA:', err);
    process.exit(1);
  });
}
