/* Lenta: YouTube (m.youtube.com) ranglarini almashtirish.
   YouTube o'zgaruvchi nomlarini shifrlaydi (--t3e41...), shuning uchun ularni nomi bo'yicha emas,
   QIYMATI bo'yicha topamiz: fon, matn, qizil urg'u va havola ranglari. */
(function () {
  var C = __CFG__;
  var T = {
    gold:   { bg: '#000000', bg2: '#141416', tx: '#F5F5F5', tx2: '#A1A1AA', ac: '#F7A70B', ln: '#FFC94D' },
    violet: { bg: '#07050D', bg2: '#191128', tx: '#F3EEFF', tx2: '#A99DC4', ac: '#A855F7', ln: '#C084FC' },
    ocean:  { bg: '#03101A', bg2: '#0F2335', tx: '#E8F4FF', tx2: '#8FB0C8', ac: '#22D3EE', ln: '#67E8F9' },
    rose:   { bg: '#0D0507', bg2: '#231017', tx: '#FFEFF3', tx2: '#C99BA7', ac: '#FB7185', ln: '#FDA4AF' },
    mint:   { bg: '#020D09', bg2: '#0D2117', tx: '#EAFFF4', tx2: '#8DBBA4', ac: '#34D399', ln: '#6EE7B7' }
  };
  var RED = /^(#f00|#ff0000|#ff0033|#f03|#cc0000|#c00|#e62117|#ff4e45|rgb\(255,\s*0,\s*0\)|rgb\(255,\s*0,\s*51\)|rgb\(204,\s*0,\s*0\))$/i;
  var LINK = /^(#3ea6ff|#065fd4|#1c62b9|rgb\(62,\s*166,\s*255\)|rgb\(6,\s*95,\s*212\))$/i;
  var map = null;
  function norm(v) { return (v || '').trim().toLowerCase(); }
  function discover() {
    var root = document.documentElement; if (!root || !document.body) return null;
    var cs = getComputedStyle(root), bodyCs = getComputedStyle(document.body);
    var bgNow = norm(cs.backgroundColor), txNow = norm(cs.color);
    var m = { bg: [], tx: [], ac: [], ln: [], tx2: [] };
    for (var i = 0; i < cs.length; i++) {
      var k = cs[i]; if (k.indexOf('--') !== 0) continue;
      var v = norm(cs.getPropertyValue(k)); if (!v) continue;
      var probe = document.createElement('i'); probe.style.color = v; if (!probe.style.color) continue;
      document.body.appendChild(probe); var rgb = norm(getComputedStyle(probe).color); probe.remove();
      if (RED.test(v) || RED.test(rgb)) m.ac.push(k);
      else if (LINK.test(v) || LINK.test(rgb)) m.ln.push(k);
      else if (rgb === bgNow) m.bg.push(k);
      else if (rgb === txNow) m.tx.push(k);
      else if (/^rgb\((170|96|144), \1, \1\)$/.test(rgb) || /^#(aaa|aaaaaa|606060|909090)$/.test(v)) m.tx2.push(k);
    }
    return (m.bg.length || m.ac.length) ? m : null;
  }
  function apply(cfg) {
    if (!document.documentElement) return;
    var t = T[cfg.theme], el = document.getElementById('lenta-yt');
    if (!t) { if (el) el.remove(); return; }
    if (!map) map = discover();
    var vars = '';
    if (map) for (var key in map) map[key].forEach(function (k) { vars += k + ':' + t[key] + '!important;'; });
    var css = ':root,html,html[dark],html[darker-dark-theme]{' + vars + '}' +
      'html,body,ytm-app,ytm-mobile-topbar-renderer,.mobile-topbar-header,ytm-pivot-bar-renderer{background-color:' + t.bg + '!important}' +
      // urg'u: progress chizig'i, faol tugmalar
      '.ytp-play-progress,.ytm-progress-bar-played,.ytp-swatch-background-color,ytm-progress-bar .progress-bar-played{background:' + t.ac + '!important}' +
      '.ytProgressBarLineProgressBarPlayed,.YtProgressBarLineProgressBarPlayed{background:' + t.ac + '!important}' +
      '::selection{background:' + t.ac + ';color:#000}::-webkit-scrollbar{width:0;height:0}';
    if (!el) { el = document.createElement('style'); el.id = 'lenta-yt'; (document.head || document.documentElement).appendChild(el); }
    if (el.textContent !== css) el.textContent = css;
    if (el.nextSibling) el.parentNode.appendChild(el);
  }
  if (window.__lentaYt) { window.__lentaYt(C); return; }
  var cfg = C;
  window.__lentaYt = function (c) { cfg = c; apply(cfg); };
  // sahifa uslublari bosqichma-bosqich yuklanadi — ranglarni faqat bir necha marta aniqlaymiz (qotmaslik uchun)
  [600, 1500, 3500, 7000].forEach(function (ms) { setTimeout(function () { map = null; apply(cfg); }, ms); });
  document.addEventListener('DOMContentLoaded', function () { apply(cfg); });
})();
