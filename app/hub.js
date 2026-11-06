// Omes a Show page. ES5 only: a 2018 TV's browser is years behind.
(function () {
  var SERVICE = 'http://127.0.0.1:8094';
  var TIZENBREW_WS = 'ws://127.0.0.1:8081';
  var SELF_MODULE = /(^|\/)omes-a-show(@|$)/;
  var WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=30.2672&longitude=-97.7431' +
    '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min' +
    '&forecast_days=1&temperature_unit=fahrenheit&timezone=America%2FChicago';

  var EVENT_GET_MODULES = 4;
  var EVENT_LAUNCH_MODULE = 5;

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27 };

  var SLEEP_STEPS = [15, 30, 45, 60, 90, 120];
  var COLUMNS = 5;
  var ROW_HEIGHT = 212;
  var VISIBLE_ROWS = 4;
  var TILE_COLORS = ['#008000', '#800000', '#000080', '#800080', '#808000', '#008080'];
  var MAX_EVENTS = 11;
  var WEATHER_EVERY_MS = 15 * 60000;
  var CALENDAR_EVERY_MS = 5 * 60000;
  var STATUS_EVERY_MS = 3000;

  var CONTROLS = ['setup', 'sleep', 'off'];

  var MOCK = /[?&]mock=1/.test(location.search);
  var MOCK_APPS = [
    { id: 'mock.netflix', name: 'Netflix' },
    { id: 'mock.youtube', name: 'YouTube' },
    { id: 'mock.prime', name: 'Prime Video' },
    { id: 'mock.disney', name: 'Disney+' },
    { id: 'mock.plex', name: 'Plex' },
    { id: 'mock.browser', name: 'Internet' }
  ];
  var MOCK_MODULES = [{ fullName: 'gh/foxreis/tizentube', appName: 'TizenTube', keys: [] }];
  var MOCK_SITES = [{ name: 'Movie Night' }];

  var els = {};
  var state = {
    apps: [],
    modules: [],
    sites: [],
    tiles: [],
    zone: 'tiles',       // 'controls' or 'tiles'
    control: 1,
    tile: 0,
    sleepMs: 0,
    sleepSyncedAt: 0,
    serviceUp: false,
    settingsVersion: null,
    appsError: false,
    appsLoaded: false,
    setupOpen: false,
    setupTimer: null
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
    if (path === '/sites') return MOCK_SITES;
    if (path === '/status') return { sleepRemainingMs: currentSleepMs(), remote: 'ready', settingsVersion: 0 };
    if (path === '/setup/start') {
      return { url: 'http://192.168.1.20:8095/?pin=123456', pin: '123456', expiresInMs: 600000 };
    }
    if (path === '/calendar') {
      var today = new Date();
      var at = function (days, hour, minute) {
        return Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + days, hour, minute);
      };
      return { configured: true, events: [
        { title: 'Dentist', allDay: false, utc: false, at: at(0, 15, 30) },
        { title: 'Dinner with family', allDay: false, utc: false, at: at(0, 18, 0) },
        { title: 'Farmers market', allDay: true, utc: false, at: at(1, 0, 0) },
        { title: 'Oil change', allDay: false, utc: false, at: at(2, 9, 0) }
      ] };
    }
    return { ok: true };
  }

  function retryStatus() {
    callService('/status').then(function (body) {
      state.serviceUp = true;
      state.settingsVersion = body.settingsVersion;
      syncSleep(body);
      loadApps();
      loadSites();
      loadCalendar();
      setInterval(pollStatus, STATUS_EVERY_MS);
    }, function () {
      // TizenBrew starts the service just after this page opens.
      setTimeout(retryStatus, 1000);
    });
  }

  function pollStatus() {
    callService('/status').then(function (body) {
      syncSleep(body);
      if (body.settingsVersion !== state.settingsVersion) {
        state.settingsVersion = body.settingsVersion;
        loadSites();
        loadCalendar();
      }
    }, function () { /* tries again on the next poll */ });
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

  function loadSites() {
    callService('/sites').then(function (list) {
      state.sites = list;
      buildTiles();
    }, function () { /* website tiles appear on the next change */ });
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
    var sites = state.sites.map(function (site, i) {
      return { name: site.name, siteIndex: i };
    });
    var apps = state.apps.map(function (app) {
      return { name: app.name, app: app };
    });
    state.tiles = modules.concat(sites, apps, [{ name: 'Add website', addSite: true }]);
    if (state.tile >= state.tiles.length) state.tile = state.tiles.length - 1;
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
    function addLetter() {
      art.style.background = tile.addSite ? '#808080' : colorFor(tile.name);
      var letter = document.createElement('div');
      letter.className = 'letter';
      letter.textContent = tile.addSite ? '+' : tile.name.charAt(0).toUpperCase();
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
    if (state.appsError) message = 'Couldn’t load your apps. Press Back and open this again.';
    else if (!state.appsLoaded) message = 'Loading your apps…';
    els.empty.textContent = message;
    els.empty.style.display = message ? 'block' : 'none';
  }

  /* ---------- Focus ---------- */

  function renderFocus() {
    var tileEls = els.grid.children;
    for (var i = 0; i < tileEls.length; i++) {
      tileEls[i].className = 'tile' + (state.zone === 'tiles' && i === state.tile ? ' focus' : '');
    }
    renderControlFocus();
    var row = Math.floor(state.tile / COLUMNS);
    var firstRow = Math.max(0, row - VISIBLE_ROWS + 1);
    els.grid.style.transform = 'translateY(' + (-firstRow * ROW_HEIGHT) + 'px)';
  }

  function renderControlFocus() {
    CONTROLS.forEach(function (name, i) {
      var el = els[name];
      var focused = state.zone === 'controls' && i === state.control;
      el.className = 'control' + (focused ? ' focus' : '') +
        (name === 'sleep' && currentSleepMs() > 0 ? ' active' : '');
    });
  }

  function moveTiles(keyCode) {
    var i = state.tile;
    var last = state.tiles.length - 1;
    if (keyCode === KEY.LEFT && i % COLUMNS > 0) state.tile = i - 1;
    else if (keyCode === KEY.RIGHT && i < last && i % COLUMNS < COLUMNS - 1) state.tile = i + 1;
    else if (keyCode === KEY.UP && i >= COLUMNS) state.tile = i - COLUMNS;
    else if (keyCode === KEY.DOWN) {
      if (Math.floor(i / COLUMNS) < Math.floor(last / COLUMNS)) state.tile = Math.min(i + COLUMNS, last);
      else state.zone = 'controls';
    }
  }

  function moveControls(keyCode) {
    if (keyCode === KEY.LEFT && state.control > 0) state.control--;
    else if (keyCode === KEY.RIGHT && state.control < CONTROLS.length - 1) state.control++;
    else if (keyCode === KEY.UP) state.zone = 'tiles';
  }

  function activate() {
    if (state.zone === 'controls') {
      var name = CONTROLS[state.control];
      if (name === 'setup') openSetup();
      else if (name === 'sleep') cycleSleep();
      else turnOff();
      return;
    }
    var tile = state.tiles[state.tile];
    if (!tile) return;
    if (tile.addSite) openSetup();
    else if (tile.module) launchModule(tile.module);
    else if (tile.siteIndex !== undefined) openSite(tile);
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

  function openSite(tile) {
    if (MOCK) return toast('Would open ' + tile.name);
    callService('/open-site?i=' + tile.siteIndex).catch(function (err) {
      toast('Couldn’t open ' + tile.name + ': ' + err.message);
    });
  }

  /* ---------- Setup window ---------- */

  function drawQr(text) {
    var qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    var count = qr.getModuleCount();
    var quiet = 2;
    var canvas = $('setup-qr');
    var size = Math.floor(canvas.width / (count + quiet * 2));
    var offset = Math.floor((canvas.width - size * count) / 2);
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (var row = 0; row < count; row++) {
      for (var col = 0; col < count; col++) {
        if (qr.isDark(row, col)) ctx.fillRect(offset + col * size, offset + row * size, size, size);
      }
    }
  }

  function openSetup() {
    callService('/setup/start').then(function (body) {
      drawQr(body.url);
      $('setup-address').textContent = 'No camera? Go to ' + body.url;
      els.modal.className = 'show';
      state.setupOpen = true;
      clearTimeout(state.setupTimer);
      state.setupTimer = setTimeout(closeSetup, body.expiresInMs);
    }, function () {
      toast('Setup isn’t available right now. Restart the TV and try again.');
    });
  }

  function closeSetup() {
    clearTimeout(state.setupTimer);
    state.setupOpen = false;
    els.modal.className = '';
    callService('/setup/stop').catch(function () {});
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
        return toast('The TV didn’t allow this app, so the timer is off. Choose Allow when it asks.');
      }
      toast('The TV will turn off in ' + formatMinutes(minutes));
    }, function () {
      toast('The sleep timer isn’t available right now.');
    });
  }

  function turnOff() {
    if (MOCK) return toast('Would turn off the TV');
    callService('/power').catch(function () {
      toast('The TV didn’t allow this app. Choose Allow when it asks, then try again.');
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
    els.sleep.textContent = ms > 0 ? 'Sleep: ' + formatMinutes(Math.ceil(ms / 60000)) : 'Sleep: Off';
    renderControlFocus();
  }

  /* ---------- Weather ---------- */

  function weatherWords(code) {
    if (code === 0) return 'Clear';
    if (code <= 2) return 'Partly cloudy';
    if (code === 3) return 'Cloudy';
    if (code <= 48) return 'Foggy';
    if (code <= 57) return 'Drizzle';
    if (code <= 67) return 'Rain';
    if (code <= 77) return 'Snow';
    if (code <= 82) return 'Showers';
    if (code <= 86) return 'Snow showers';
    return 'Thunderstorms';
  }

  function showWeather(data) {
    els.weatherTemp.textContent = Math.round(data.current.temperature_2m) + '°F';
    els.weatherText.textContent = weatherWords(data.current.weather_code) +
      '  H ' + Math.round(data.daily.temperature_2m_max[0]) + '°  L ' + Math.round(data.daily.temperature_2m_min[0]) + '°';
  }

  function loadWeather() {
    if (MOCK) {
      return showWeather({ current: { temperature_2m: 72, weather_code: 1 },
        daily: { temperature_2m_max: [78], temperature_2m_min: [59] } });
    }
    fetch(WEATHER_URL).then(function (res) {
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    }).catch(function () {
      // An old TV browser can distrust newer certificates. The service can still get it.
      return callService('/weather');
    }).then(showWeather).catch(function () {
      if (!els.weatherTemp.textContent) els.weatherText.textContent = 'Weather unavailable';
    });
  }

  /* ---------- Calendar ---------- */

  // Times arrive as absolute UTC or as local digits. See the note in the service.
  function eventDate(event) {
    if (event.utc && !event.allDay) return new Date(event.at);
    var d = new Date(event.at);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
  }

  function dayLabel(date, today) {
    var dayMs = 24 * 3600000;
    var start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    var days = Math.round((start - today) / dayMs);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    return DAYS[date.getDay()] + ', ' + SHORT_MONTHS[date.getMonth()] + ' ' + date.getDate();
  }

  function timeLabel(date) {
    var hours = date.getHours();
    var minutes = date.getMinutes();
    return (hours % 12 || 12) + ':' + (minutes < 10 ? '0' : '') + minutes + (hours < 12 ? 'am' : 'pm');
  }

  function addNote(text) {
    var note = document.createElement('div');
    note.className = 'note';
    note.textContent = text;
    els.calendar.appendChild(note);
  }

  function renderCalendar(body) {
    els.calendar.innerHTML = '';
    if (!body.configured) return addNote('Connect your Google Calendar from Setup.');
    if (body.error && !body.events.length) return addNote('Couldn’t load your calendar: ' + body.error);

    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var upcoming = body.events.map(function (event) {
      return { title: event.title, allDay: event.allDay, date: eventDate(event) };
    }).filter(function (event) {
      return event.allDay ? event.date >= today : event.date.getTime() >= now.getTime() - 3600000;
    }).sort(function (a, b) {
      return a.date - b.date;
    });
    if (!upcoming.length) return addNote('Nothing coming up.');

    var lastDay = '';
    var rows = 0;
    upcoming.some(function (event) {
      var label = dayLabel(event.date, today);
      var cost = label === lastDay ? 1 : 2;
      if (rows + cost > MAX_EVENTS) return true;
      rows += cost;
      if (label !== lastDay) {
        var day = document.createElement('div');
        day.className = 'day';
        day.textContent = label;
        els.calendar.appendChild(day);
        lastDay = label;
      }
      var row = document.createElement('div');
      row.className = 'event';
      var when = document.createElement('div');
      when.className = 'when';
      when.textContent = event.allDay ? 'All day' : timeLabel(event.date);
      var what = document.createElement('div');
      what.className = 'what';
      what.textContent = event.title;
      row.appendChild(when);
      row.appendChild(what);
      els.calendar.appendChild(row);
      return false;
    });
  }

  function loadCalendar() {
    callService('/calendar').then(renderCalendar, function () {
      els.calendar.innerHTML = '';
      addNote('Couldn’t load your calendar.');
    });
  }

  /* ---------- Clock ---------- */

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function renderClock() {
    var now = new Date();
    els.clock.textContent = timeLabel(now);
    els.date.textContent = DAYS[now.getDay()] + ', ' + SHORT_MONTHS[now.getMonth()] + ' ' + now.getDate();
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
    if (state.setupOpen) {
      if (code === KEY.BACK || code === KEY.ESC || code === KEY.ENTER) {
        ev.preventDefault();
        closeSetup();
      }
      return;
    }
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
    if (state.zone === 'tiles') moveTiles(code);
    else moveControls(code);
    renderFocus();
  }

  function start() {
    els.clock = $('clock');
    els.date = $('date');
    els.setup = $('setup-btn');
    els.sleep = $('sleep-btn');
    els.off = $('off-btn');
    els.grid = $('grid');
    els.empty = $('empty');
    els.toast = $('toast');
    els.modal = $('modal-shade');
    els.weatherTemp = $('weather-temp');
    els.weatherText = $('weather-text');
    els.calendar = $('calendar-list');

    fitStage();
    window.addEventListener('resize', fitStage);
    document.addEventListener('keydown', onKey);

    renderClock();
    renderSleep();
    renderEmpty();
    buildTiles();
    setInterval(function () {
      renderClock();
      renderSleep();
    }, 1000);

    loadWeather();
    setInterval(loadWeather, WEATHER_EVERY_MS);
    setInterval(loadCalendar, CALENDAR_EVERY_MS);

    retryStatus();
    connectTizenBrew();

    if (/[?&]setup=1/.test(location.search)) openSetup();
  }

  start();
})();
