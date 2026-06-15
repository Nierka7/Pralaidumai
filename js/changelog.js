/* ═══════════════════════════════════════════════════════════════
   POKYČIŲ ŽURNALAS — atskiras frontend modulis
   ═══════════════════════════════════════════════════════════════

   Integracija: index.html faile, prieš </body>, pridėti VIENĄ eilutę:

       <script src="js/changelog.js"></script>

   Modulis NIEKO nekeičia esamoje žemėlapio / filtrų / popup logikoje:
     • pats įterpia savo CSS (naudoja tas pačias --bg2/--border/--accent
       spalvų kintamąsias, tad automatiškai seka tamsią/šviesią temą);
     • pats sukuria panelę dešinėje #map-wrap pusėje;
     • nuskaito Data/change_log.json, kurį generuoja
       scripts/update_data.js (GitHub Actions kasdien).

   Jei pokyčių per paskutinį atnaujinimą nėra — rodoma žinutė
   „Pokyčių per paskutinį atnaujinimą nerasta".
*/
(function () {
  'use strict';

  var LOG_URL = 'Data/change_log.json';

  /* Žmogui suprantami stebimų laukų pavadinimai */
  var FIELD_LABELS = {
    'LaisvaSUN1':                      'Laisva galia su N-1, MW',
    'SuN1naktine':                     'Laisva galia LP + N-1, MW',
    'LaisvaEEKI':                      'Laisva galia EEK\u012e, MW',
    'INV_metai':                       'Rekonstrukcijos metai',
    'Laisva_galia_35110_surib':        'Laisva galia su ribojimu (35/110), MW',
    'TPlanksti_laisvaN1':              'Lanksti laisva galia N-1, MW',
    'Laisva_galia_EK\u012e_vir\u0161balansin\u0117': 'Laisva galia EK\u012e vir\u0161balansin\u0117, MW',
    /* Litgrid 110/330 kV laukai — pavadinimai sutampa su index.html popup'ais */
    'Laisva_prijungimo_galia_SE': 'Laisva prijungimo galia LITGRID tinkle SE, MW',
    'Laisva_prijungimo_galia_VE': 'Laisva prijungimo galia LITGRID tinkle VE, MW',
    'Laisva_galia_kaupikliams':   'Laisva prijungimo galia LITGRID tinkle EEK\u012e generavimui / kaupikliams, MW',
  };

  /* ── 1. CSS įterpimas ─────────────────────────────────────── */
  var css = ''
    + '#changelog-panel{position:absolute;top:12px;right:12px;z-index:1000;'
    + 'background:var(--popup-bg);border:1px solid var(--border);border-radius:10px;'
    + 'box-shadow:0 4px 20px var(--shadow);width:300px;max-height:calc(100% - 24px);'
    + 'display:flex;flex-direction:column;overflow:hidden;'
    + 'transition:background .25s,border-color .25s;}'
    + '#changelog-head{display:flex;align-items:center;justify-content:space-between;'
    + 'padding:11px 14px;cursor:pointer;user-select:none;border-bottom:1px solid var(--border);}'
    + '#changelog-head .cl-title{font-size:10px;font-weight:700;text-transform:uppercase;'
    + 'letter-spacing:1.2px;color:var(--muted);}'
    + '#changelog-head .cl-toggle{font-size:11px;color:var(--accent);font-weight:700;}'
    + '#changelog-sub{padding:7px 14px;font-size:10px;color:var(--muted);'
    + 'border-bottom:1px solid var(--border);}'
    + '#changelog-body{overflow-y:auto;padding:8px 10px;flex:1;}'
    + '#changelog-panel.collapsed #changelog-body,'
    + '#changelog-panel.collapsed #changelog-sub{display:none;}'
    + '#changelog-panel.collapsed{width:auto;}'
    + '.cl-empty{padding:14px 6px;font-size:12px;color:var(--muted);'
    + 'font-style:italic;text-align:center;}'
    + '.cl-item{border:1px solid var(--border);border-radius:8px;'
    + 'padding:8px 10px;margin-bottom:8px;font-size:11px;line-height:1.55;}'
    + '.cl-item-name{font-size:12px;font-weight:700;color:var(--accent);margin-bottom:3px;}'
    + '.cl-badges{margin-bottom:5px;}'
    + '.cl-badge{display:inline-block;padding:1px 6px;margin-right:4px;border-radius:4px;'
    + 'font-size:9px;font-weight:700;letter-spacing:.4px;'
    + 'background:var(--btn-active);color:var(--accent);}'
    + '.cl-field{color:var(--text2);font-weight:600;}'
    + '.cl-vals{margin-top:2px;}'
    + '.cl-old{color:var(--muted);text-decoration:line-through;}'
    + '.cl-arrow{color:var(--muted);margin:0 5px;}'
    + '.cl-new{color:var(--text2);font-weight:700;}'
    + '.cl-time{margin-top:4px;font-size:9px;color:var(--muted);}'
    + '.cl-layer{font-size:9px;color:var(--muted);margin-top:2px;word-break:break-word;}'
    + '@media (max-width:700px){#changelog-panel{width:230px;}}';

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  /* ── 2. Panelės DOM ───────────────────────────────────────── */
  var wrap = document.getElementById('map-wrap') || document.body;

  var panel = document.createElement('div');
  panel.id = 'changelog-panel';
  panel.innerHTML =
      '<div id="changelog-head">'
    +   '<span class="cl-title">Poky\u010di\u0173 \u017eurnalas</span>'
    +   '<span class="cl-toggle" id="changelog-toggle">\u25BE</span>'
    + '</div>'
    + '<div id="changelog-sub">Kraunama\u2026</div>'
    + '<div id="changelog-body"></div>';
  wrap.appendChild(panel);

  document.getElementById('changelog-head').addEventListener('click', function () {
    panel.classList.toggle('collapsed');
    document.getElementById('changelog-toggle').textContent =
      panel.classList.contains('collapsed') ? '\u25B8' : '\u25BE';
  });

  /* ── 3. Pagalbinės funkcijos ──────────────────────────────── */
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function fmtVal(v) {
    if (v === null || v === undefined || v === '') return '\u2014';
    if (typeof v === 'number') {
      return Number.isInteger(v) ? String(v) : v.toFixed(2);
    }
    return esc(v);
  }

  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleString('lt-LT', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
    } catch (e) { return iso || ''; }
  }

  function renderItem(ch) {
    var fieldLabel = ch.field ? (FIELD_LABELS[ch.field] || ch.field) : null;
    var body = '';

    if (ch.type === 'added') {
      body = '<div class="cl-vals"><span class="cl-new">Naujas objektas duomenyse</span></div>';
    } else if (ch.type === 'removed') {
      body = '<div class="cl-vals"><span class="cl-old" style="text-decoration:none;">Objektas pa\u0161alintas i\u0161 duomen\u0173</span></div>';
    } else {
      body =
          '<div class="cl-field">' + esc(fieldLabel) + '</div>'
        + '<div class="cl-vals">'
        +   '<span class="cl-old">' + fmtVal(ch.old_value) + '</span>'
        +   '<span class="cl-arrow">\u2192</span>'
        +   '<span class="cl-new">' + fmtVal(ch.new_value) + '</span>'
        + '</div>';
    }

    return ''
      + '<div class="cl-item">'
      +   '<div class="cl-item-name">' + esc(ch.name || 'Nenurodyta') + '</div>'
      +   '<div class="cl-badges">'
      +     '<span class="cl-badge">' + esc(ch.voltage || '') + '</span>'
      +     '<span class="cl-badge">' + esc(ch.file || '') + '</span>'
      +   '</div>'
      +   body
      +   '<div class="cl-layer">' + esc(ch.layer || '') + '</div>'
      +   '<div class="cl-time">' + fmtTime(ch.timestamp) + '</div>'
      + '</div>';
  }

  /* ── 4. Žurnalo užkrovimas ────────────────────────────────── */
  function loadChangeLog() {
    var sub  = document.getElementById('changelog-sub');
    var body = document.getElementById('changelog-body');

    /* cache-bust, kad GitHub Pages neatiduotų seno failo */
    fetch(LOG_URL + '?t=' + Date.now())
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (log) {
        sub.textContent = log.last_update
          ? 'Paskutinis atnaujinimas: ' + fmtTime(log.last_update)
          : 'Atnaujinimo data ne\u017einoma';

        var changes = Array.isArray(log.changes) ? log.changes : [];
        if (changes.length === 0) {
          body.innerHTML =
            '<div class="cl-empty">Poky\u010di\u0173 per paskutin\u012f atnaujinim\u0105 nerasta</div>';
          return;
        }
        body.innerHTML = changes.map(renderItem).join('');
      })
      .catch(function (err) {
        /* Failo dar nėra (pirmas paleidimas) arba tinklo klaida —
           panelė neturi trukdyti žemėlapiui veikti. */
        console.warn('Poky\u010di\u0173 \u017eurnalas nepasiekiamas:', err);
        sub.textContent = '\u017durnalas dar nesugeneruotas';
        body.innerHTML =
          '<div class="cl-empty">Poky\u010di\u0173 \u017eurnalas atsiras po pirmo automatinio atnaujinimo (Data/change_log.json)</div>';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadChangeLog);
  } else {
    loadChangeLog();
  }
})();
