// Omes a Show page. ES5 only: a 2018 TV's browser is years behind.
(function () {
  var SERVICE = 'http://127.0.0.1:8092';
  var TIZENBREW_WS = 'ws://127.0.0.1:8081';
  var SELF_MODULE = /(^|\/)omes-a-show(@|$)/;

  var EVENT_GET_MODULES = 4;
  var EVENT_LAUNCH_MODULE = 5;

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27 };

  var SLEEP_STEPS = [15, 30, 45, 60, 90, 120];
  var COLUMNS = 6;
  var ROW_HEIGHT = 248;
  var VISIBLE_ROWS = 3;
  var TILE_COLORS = ['#3d5a4c', '#5a4a3d', '#3d4f5a', '#5a3d49', '#4a4a5e', '#55563a'];

  var MOCK = /[?&]mock=1/.test(location.search);
  var MOCK_APPS = [
    { id: 'mock.netflix', name: 'Netflix' },
    { id: 'mock.youtube', name: 'YouTube' },
    { id: 'mock.prime', name: 'Prime Video' },
    { id: 'mock.disney', name: 'Disney+' },
    { id: 'mock.plex', name: 'Plex' },
    { id: 'mock.spotify', name: 'Spotify' },
    { id: 'mock.browser', name: 'Internet' }
  ];
  var MOCK_MODULES = [{ fullName: 'npm/@foxreis/tizentube', appName: 'TizenTube', keys: [] }];

  var els = {};
  var state = {
    apps: [],
    modules: [],
    tiles: [],
    row: 'tiles',       // 'controls' or 'tiles'
    control: 0,
    tile: 0,
    sleepMs: 0,
    sleepSyncedAt: 0,
    serviceUp: false,
    appsError: false,
    appsLoaded: false
  };
  var tizenbrew = null;
  var toastTimer = null;

  function $(id) { return document.getElementById(id); }

  /* ---------- Service calls ---------- */

  function callService(path) {
    if (MOCK) return Promise.resolve(mockService(path));
    return fetch(SERVICE + path).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error || String(res.status));
        return body;
      });
    });
  }

  function mockService(path) {
    var sleep = /minutes=(\d+)/.exec(path);
    if (sleep) return { sleepRemainingMs: +sleep[1] * 60000, remote: 'ready' };
    if (path === '/apps') return MOCK_APPS;
    if (path === '/status') return { sleepRemainingMs: currentSleepMs(), remote: 'ready' };
    return { ok: true };
  }

  function retryStatus() {
    callService('/status').then(function (body) {
      state.serviceUp = true;
      syncSleep(body);
      loadApps();
    }, function () {
      // TizenBrew starts the service just after this page opens.
      setTimeout(retryStatus, 1000);
    });
  }

  function syncSleep(body) {
    state.sleepMs = body.sleepRemainingMs;
    state.sleepSyncedAt = Date.now();
    renderSleep();
  }

  function loadApps() {
    callService('/apps').then(function (list) {
      state.apps = list;
      state.appsError = false;
      state.appsLoaded = true;
      buildTiles();
    }, function () {
      state.appsError = true;
      state.appsLoaded = true;
      buildTiles();
    });
  }

  /* ---------- TizenBrew modules ---------- */

  function connectTizenBrew() {
    if (MOCK) {
      state.modules = MOCK_MODULES;
      buildTiles();
      return;
    }
    var ws;
    try {
      ws = new WebSocket(TIZENBREW_WS);
    } catch (e) {
      return;
    }
    tizenbrew = { ws: ws, waitingFor: null };
    ws.onopen = function () { requestModules(ws); };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === EVENT_GET_MODULES) {
        // TizenBrew answers null until it has fetched every module's details.
        if (!msg.payload) return setTimeout(function () { requestModules(ws); }, 1500);
        state.modules = msg.payload.filter(function (mdl) {
          return !SELF_MODULE.test(mdl.fullName) && mdl.appPath;
        });
        buildTiles();
      } else if (msg.type === EVENT_LAUNCH_MODULE && tizenbrew.waitingFor) {
        openModulePage(tizenbrew.waitingFor);
      }
    };
    ws.onclose = function () { setTimeout(connectTizenBrew, 3000); };
  }

  function requestModules(ws) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: EVENT_GET_MODULES, payload: false }));
  }

  function openModulePage(mdl) {
    tizenbrew.waitingFor = null;
    location.href = mdl.appPath;
  }

  function launchModule(mdl) {
    if (MOCK) return toast('Would open ' + mdl.appName);
    if (!tizenbrew || tizenbrew.ws.readyState !== 1) return toast('TizenBrew is not ready yet. Try again in a moment.');
    (mdl.keys || []).forEach(function (key) {
      try { tizen.tvinputdevice.registerKey(key); } catch (e) { /* no Tizen API in this page */ }
    });
    tizenbrew.ws.send(JSON.stringify({ type: EVENT_LAUNCH_MODULE, payload: mdl }));
    if (mdl.evaluateScriptOnDocumentStart) {
      // TizenBrew reports back once the module's script is ready.
      tizenbrew.waitingFor = mdl;
    } else {
      setTimeout(function () { openModulePage(mdl); }, 100);
    }
  }

  /* ---------- Tiles ---------- */

  function buildTiles() {
    var modules = state.modules.map(function (mdl) {
      return { name: mdl.appName, module: mdl };
    });
    var apps = state.apps.map(function (app) {
      return { name: app.name, app: app };
    });
    state.tiles = modules.concat(apps);
    if (state.tile >= state.tiles.length) state.tile = Math.max(0, state.tiles.length - 1);
    renderTiles();
  }

  function colorFor(name) {
    var sum = 0;
    for (var i = 0; i < name.length; i++) sum += name.charCodeAt(i);
    return TILE_COLORS[sum % TILE_COLORS.length];
  }

  function shortName(name) {
    return name.split(/\s+[-:–|]\s+/)[0];
  }

  function tileArt(tile) {
    var art = document.createElement('div');
    art.className = 'art';
    art.style.background = colorFor(tile.name);
    function addLetter() {
      var letter = document.createElement('div');
      letter.className = 'letter';
      letter.textContent = tile.name.charAt(0).toUpperCase();
      art.appendChild(letter);
    }
    if (tile.app && tile.app.icon) {
      var img = document.createElement('img');
      img.onerror = function () {
        art.removeChild(img);
        addLetter();
      };
      img.src = SERVICE + '/icon?id=' + encodeURIComponent(tile.app.id);
      art.appendChild(img);
    } else {
      addLetter();
    }
    return art;
  }

  function renderTiles() {
    els.grid.innerHTML = '';
    state.tiles.forEach(function (tile) {
      var el = document.createElement('div');
      el.className = 'tile';
      el.appendChild(tileArt(tile));
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = shortName(tile.name);
      el.appendChild(name);
      els.grid.appendChild(el);
    });
    renderEmpty();
    renderFocus();
  }

  function renderEmpty() {
    var message = '';
    if (!state.tiles.length) {
      if (state.appsError) message = 'Couldn’t load your apps. Press Back and open Omes a Show again.';
      else if (!state.appsLoaded) message = 'Loading your apps…';
      else message = 'No apps found.';
    }
    els.empty.textContent = message;
    els.empty.style.display = message ? 'block' : 'none';
  }

  /* ---------- Focus ---------- */

  function renderFocus() {
    if (!state.tiles.length) state.row = 'controls';
    var tileEls = els.grid.children;
    for (var i = 0; i < tileEls.length; i++) {
      tileEls[i].className = 'tile' + (state.row === 'tiles' && i === state.tile ? ' focus' : '');
    }
    renderControlFocus();
    var row = Math.floor(state.tile / COLUMNS);
    var firstRow = Math.max(0, row - VISIBLE_ROWS + 1);
    els.grid.style.transform = 'translateY(' + (-firstRow * ROW_HEIGHT) + 'px)';
  }

  function renderControlFocus() {
    [els.sleep, els.off].forEach(function (el, i) {
      var focused = state.row === 'controls' && i === state.control;
      el.className = 'control' + (focused ? ' focus' : '') +
        (el === els.sleep && currentSleepMs() > 0 ? ' active' : '');
    });
  }

  function moveTiles(keyCode) {
    var i = state.tile;
    var last = state.tiles.length - 1;
    if (keyCode === KEY.LEFT && i % COLUMNS > 0) state.tile = i - 1;
    else if (keyCode === KEY.RIGHT && i < last && i % COLUMNS < COLUMNS - 1) state.tile = i + 1;
    else if (keyCode === KEY.UP) {
      if (i < COLUMNS) state.row = 'controls';
      else state.tile = i - COLUMNS;
    } else if (keyCode === KEY.DOWN && Math.floor(i / COLUMNS) < Math.floor(last / COLUMNS)) {
      state.tile = Math.min(i + COLUMNS, last);
    }
  }

  function moveControls(keyCode) {
    if (keyCode === KEY.LEFT) state.control = 0;
    else if (keyCode === KEY.RIGHT) state.control = 1;
    else if (keyCode === KEY.DOWN && state.tiles.length) state.row = 'tiles';
  }

  function activate() {
    if (state.row === 'controls') {
      if (state.control === 0) cycleSleep();
      else turnOff();
      return;
    }
    var tile = state.tiles[state.tile];
    if (!tile) return;
    if (tile.module) launchModule(tile.module);
    else openApp(tile.app);
  }

  function leave() {
    try {
      tizen.application.getCurrentApplication().exit();
    } catch (e) {
      // No Tizen API in this page: go back to TizenBrew's own screen.
      history.back();
    }
  }

  function openApp(app) {
    if (MOCK) return toast('Would open ' + app.name);
    callService('/launch?id=' + encodeURIComponent(app.id)).catch(function (err) {
      toast('Couldn’t open ' + shortName(app.name) + ': ' + err.message);
    });
  }

  /* ---------- Sleep timer and power ---------- */

  function currentSleepMs() {
    if (!state.sleepMs) return 0;
    return Math.max(0, state.sleepMs - (Date.now() - state.sleepSyncedAt));
  }

  function nextSleepStep() {
    var minutesLeft = currentSleepMs() / 60000;
    for (var i = 0; i < SLEEP_STEPS.length; i++) {
      if (SLEEP_STEPS[i] > minutesLeft + 0.5) return SLEEP_STEPS[i];
    }
    return 0;
  }

  function cycleSleep() {
    if (!state.serviceUp) return toast('Still starting up. Try again in a moment.');
    var minutes = nextSleepStep();
    callService('/sleep?minutes=' + minutes).then(function (body) {
      syncSleep(body);
      if (!minutes) return toast('Sleep timer off');
      if (body.remote !== 'ready') {
        // Without permission the TV can't be turned off, so don't leave a timer that won't fire.
        callService('/sleep?minutes=0').then(syncSleep);
        return toast('The TV didn’t allow Omes a Show, so the timer is off. Choose Allow when it asks.');
      }
      toast('The TV will turn off in ' + formatMinutes(minutes));
    }, function () {
      toast('The sleep timer isn’t available right now.');
    });
  }

  function turnOff() {
    if (MOCK) return toast('Would turn off the TV');
    callService('/power').catch(function () {
      toast('The TV didn’t allow Omes a Show. Choose Allow when it asks, then try again.');
    });
  }

  function formatMinutes(minutes) {
    if (minutes < 60) return minutes + ' min';
    var hours = Math.floor(minutes / 60);
    var rest = minutes % 60;
    return hours + ' hr' + (rest ? ' ' + rest + ' min' : '');
  }

  function renderSleep() {
    var ms = currentSleepMs();
    els.sleep.textContent = ms > 0 ? 'Sleep: ' + formatMinutes(Math.ceil(ms / 60000)) + ' left' : 'Sleep timer: Off';
    renderControlFocus();
  }

  /* ---------- Clock ---------- */

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];

  function renderClock() {
    var now = new Date();
    var hours = now.getHours();
    var minutes = now.getMinutes();
    els.clock.textContent = (hours % 12 || 12) + ':' + (minutes < 10 ? '0' : '') + minutes +
      (hours < 12 ? ' AM' : ' PM');
    els.date.textContent = DAYS[now.getDay()] + ', ' + MONTHS[now.getMonth()] + ' ' + now.getDate();
  }

  /* ---------- Page ---------- */

  function toast(text) {
    els.toast.textContent = text;
    els.toast.className = 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.className = ''; }, 5000);
  }

  function fitStage() {
    var scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    $('stage').style.transform = 'scale(' + scale + ')';
  }

  function onKey(ev) {
    var code = ev.keyCode;
    if (code === KEY.BACK || code === KEY.ESC) {
      ev.preventDefault();
      return leave();
    }
    if (code === KEY.ENTER) {
      ev.preventDefault();
      return activate();
    }
    if (code < KEY.LEFT || code > KEY.DOWN) return;
    ev.preventDefault();
    if (state.row === 'tiles') moveTiles(code);
    else moveControls(code);
    renderFocus();
  }

  function start() {
    els.clock = $('clock');
    els.date = $('date');
    els.sleep = $('sleep-btn');
    els.off = $('off-btn');
    els.grid = $('grid');
    els.empty = $('empty');
    els.toast = $('toast');

    fitStage();
    window.addEventListener('resize', fitStage);
    document.addEventListener('keydown', onKey);

    renderClock();
    renderSleep();
    renderEmpty();
    setInterval(function () {
      renderClock();
      renderSleep();
    }, 1000);

    retryStatus();
    connectTizenBrew();
  }

  start();
})();
