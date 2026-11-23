/* Lenta: instagram.com ranglarini almashtirish. Faqat rang o'zgaruvchilari, sayt kodi o'zgarmaydi. */
(function () {
  var C = __CFG__;
  var T = {
    gold:   { bg: '#000000', bg2: '#0F0F11', el: '#151517', tx: '#F5F5F5', tx2: '#A1A1AA', ac: '#F7A70B', ln: '#FFC94D', sep: '#232327' },
    violet: { bg: '#07050D', bg2: '#120D1F', el: '#191128', tx: '#F3EEFF', tx2: '#A99DC4', ac: '#A855F7', ln: '#C084FC', sep: '#2A1F40' },
    ocean:  { bg: '#03101A', bg2: '#0A1B2A', el: '#0F2335', tx: '#E8F4FF', tx2: '#8FB0C8', ac: '#22D3EE', ln: '#67E8F9', sep: '#17344C' },
    rose:   { bg: '#0D0507', bg2: '#1A0B10', el: '#231017', tx: '#FFEFF3', tx2: '#C99BA7', ac: '#FB7185', ln: '#FDA4AF', sep: '#3B1B24' },
    mint:   { bg: '#020D09', bg2: '#08190F', el: '#0D2117', tx: '#EAFFF4', tx2: '#8DBBA4', ac: '#34D399', ln: '#6EE7B7', sep: '#15352A' }
  };
  var MAP = {
    '--ig-primary-background': 'bg', '--ig-secondary-background': 'bg2', '--ig-elevated-background': 'el',
    '--ig-banner-background': 'bg2', '--ig-highlight-background': 'el', '--ig-hover-overlay': 'el',
    '--ig-primary-text': 'tx', '--ig-secondary-text': 'tx2', '--ig-tertiary-text': 'tx2',
    '--ig-primary-button': 'ac', '--ig-primary-button-hover': 'ln', '--ig-link': 'ln', '--ig-badge': 'ac',
    '--ig-focus-stroke': 'ac', '--ig-separator': 'sep', '--ig-elevated-separator': 'sep', '--ig-stroke': 'sep'
  };
  function rgb(h) { return parseInt(h.substr(1, 2), 16) + ',' + parseInt(h.substr(3, 2), 16) + ',' + parseInt(h.substr(5, 2), 16); }
  function apply(cfg) {
    var t = T[cfg.theme], el = document.getElementById('lenta-theme');
    if (!t) { if (el) el.remove(); return true; }
    var root = document.documentElement; if (!root) return false;
    var cs = getComputedStyle(root), vars = '', found = 0;
    for (var k in MAP) {
      var cur = cs.getPropertyValue(k).trim(); if (!cur) continue; found++;
      // sayt qaysi formatda yozgan bo'lsa ("0,149,246" yoki "#0095f6"), shunda yozamiz
      vars += k + ':' + (/^\d+\s*,\s*\d+\s*,\s*\d+$/.test(cur) ? rgb(t[MAP[k]]) : t[MAP[k]]) + '!important;';
    }
    var css = ':root,html,.__fb-light-mode,.__fb-dark-mode{' + vars + '}' +
      'html,body{background:' + t.bg + '!important}' +
      '::selection{background:' + t.ac + ';color:#000}' +
      '::-webkit-scrollbar{width:0;height:0}';
    if (!el) { el = document.createElement('style'); el.id = 'lenta-theme'; (document.head || root).appendChild(el); }
    if (el.textContent !== css) el.textContent = css;
    if (el.nextSibling) el.parentNode.appendChild(el); // har doim eng oxirida tursin
    return found > 0;
  }
  if (window.__lenta) { window.__lenta(C); return; }
  var cfg = C;
  window.__lenta = function (c) { cfg = c; apply(cfg); };
  var n = 0, iv = setInterval(function () { apply(cfg); if (++n > 20) clearInterval(iv); }, 500);
  document.addEventListener('DOMContentLoaded', function () {
    apply(cfg);
    new MutationObserver(function () { apply(cfg); }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  });
})();
