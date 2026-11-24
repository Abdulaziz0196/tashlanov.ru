/* Lenta: ilova ichida keraksiz "ilovani oching" tugmalarini yashirish va Instagram'da "Log in" ni to'g'ridan-to'g'ri login sahifasiga yo'naltirish.
   Tezlik uchun: butun sahifa emas, faqat YANGI qo'shilgan qismlar tekshiriladi (Reels/lentada sahifa doim o'zgarib turadi). */
(function () {
  if (window.__lentaClean) return;
  window.__lentaClean = 1;
  var OPEN_APP = /^(open app|open youtube|open in app|open in youtube|открыть в приложении|open instagram|use the app|get the app|download app|get it on google play|switch to the app|открыть приложение|открыть instagram|в приложении|скачать приложение|установить приложение|ilovani ochish|ilovada ochish)$/i;
  var LOGIN = /^(log in|log into instagram|войти|вход|kirish)$/i;
  var LINKS = 'a[href^="intent:"],a[href^="instagram:"],a[href*="play.google.com"],a[href*="apps.apple.com"],a[href*="itunes.apple.com"],a[href*="/download/app"]';
  var BTNS = 'a,button,div[role="button"],span[role="button"]';
  function hide(el) { el.style.setProperty('display', 'none', 'important'); }
  function text(el) { return (el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function check(el) {
    if (el.matches && el.matches(LINKS)) { hide(el); return; }
    if (el.matches && el.matches(BTNS)) { var t = text(el); if (t.length < 40 && OPEN_APP.test(t)) hide(el); }
  }
  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    check(root);
    if (!root.querySelectorAll || !root.firstElementChild) return;
    var a = root.querySelectorAll(LINKS + ',' + BTNS);
    for (var i = 0; i < a.length && i < 400; i++) check(a[i]);
  }
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest(BTNS) : null;
    if (!el) return;
    var t = text(el), href = el.getAttribute && (el.getAttribute('href') || '');
    if (/^(intent|instagram):/i.test(href) || OPEN_APP.test(t)) { e.preventDefault(); e.stopPropagation(); return; }
    if (LOGIN.test(t) && /instagram\.com$/.test(location.hostname) && location.pathname.indexOf('/accounts/login') !== 0) {
      e.preventDefault(); e.stopPropagation();
      location.href = '/accounts/login/';
    }
  }, true);
  var queue = [], pending = false;
  function flush() {
    pending = false;
    var q = queue; queue = [];
    for (var i = 0; i < q.length; i++) scan(q[i]);
  }
  function start() {
    scan(document.body);
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var add = muts[i].addedNodes;
        for (var j = 0; j < add.length; j++) if (add[j].nodeType === 1) queue.push(add[j]);
      }
      if (queue.length > 300) queue = queue.slice(-300);
      if (!pending && queue.length) {
        pending = true;
        (window.requestIdleCallback || function (f) { setTimeout(f, 300); })(flush, { timeout: 800 });
      }
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
