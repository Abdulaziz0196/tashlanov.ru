/* Lenta: Reels (Instagram) va Shorts (YouTube) da video tugashi bilan keyingisiga o'zi o'tadi. */
(function () {
  if (window.__lentaAuto) { window.__lentaAuto(__AUTO__); return; }
  var on = __AUTO__;
  window.__lentaAuto = function (v) { on = v; };
  function shortsPage() {
    var h = location.hostname, p = location.pathname;
    return (/instagram\.com$/.test(h) && /^\/reels?\//.test(p)) || (/youtube\.com$/.test(h) && /^\/shorts\//.test(p));
  }
  function scroller(el) {
    while (el && el !== document.body && el !== document.documentElement) {
      var s = getComputedStyle(el);
      if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 10) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }
  function visible(v) { var r = v.getBoundingClientRect(); return r.height > 100 && r.top > -r.height / 2 && r.top < innerHeight / 2; }
  var last = new WeakMap(), lock = 0;
  function next(v) {
    var now = Date.now();
    if (now - lock < 1500) return;
    lock = now;
    var sc = scroller(v);
    var step = (sc === document.scrollingElement || sc === document.documentElement) ? innerHeight : sc.clientHeight;
    sc.scrollBy({ top: step, behavior: 'smooth' });
  }
  document.addEventListener('timeupdate', function (e) {
    var v = e.target;
    if (!on || !(v instanceof HTMLVideoElement) || !shortsPage()) return;
    if (v.paused || !v.duration || v.duration > 600 || !visible(v)) return;
    var lt = last.get(v) || 0, t = v.currentTime;
    last.set(v, t);
    if (t < lt - 1 && lt > v.duration * 0.8) next(v);       // video takrorlandi (loop) — demak tugadi
    else if (v.duration - t < 0.3) next(v);
  }, true);
  document.addEventListener('ended', function (e) {
    if (on && e.target instanceof HTMLVideoElement && shortsPage() && visible(e.target)) next(e.target);
  }, true);
})();
