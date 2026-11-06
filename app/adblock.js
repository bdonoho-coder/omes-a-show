// Omes a Show website helper. TizenBrew runs this in every frame of a website opened from a
// website tile, the same way TizenTube runs on YouTube. It blocks common ad networks and
// pop-ups, removes invisible click-catching overlays, and adds remote control navigation,
// because most websites aren't made for a TV remote. ES5 only: a 2018 TV's browser is old.
(function () {
  if (window.__omesHelper) return;
  window.__omesHelper = true;

  var host = location.hostname;
  // TizenBrew also runs this when going back to the hub, which needs none of it.
  if (host === '127.0.0.1' || host === 'localhost') return;

  var HUB_URL = 'http://127.0.0.1:8081/module/gh%2Fbdonoho-coder%2Fomes-a-show/app/index.html';
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009 };
  var SEEK_SECONDS = 10;
  var SWEEP_MS = 1500;
  var OVERLAY_MIN_COVER = 0.5;
  var OVERLAY_MIN_Z = 1000;
  var OVERLAY_MAX_TEXT = 40;

  var AD_HOSTS = [
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
    'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'criteo.com', 'taboola.com',
    'outbrain.com', 'mgid.com', 'revcontent.com', 'popads.net', 'popcash.net', 'propellerads.com',
    'propellerclick.com', 'adsterra.com', 'adsterratools.com', 'exoclick.com', 'exosrv.com',
    'juicyads.com', 'trafficjunky.net', 'trafficstars.com', 'hilltopads.net', 'hilltopads.com',
    'adcash.com', 'clickadu.com', 'onclickads.net', 'onclkds.com', 'a-ads.com', 'adform.net',
    'adskeeper.com', 'bidvertiser.com', 'yllix.com', 'richads.com', 'pushground.com'
  ];

  var AD_SELECTORS = [
    'ins.adsbygoogle', '[id^="google_ads"]', '[id^="div-gpt-ad"]', '[class*="adsbox"]',
    '[class*="ad-banner"]', '[class*="banner-ad"]', '[id*="ad-banner"]', '[data-ad-slot]'
  ];

  var parser = document.createElement('a');

  function isAdUrl(address) {
    if (!address) return false;
    parser.href = String(address);
    var name = parser.hostname.toLowerCase();
    return AD_HOSTS.some(function (ad) {
      return name === ad || name.slice(-(ad.length + 1)) === '.' + ad;
    });
  }

  /* ---------- Pop-ups and requests ---------- */

  window.open = function () {
    return { closed: true, focus: function () {}, blur: function () {}, close: function () {}, location: {}, document: {} };
  };

  document.addEventListener('click', function (ev) {
    var node = ev.target;
    while (node && node.tagName !== 'A') node = node.parentNode;
    if (!node || !node.href) return;
    if (isAdUrl(node.href) || node.target === '_blank') {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }, true);

  function isAdElement(node) {
    return node && (node.tagName === 'SCRIPT' || node.tagName === 'IFRAME') && isAdUrl(node.src);
  }

  ['appendChild', 'insertBefore'].forEach(function (method) {
    var original = Node.prototype[method];
    Node.prototype[method] = function (node) {
      if (isAdElement(node)) return node;
      return original.apply(this, arguments);
    };
  });

  var xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, address) {
    if (isAdUrl(address)) arguments[1] = 'data:text/plain,';
    return xhrOpen.apply(this, arguments);
  };

  if (window.fetch) {
    var realFetch = window.fetch;
    window.fetch = function (input) {
      var address = input && input.url ? input.url : input;
      if (isAdUrl(address)) return Promise.reject(new TypeError('blocked'));
      return realFetch.apply(this, arguments);
    };
  }

  /* ---------- Clearing the page ---------- */

  function addStyle() {
    if (!document.documentElement) return;
    var style = document.createElement('style');
    style.textContent = AD_SELECTORS.join(',') + '{display:none!important}' +
      '.omes-focus{outline:5px solid #ffe000!important;outline-offset:2px!important}';
    (document.head || document.documentElement).appendChild(style);
  }

  // Ad overlays are big, sit on top of everything and say almost nothing, so the first click
  // anywhere opens an ad. Inside a player's own frame they stay, since players use overlays
  // for their controls.
  function isClickCatcher(el) {
    var style = window.getComputedStyle(el);
    if (style.position !== 'fixed' && style.position !== 'absolute') return false;
    if ((parseInt(style.zIndex, 10) || 0) < OVERLAY_MIN_Z) return false;
    var box = el.getBoundingClientRect();
    if (box.width * box.height < window.innerWidth * window.innerHeight * OVERLAY_MIN_COVER) return false;
    if ((el.textContent || '').trim().length > OVERLAY_MAX_TEXT) return false;
    if (el.querySelector('video, input, button, select, textarea')) return false;
    return window === window.top || !document.querySelector('video');
  }

  function sweep() {
    if (!document.body) return;
    Array.prototype.forEach.call(document.querySelectorAll('script[src], iframe[src]'), function (el) {
      if (isAdElement(el) && el.parentNode) el.parentNode.removeChild(el);
    });
    Array.prototype.forEach.call(document.body.children, function (el) {
      if (el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE' && isClickCatcher(el)) {
        el.parentNode.removeChild(el);
      }
    });
  }

  /* ---------- Remote control ---------- */

  var CLICKABLE = 'a[href], button, input, select, textarea, video, iframe, [onclick], [role="button"], [tabindex]';
  var current = null;

  function isVisible(el) {
    var box = el.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) return false;
    var style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function center(el) {
    var box = el.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }

  // Closest visible item in that direction, favoring ones straight ahead.
  function nextInDirection(keyCode) {
    var from = current && document.contains(current) ? center(current) : { x: window.innerWidth / 2, y: 0 };
    var best = null;
    var bestScore = Infinity;
    Array.prototype.forEach.call(document.querySelectorAll(CLICKABLE), function (el) {
      if (el === current || !isVisible(el)) return;
      var to = center(el);
      var dx = to.x - from.x;
      var dy = to.y - from.y;
      var ahead = keyCode === KEY.LEFT ? -dx : keyCode === KEY.RIGHT ? dx : keyCode === KEY.UP ? -dy : dy;
      var side = keyCode === KEY.LEFT || keyCode === KEY.RIGHT ? Math.abs(dy) : Math.abs(dx);
      if (ahead <= 1) return;
      var score = ahead + side * 3;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    });
    return best;
  }

  function focusOn(el) {
    if (current) current.classList.remove('omes-focus');
    current = el;
    el.classList.add('omes-focus');
    if (el.tabIndex < 0 && el.tagName !== 'IFRAME') el.setAttribute('tabindex', '0');
    el.focus();
    if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded();
    else el.scrollIntoView();
  }

  function playOrPause(video) {
    if (video.paused) {
      var started = video.play();
      if (started && started.catch) started.catch(function () {});
    } else {
      video.pause();
    }
  }

  function goHome() {
    if (window === window.top) location.href = HUB_URL;
    else window.top.postMessage({ omes: 'home' }, '*');
  }

  function leaveFrame() {
    if (window !== window.top) window.parent.postMessage({ omes: 'focus' }, '*');
  }

  function handled(ev) {
    ev.preventDefault();
    ev.stopPropagation();
  }

  window.addEventListener('message', function (ev) {
    var message = ev.data && ev.data.omes;
    if (message === 'home') goHome();
    else if (message === 'focus') window.focus();
  });

  function onKey(ev) {
    var code = ev.keyCode;
    if (code === KEY.BACK) {
      handled(ev);
      return goHome();
    }
    var typing = current && /^(INPUT|TEXTAREA|SELECT)$/.test(current.tagName);
    if (code === KEY.ENTER) {
      if (!current || !document.contains(current) || typing) return;
      handled(ev);
      if (current.tagName === 'VIDEO') playOrPause(current);
      else current.click();
      return;
    }
    if (code < KEY.LEFT || code > KEY.DOWN) return;
    if (current && current.tagName === 'VIDEO' && (code === KEY.LEFT || code === KEY.RIGHT)) {
      handled(ev);
      current.currentTime += code === KEY.LEFT ? -SEEK_SECONDS : SEEK_SECONDS;
      return;
    }
    var next = nextInDirection(code);
    handled(ev);
    if (next) focusOn(next);
    else leaveFrame();
  }

  document.addEventListener('keydown', onKey, true);

  /* ---------- Start ---------- */

  function start() {
    addStyle();
    sweep();
    setInterval(sweep, SWEEP_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
