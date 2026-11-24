/* Lenta: YouTube ilovadan chiqqanda ham (ekran o'chsa ham) ijro etilaversin.
   YouTube sahifa yashirinsa videoni to'xtatadi — biz sahifani doim "ko'rinib turibdi" deb ko'rsatamiz. */
(function () {
  if (!__BG__ || window.__lentaBg) return;
  window.__lentaBg = 1;
  try {
    var P = Document.prototype;
    Object.defineProperty(P, 'hidden', { get: function () { return false; }, configurable: true });
    Object.defineProperty(P, 'visibilityState', { get: function () { return 'visible'; }, configurable: true });
    Object.defineProperty(P, 'webkitHidden', { get: function () { return false; }, configurable: true });
    Object.defineProperty(P, 'webkitVisibilityState', { get: function () { return 'visible'; }, configurable: true });
  } catch (e) { }
  ['visibilitychange', 'webkitvisibilitychange', 'pagehide', 'blur', 'freeze'].forEach(function (t) {
    window.addEventListener(t, function (e) { e.stopImmediatePropagation(); }, true);
    document.addEventListener(t, function (e) { e.stopImmediatePropagation(); }, true);
  });
  var wantPlay = false, bgMode = false, userPause = false;
  document.addEventListener('play', function (e) { if (e.target && e.target.tagName === 'VIDEO') wantPlay = true; }, true);
  document.addEventListener('pause', function (e) {
    var v = e.target;
    if (!v || v.tagName !== 'VIDEO') return;
    if (userPause) { userPause = false; wantPlay = false; return; }
    // fonda sahifa o'zi to'xtatsa — davom ettiramiz; oldinda foydalanuvchi to'xtatsa — tegmaymiz
    if (bgMode && wantPlay && !v.ended) setTimeout(function () { v.play().catch(function () { }); }, 80);
    else if (!bgMode) wantPlay = false;
  }, true);
  window.__lentaSetBg = function (on) { bgMode = !!on; };
  window.__lentaPlaying = function () { var v = document.querySelector('video'); return !!(v && !v.paused && !v.ended); };
  window.__lentaToggle = function () {
    var v = document.querySelector('video'); if (!v) return;
    if (v.paused) { wantPlay = true; v.play().catch(function () { }); } else { userPause = true; v.pause(); }
  };
  window.__lentaStop = function () { var v = document.querySelector('video'); if (v && !v.paused) { userPause = true; v.pause(); } };
})();
