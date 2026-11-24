/* Lenta: ilova ichida keraksiz "ilovani oching" tugmalarini yashirish va "Log in" ni to'g'ridan-to'g'ri login sahifasiga yo'naltirish. */
(function () {
  if (window.__lentaClean) return;
  window.__lentaClean = 1;
  var OPEN_APP = /^(open app|open youtube|open in app|open in youtube|открыть в приложении|open instagram|use the app|get the app|download app|get it on google play|switch to the app|открыть приложение|открыть instagram|в приложении|скачать приложение|установить приложение|ilovani ochish|ilovada ochish)$/i;
  var LOGIN = /^(log in|log into instagram|войти|вход|kirish)$/i;
  function hide(el) { el.style.setProperty('display', 'none', 'important'); }
  function text(el) { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function clean() {
    var links = document.querySelectorAll('a[href^="intent:"],a[href^="instagram:"],a[href*="play.google.com"],a[href*="apps.apple.com"],a[href*="itunes.apple.com"],a[href*="/download/app"]');
    for (var i = 0; i < links.length; i++) hide(links[i]);
    var els = document.querySelectorAll('a,button,div[role="button"],span[role="button"]');
    for (var j = 0; j < els.length; j++) {
      var t = text(els[j]);
      if (t.length < 40 && OPEN_APP.test(t)) hide(els[j]);
    }
  }
  // "Log in" bosilsa — ilova sahifasiga emas, to'g'ridan-to'g'ri login sahifasiga
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('a,button,div[role="button"],span[role="button"]') : null;
    if (!el) return;
    var t = text(el), href = el.getAttribute && (el.getAttribute('href') || '');
    if (/^(intent|instagram):/i.test(href) || OPEN_APP.test(t)) { e.preventDefault(); e.stopPropagation(); return; }
    if (LOGIN.test(t) && /instagram\.com$/.test(location.hostname) && location.pathname.indexOf('/accounts/login') !== 0) {
      e.preventDefault(); e.stopPropagation();
      location.href = '/accounts/login/';
    }
  }, true);
  var pending = false;
  function schedule() { if (pending) return; pending = true; setTimeout(function () { pending = false; clean(); }, 250); }
  function start() {
    clean();
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
