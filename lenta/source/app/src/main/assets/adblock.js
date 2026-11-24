/* Lenta: YouTube reklamasiz.
   1) Video ma'lumotidan reklama joylari (adPlacements, playerAds, adSlots) o'chiriladi — pleyer reklama qo'ymaydi.
   2) Baribir chiqsa — ovozsiz, juda tez o'tkaziladi, "Skip" o'zi bosiladi.
   3) Lenta va sahifadagi reklama bloklari yashiriladi. */
(function () {
  if (!__ADS__ || window.__lentaAds) return;
  window.__lentaAds = 1;
  var KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'];
  function prune(o) {
    if (!o || typeof o !== 'object') return o;
    try {
      for (var i = 0; i < KEYS.length; i++) if (KEYS[i] in o) delete o[KEYS[i]];
      if (o.playerResponse) prune(o.playerResponse);
      if (o.response && typeof o.response === 'object') prune(o.response);
      if (Array.isArray(o)) for (var j = 0; j < o.length; j++) prune(o[j]);
    } catch (e) { }
    return o;
  }
  function hasAds(o) { return o && typeof o === 'object' && (o.adPlacements || o.playerAds || o.adSlots || o.playerResponse || Array.isArray(o)); }
  var jp = JSON.parse;
  JSON.parse = function () { var r = jp.apply(this, arguments); try { if (hasAds(r)) prune(r); } catch (e) { } return r; };
  try {
    var rj = Response.prototype.json;
    Response.prototype.json = function () { return rj.apply(this, arguments).then(function (r) { return hasAds(r) ? prune(r) : r; }); };
  } catch (e) { }
  try {
    var ipr;
    Object.defineProperty(window, 'ytInitialPlayerResponse', { configurable: true, get: function () { return ipr; }, set: function (v) { ipr = prune(v); } });
  } catch (e) { }

  var CSS = 'ytm-promoted-sparkles-web-renderer,ytm-promoted-video-renderer,ytm-companion-ad-renderer,ad-slot-renderer,' +
    'ytm-ad-slot-renderer,ytm-display-ad-promo-renderer,ytm-statement-banner-renderer,ytm-companion-slot,.ytp-ad-overlay-container,' +
    '.ytp-ad-image-overlay,#player-ads,.masthead-ad,ytm-rich-item-renderer:has(ad-slot-renderer),' +
    'ytm-item-section-renderer:has(ytm-promoted-sparkles-web-renderer),ytm-reel-item-renderer:has(ad-slot-renderer){display:none!important}';
  function style() {
    if (document.getElementById('lenta-ads')) return;
    var root = document.head || document.documentElement; if (!root) return;
    var st = document.createElement('style'); st.id = 'lenta-ads'; st.textContent = CSS; root.appendChild(st);
  }
  style(); document.addEventListener('DOMContentLoaded', style);

  var SKIP = '.ytp-ad-skip-button,.ytp-ad-skip-button-modern,.ytp-skip-ad-button,.ytm-ad-skip-button,button[class*="skip-ad"],button[class*="ad-skip"]';
  var forced = null;
  setInterval(function () {
    var b = document.querySelector(SKIP);
    if (b) try { b.click(); } catch (e) { }
    var ad = document.querySelector('.ad-showing,.ad-interrupting');
    var v = document.querySelector('video');
    if (ad && v && isFinite(v.duration) && v.duration > 0) {
      if (!forced) forced = { muted: v.muted, rate: v.playbackRate };
      v.muted = true;
      try { v.playbackRate = 16; } catch (e) { }
      if (v.currentTime < v.duration - 0.3) v.currentTime = v.duration - 0.1;
    } else if (forced && v) {
      v.muted = forced.muted; v.playbackRate = forced.rate || 1; forced = null;
    }
  }, 400);
})();
