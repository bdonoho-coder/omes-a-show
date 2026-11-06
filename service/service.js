// Omes a Show service. TizenBrew runs this on the TV's Node, which can be as old as v4,
// so it stays ES5 and uses core modules only. It gives the page, which can't rely on the
// Tizen API, a local HTTP interface. It owns everything that must outlive the page, like
// the sleep timer, and everything the page can't reach, like the calendar feed.
(function () {
  var http = require('http');
  var https = require('https');
  var tls = require('tls');
  var crypto = require('crypto');
  var fs = require('fs');
  var os = require('os');
  var url = require('url');
  var querystring = require('querystring');

  var env = (typeof process !== 'undefined' && process.env) || {};
  // A new port for each change to this interface: TizenBrew keeps old services running
  // until the TV restarts, and an old copy would otherwise keep answering the new page.
  var PORT = +env.OMES_A_SHOW_PORT || 8094;
  var SETUP_PORT = +env.OMES_A_SHOW_SETUP_PORT || 8095;
  var TV_HOST = env.TV_HOST || '127.0.0.1';
  var TV_PORT = +env.TV_PORT || 8002;
  var CONFIG_FILE = env.OMES_A_SHOW_CONFIG || '/home/owner/share/omes-a-show.json';
  var VERSION = '0.2.0';

  // TizenBrew serves module pages from here. Other pages on the TV, such as a website
  // open in another module, must not be able to open apps or turn the TV off.
  var PAGE_ORIGIN = 'http://127.0.0.1:8081';

  var SLEEP_STEPS = [0, 15, 30, 45, 60, 90, 120];
  var SLEEP_TICK_MS = 5000;
  // Timers don't run while the TV is off. A deadline this far in the past means the TV was
  // turned off by hand and has just come back on, so the power key would switch it off again.
  var SLEEP_LATE_LIMIT_MS = 60000;

  var WAKE_TICK_MS = 15000;
  var WAKE_GAP_MS = 60000;

  var ANSWER_TIMEOUT_MS = 30000;
  var KEY_SETTLE_MS = 1500;
  var APPS_MAX_AGE_MS = 60000;

  var CALENDAR_MAX_AGE_MS = 15 * 60000;
  var CALENDAR_MAX_BYTES = 8 * 1024 * 1024;
  var CALENDAR_PAST_MS = 36 * 3600000;
  var CALENDAR_FUTURE_MS = 9 * 24 * 3600000;
  var RECURRENCE_LIMIT = 20000;
  var FETCH_TIMEOUT_MS = 20000;

  var SETUP_LIFETIME_MS = 10 * 60000;
  var SETUP_MAX_BAD_PINS = 5;
  var SETUP_MAX_BODY = 16 * 1024;
  var MAX_SITES = 30;

  // Icon packs often can't be redistributed, so they live on the TV, not in this repository.
  var ICON_DIR = env.OMES_A_SHOW_ICONS || '/home/owner/share/omes-a-show-icons';
  var ICON_MAX_BYTES = 256 * 1024;
  var ICON_MAX_COUNT = 300;
  var ICON_NAME = /^[a-z0-9-]{1,60}$/;

  var TIZENBREW_APP = 'xvvl3S1bvH.TizenBrewStandalone';
  var MODULE_DATA = { moduleName: 'bdonoho-coder/omes-a-show', moduleType: 'gh' };

  var WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=30.2672&longitude=-97.7431' +
    '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min' +
    '&forecast_days=1&temperature_unit=fahrenheit&timezone=America%2FChicago';

  var BUILT_IN_APPS = {
    'com.samsung.tv.cobalt-yt': true,
    'org.tizen.browser': true,
    'com.samsung.tv.store': true
  };
  // Store apps have a long numeric id or a 10 character package id.
  var STORE_APP_ID = /^(\d{8,}|[A-Za-z0-9]{10}\.[^.]+)$/;
  // TizenBrew, and the standalone TizenTube build, which doesn't start on older TVs.
  var HIDDEN_PACKAGE = /^(xvvl3S1bvH|xvvl3S1TT1)\./;

  function bufFrom(text, encoding) {
    return Buffer.from ? Buffer.from(text, encoding) : new Buffer(text, encoding);
  }

  /* ---------- Settings, kept only on the TV ---------- */

  var config = { token: '', sites: [], calendarUrl: '', openOnWake: true };
  var settingsVersion = 0;
  try {
    var saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config.token = saved.token || '';
    config.sites = saved.sites || [];
    config.calendarUrl = saved.calendarUrl || '';
    config.openOnWake = saved.openOnWake !== false;
  } catch (e) { /* first run */ }

  function saveConfig() {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config));
    } catch (e) { /* settings last until the TV restarts */ }
  }

  /* ---------- The TV's remote control channel ---------- */

  var remote = { status: 'unknown' }; // unknown, asking, ready, denied or error

  function wsFrame(text) {
    var payload = bufFrom(text, 'utf8');
    var len = payload.length;
    var header;
    if (len < 126) {
      header = bufFrom([0x81, 0x80 | len]);
    } else {
      header = bufFrom([0x81, 0x80 | 126, len >> 8, len & 255]);
    }
    var mask = crypto.randomBytes(4);
    var body = bufFrom(payload);
    for (var i = 0; i < len; i++) body[i] = payload[i] ^ mask[i % 4];
    return Buffer.concat([header, mask, body]);
  }

  // Splits complete server frames off the buffer. Returns what's left over.
  function readWsFrames(buffer, onText) {
    while (buffer.length >= 2) {
      var len = buffer[1] & 127;
      var offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return buffer;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return buffer;
        len = buffer.readUInt32BE(6);
        offset = 10;
      }
      if (buffer.length < offset + len) return buffer;
      if ((buffer[0] & 15) === 1) onText(buffer.slice(offset, offset + len).toString('utf8'));
      buffer = buffer.slice(offset + len);
    }
    return buffer;
  }

  // Connects to the TV, which asks the viewer for permission the first time, and sends
  // the key if there is one. done(error) runs once.
  function talkToTv(key, done) {
    var name = bufFrom('Omes a Show', 'utf8').toString('base64');
    var path = '/api/v2/channels/samsung.remote.control?name=' + name +
      (config.token ? '&token=' + config.token : '');
    var buffer = bufFrom('', 'utf8');
    var upgraded = false;
    var finished = false;

    if (!config.token) remote.status = 'asking';

    var socket = tls.connect({ host: TV_HOST, port: TV_PORT, rejectUnauthorized: false }, function () {
      socket.write('GET ' + path + ' HTTP/1.1\r\n' +
        'Host: ' + TV_HOST + ':' + TV_PORT + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n');
    });

    var answerTimer = setTimeout(function () { finish('no-answer', 'error'); }, ANSWER_TIMEOUT_MS);

    function finish(error, status) {
      if (finished) return;
      finished = true;
      clearTimeout(answerTimer);
      remote.status = status;
      socket.destroy();
      done(error);
    }

    function onMessage(text) {
      var msg;
      try { msg = JSON.parse(text); } catch (e) { return; }
      if (msg.event === 'ms.channel.connect') {
        if (msg.data && msg.data.token && String(msg.data.token) !== config.token) {
          config.token = String(msg.data.token);
          saveConfig();
        }
        if (!key) return finish(null, 'ready');
        socket.write(wsFrame(JSON.stringify({
          method: 'ms.remote.control',
          params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' }
        })));
        setTimeout(function () { finish(null, 'ready'); }, KEY_SETTLE_MS);
      } else if (msg.event === 'ms.channel.unauthorized') {
        config.token = '';
        saveConfig();
        finish('denied', 'denied');
      }
    }

    socket.on('data', function (chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        var end = buffer.toString('binary').indexOf('\r\n\r\n');
        if (end === -1) return;
        if (!/^HTTP\/1\.1 101/.test(buffer.slice(0, end).toString())) return finish('refused', 'error');
        upgraded = true;
        buffer = buffer.slice(end + 4);
      }
      buffer = readWsFrames(buffer, onMessage);
    });
    socket.on('error', function () { finish('unreachable', 'error'); });
    socket.on('close', function () { finish('closed', 'error'); });
  }

  /* ---------- Sleep timer ---------- */

  var sleep = { endsAt: 0, ticker: null };

  function stopSleep() {
    sleep.endsAt = 0;
    if (sleep.ticker) clearInterval(sleep.ticker);
    sleep.ticker = null;
  }

  function sleepTick() {
    var late = Date.now() - sleep.endsAt;
    if (late < 0) return;
    stopSleep();
    if (late <= SLEEP_LATE_LIMIT_MS) talkToTv('KEY_POWER', function () {});
  }

  function startSleep(minutes) {
    stopSleep();
    if (!minutes) return;
    sleep.endsAt = Date.now() + minutes * 60000;
    sleep.ticker = setInterval(sleepTick, SLEEP_TICK_MS);
  }

  function statusBody() {
    return {
      version: VERSION,
      sleepRemainingMs: sleep.endsAt ? Math.max(0, sleep.endsAt - Date.now()) : 0,
      remote: remote.status,
      settingsVersion: settingsVersion
    };
  }

  /* ---------- Open the hub when the TV wakes ---------- */

  // Timers stop while the TV is off, so a long gap between ticks means it just came back on.
  // Autorun Last App reopens whatever ran last, which may not be the hub. This only helps
  // when the service survived standby; after a full restart the TV's own setting takes over.
  var lastWakeTick = Date.now();

  function openHub() {
    try {
      var data = new tizen.ApplicationControlData('module', [JSON.stringify(MODULE_DATA)]);
      var control = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/default', null, null, null, [data]);
      tizen.application.launchAppControl(control, TIZENBREW_APP, null, function () {
        tizen.application.launch(TIZENBREW_APP);
      });
    } catch (e) {
      tizen.application.launch(TIZENBREW_APP);
    }
  }

  setInterval(function () {
    var now = Date.now();
    var gap = now - lastWakeTick;
    lastWakeTick = now;
    if (gap > WAKE_GAP_MS && config.openOnWake) openHub();
  }, WAKE_TICK_MS);

  /* ---------- Apps and websites ---------- */

  var appsCache = { at: 0, list: null, icons: {} };

  function isUserApp(info) {
    if (!info.name || HIDDEN_PACKAGE.test(info.id)) return false;
    if (BUILT_IN_APPS[info.id]) return true;
    return info.show !== false && STORE_APP_ID.test(info.id);
  }

  function iconFile(path) {
    return path ? decodeURIComponent(String(path).replace(/^file:\/\//, '')) : '';
  }

  // Listing takes several seconds on a TV, so the list is cached briefly.
  function listApps(done) {
    if (appsCache.list && Date.now() - appsCache.at < APPS_MAX_AGE_MS) return done(null, appsCache.list);
    tizen.application.getAppsInfo(function (infos) {
      var icons = {};
      var list = infos.filter(isUserApp).map(function (info) {
        icons[info.id] = iconFile(info.iconPath);
        return { id: info.id, name: info.name, icon: !!icons[info.id] };
      });
      list.sort(function (a, b) { return a.name.localeCompare(b.name); });
      appsCache = { at: Date.now(), list: list, icons: icons };
      done(null, list);
    }, function (e) { done(e); });
  }

  function openUrl(address, done) {
    var control = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', address);
    tizen.application.launchAppControl(control, 'org.tizen.browser', function () { done(null); }, function () {
      // Fall back to whichever app handles web links.
      tizen.application.launchAppControl(control, null, function () { done(null); }, function (e) { done(e); });
    });
  }

  /* ---------- Fetching over HTTPS ---------- */

  function fetchText(address, options, done, redirects) {
    var finished = false;
    function finish(error, text) {
      if (finished) return;
      finished = true;
      done(error, text);
    }
    var parsed = url.parse(address);
    var request = https.get({
      host: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.path,
      rejectUnauthorized: options.rejectUnauthorized !== false,
      headers: { 'User-Agent': 'OmesAShow/' + VERSION }
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (redirects || 0) < 3) {
        res.resume();
        var next = url.resolve(address, res.headers.location);
        if (!/^https:/.test(next)) return finish(new Error('redirect left HTTPS'));
        return fetchText(next, options, finish, (redirects || 0) + 1);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return finish(new Error('HTTP ' + res.statusCode));
      }
      var chunks = [];
      var size = 0;
      res.on('data', function (chunk) {
        size += chunk.length;
        if (size > options.maxBytes) {
          request.abort();
          return finish(new Error('too large'));
        }
        chunks.push(chunk);
      });
      res.on('end', function () { finish(null, Buffer.concat(chunks).toString('utf8')); });
      res.on('error', function (e) { finish(e); });
    });
    request.on('error', function (e) { finish(e); });
    request.setTimeout(FETCH_TIMEOUT_MS, function () {
      request.abort();
      finish(new Error('timed out'));
    });
  }

  /* ---------- Calendar ---------- */

  // Times are kept as "wall clock" values: a UTC millisecond count holding the local digits.
  // Only times written in UTC (ending in Z) are absolute. The page converts both, because
  // the page knows the TV's time zone and this service may not. Events with a named zone
  // are treated as being in the TV's zone, which holds for a calendar kept in Austin.
  function parseIcsTime(value, params) {
    var m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
    if (!m) return null;
    return {
      at: Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)),
      allDay: !m[4] || /VALUE=DATE(;|$)/.test(params),
      utc: !!m[7]
    };
  }

  function unescapeIcs(text) {
    return text.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
  }

  function parseRule(value) {
    var rule = { interval: 1 };
    value.split(';').forEach(function (part) {
      var pair = part.split('=');
      if (pair[0] === 'FREQ') rule.freq = pair[1];
      else if (pair[0] === 'INTERVAL') rule.interval = +pair[1] || 1;
      else if (pair[0] === 'COUNT') rule.count = +pair[1];
      else if (pair[0] === 'UNTIL') rule.until = parseIcsTime(pair[1], '');
      else if (pair[0] === 'BYDAY') rule.byDay = pair[1].split(',');
    });
    return rule;
  }

  function parseIcs(text) {
    var events = [];
    var moved = {};
    var current = null;
    text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n').forEach(function (line) {
      if (line === 'BEGIN:VEVENT') {
        current = { excluded: {} };
        return;
      }
      if (line === 'END:VEVENT') {
        if (current && current.start && !current.cancelled) events.push(current);
        if (current && current.recurrenceId && current.uid) moved[current.uid + '|' + current.recurrenceId.at] = true;
        current = null;
        return;
      }
      if (!current) return;
      var colon = line.indexOf(':');
      if (colon === -1) return;
      var head = line.slice(0, colon).split(';');
      var name = head[0];
      var params = head.slice(1).join(';');
      var value = line.slice(colon + 1);
      if (name === 'SUMMARY') current.title = unescapeIcs(value);
      else if (name === 'UID') current.uid = value;
      else if (name === 'DTSTART') current.start = parseIcsTime(value, params);
      else if (name === 'RECURRENCE-ID') current.recurrenceId = parseIcsTime(value, params);
      else if (name === 'RRULE') current.rule = parseRule(value);
      else if (name === 'STATUS') current.cancelled = value === 'CANCELLED';
      else if (name === 'EXDATE') {
        value.split(',').forEach(function (item) {
          var time = parseIcsTime(item, params);
          if (time) current.excluded[time.at] = true;
        });
      }
    });
    events.forEach(function (event) {
      event.moved = moved;
    });
    return events;
  }

  var WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  var DAY_MS = 24 * 3600000;

  // Calls visit(at) for each occurrence in order, until visit returns false.
  function eachOccurrence(event, visit) {
    var rule = event.rule;
    var start = event.start.at;
    var first = new Date(start);
    var timeOfDay = start % DAY_MS;

    function monthDate(index, day) {
      return Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + index, day) + timeOfDay;
    }

    // BYDAY=2TU means the second Tuesday of the month, and -1FR the last Friday.
    function nthWeekday(index, code) {
      var m = /^(-?\d+)?([A-Z]{2})$/.exec(code);
      if (!m) return null;
      var n = +(m[1] || 1);
      var weekday = WEEKDAYS.indexOf(m[2]);
      var at;
      if (n > 0) {
        at = monthDate(index, 1);
        at += ((weekday - new Date(at).getUTCDay() + 7) % 7) * DAY_MS + (n - 1) * 7 * DAY_MS;
      } else {
        at = monthDate(index + 1, 0);
        at -= ((new Date(at).getUTCDay() - weekday + 7) % 7) * DAY_MS + (-n - 1) * 7 * DAY_MS;
      }
      return new Date(at).getUTCMonth() === new Date(monthDate(index, 1)).getUTCMonth() ? at : null;
    }

    function candidate(step) {
      if (rule.freq === 'DAILY') return [start + step * DAY_MS];
      if (rule.freq === 'WEEKLY') {
        var day = new Date(start + step * DAY_MS).getUTCDay();
        var codes = rule.byDay || [WEEKDAYS[first.getUTCDay()]];
        var monday = (first.getUTCDay() + 6) % 7;
        var week = Math.floor((step + monday) / 7);
        return week % rule.interval === 0 && codes.indexOf(WEEKDAYS[day]) !== -1 ? [start + step * DAY_MS] : [];
      }
      if (rule.freq === 'MONTHLY') {
        var index = step * rule.interval;
        if (rule.byDay) return rule.byDay.map(function (code) { return nthWeekday(index, code); });
        var at = monthDate(index, first.getUTCDate());
        return new Date(at).getUTCDate() === first.getUTCDate() ? [at] : [];
      }
      if (rule.freq === 'YEARLY') {
        var years = monthDate(step * rule.interval * 12, first.getUTCDate());
        return new Date(years).getUTCDate() === first.getUTCDate() ? [years] : [];
      }
      return [];
    }

    if (!rule || !rule.freq) return visit(start);
    var seen = 0;
    var dayInterval = rule.freq === 'DAILY' ? rule.interval : 1;
    for (var step = 0; step < RECURRENCE_LIMIT; step++) {
      var list = candidate(step * dayInterval);
      for (var i = 0; i < list.length; i++) {
        var occurrence = list[i];
        if (occurrence === null || occurrence < start) continue;
        if (rule.until && occurrence > rule.until.at) return;
        seen++;
        if (rule.count && seen > rule.count) return;
        if (visit(occurrence) === false) return;
      }
    }
  }

  function expandCalendar(events, from, to) {
    var out = [];
    events.forEach(function (event) {
      eachOccurrence(event, function (at) {
        if (at > to) return false;
        if (at < from || event.excluded[at]) return true;
        if (!event.recurrenceId && event.moved[event.uid + '|' + at]) return true;
        out.push({ title: event.title || '(No title)', allDay: event.start.allDay, utc: event.start.utc, at: at });
        return true;
      });
    });
    out.sort(function (a, b) { return a.at - b.at; });
    return out;
  }

  var calendar = { at: 0, events: null, error: '', loading: [] };

  function loadCalendar(done) {
    if (!config.calendarUrl) return done({ configured: false, events: [] });
    function answer() {
      var now = Date.now();
      done({
        configured: true,
        error: calendar.error,
        events: calendar.events ? expandCalendar(calendar.events, now - CALENDAR_PAST_MS, now + CALENDAR_FUTURE_MS) : []
      });
    }
    if (calendar.at && Date.now() - calendar.at < CALENDAR_MAX_AGE_MS) return answer();
    calendar.loading.push(answer);
    if (calendar.loading.length > 1) return;
    fetchText(config.calendarUrl, { maxBytes: CALENDAR_MAX_BYTES }, function (error, text) {
      if (error) {
        calendar.error = error.message;
      } else {
        calendar.events = parseIcs(text);
        calendar.error = '';
      }
      calendar.at = Date.now();
      var waiting = calendar.loading;
      calendar.loading = [];
      waiting.forEach(function (callback) { callback(); });
    });
  }

  /* ---------- Setup from a phone ---------- */

  // Typing a long link with a TV remote is miserable, so this page opens on the home network
  // while the setup window is on screen. It needs the PIN shown on the TV, closes after a few
  // wrong guesses or a few minutes, and never shows the saved calendar address again.
  var setup = { server: null, pin: '', timer: null, badPins: 0 };

  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function tvAddress() {
    var interfaces = os.networkInterfaces();
    var found = '';
    Object.keys(interfaces).forEach(function (name) {
      interfaces[name].forEach(function (item) {
        if (!found && item.family === 'IPv4' && !item.internal) found = item.address;
      });
    });
    return found;
  }

  function setupPage(message) {
    var pin = escapeHtml(setup.pin);
    var sites = config.sites.map(function (site, i) {
      return '<li>' + escapeHtml(site.name) + ' <small>' + escapeHtml(site.url) + '</small>' +
        '<form method="post" action="/save"><input type="hidden" name="pin" value="' + pin + '">' +
        '<input type="hidden" name="removeSite" value="' + i + '"><button>Remove</button></form></li>';
    }).join('');
    return '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Omes a Show setup</title>' +
      '<style>body{font:18px Arial,sans-serif;background:#008080;margin:0;padding:12px}' +
      'section{background:#c0c0c0;border:2px outset #fff;padding:14px;margin:0 auto 14px;max-width:560px}' +
      'h1{font-size:20px;background:#000080;color:#fff;margin:-14px -14px 12px;padding:8px}' +
      'label{display:block;margin:10px 0 4px}input[type=text],input[type=url]{width:100%;box-sizing:border-box;' +
      'padding:10px;font-size:18px}button{padding:10px 18px;font-size:18px;margin-top:10px}' +
      'small{color:#333;word-break:break-all}li{margin:8px 0}ul{padding-left:20px}p.msg{font-weight:bold}</style>' +
      '</head><body>' +
      (message ? '<section><p class="msg">' + escapeHtml(message) + '</p></section>' : '') +
      '<section><h1>Add a website</h1><form method="post" action="/save">' +
      '<input type="hidden" name="pin" value="' + pin + '">' +
      '<label for="n">Name</label><input type="text" id="n" name="siteName" maxlength="40">' +
      '<label for="u">Link</label><input type="url" id="u" name="siteUrl" placeholder="https://">' +
      '<button>Add</button></form>' + (sites ? '<ul>' + sites + '</ul>' : '') + '</section>' +
      '<section><h1>Google Calendar</h1><p>' + (config.calendarUrl ? 'A calendar is connected.' : 'No calendar yet.') +
      '</p><p>In Google Calendar on a computer: Settings, your calendar, then copy ' +
      '<b>Secret address in iCal format</b>. Treat it like a password.</p>' +
      '<form method="post" action="/save"><input type="hidden" name="pin" value="' + pin + '">' +
      '<label for="c">Secret address</label><input type="url" id="c" name="calendarUrl" placeholder="https://calendar.google.com/...">' +
      '<button>Save calendar</button></form>' +
      (config.calendarUrl ? '<form method="post" action="/save"><input type="hidden" name="pin" value="' + pin + '">' +
        '<input type="hidden" name="removeCalendar" value="1"><button>Remove calendar</button></form>' : '') +
      '</section><section><h1>Power on</h1><p>Open the hub when the TV wakes: <b>' + (config.openOnWake ? 'On' : 'Off') + '</b></p>' +
      '<form method="post" action="/save"><input type="hidden" name="pin" value="' + pin + '">' +
      '<input type="hidden" name="openOnWake" value="' + (config.openOnWake ? '0' : '1') + '">' +
      '<button>Turn ' + (config.openOnWake ? 'off' : 'on') + '</button></form></section></body></html>';
  }

  function settingsChanged() {
    settingsVersion++;
    saveConfig();
  }

  function forgetCalendar() {
    calendar.events = null;
    calendar.at = 0;
    calendar.error = '';
  }

  function applySetup(form) {
    if (form.removeSite !== undefined) {
      var index = +form.removeSite;
      if (!config.sites[index]) return 'That website is already gone.';
      config.sites.splice(index, 1);
      settingsChanged();
      return 'Website removed.';
    }
    if (form.siteUrl !== undefined) {
      var address = String(form.siteUrl).trim();
      var name = String(form.siteName || '').trim().slice(0, 40);
      if (!/^https?:\/\/[^\s]+$/i.test(address)) return 'That link needs to start with http:// or https://.';
      if (config.sites.length >= MAX_SITES) return 'That is the most websites it can hold. Remove one first.';
      config.sites.push({ name: name || url.parse(address).hostname, url: address });
      settingsChanged();
      return 'Website added.';
    }
    if (form.calendarUrl !== undefined) {
      var feed = String(form.calendarUrl).trim();
      if (!/^https:\/\/[^\s]+$/i.test(feed)) return 'That address needs to start with https://.';
      config.calendarUrl = feed;
      forgetCalendar();
      settingsChanged();
      return 'Calendar saved. It will appear on the TV shortly.';
    }
    if (form.removeCalendar !== undefined) {
      config.calendarUrl = '';
      forgetCalendar();
      settingsChanged();
      return 'Calendar removed.';
    }
    if (form.openOnWake !== undefined) {
      config.openOnWake = form.openOnWake === '1';
      settingsChanged();
      return 'Saved.';
    }
    return '';
  }

  function packIconNames() {
    try {
      return fs.readdirSync(ICON_DIR).filter(function (file) {
        return /\.png$/.test(file);
      }).map(function (file) {
        return file.replace(/\.png$/, '');
      });
    } catch (e) {
      return [];
    }
  }

  function savePackIcon(name, data) {
    if (!ICON_NAME.test(name || '')) return 'bad name';
    if (data.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return 'not a PNG';
    if (packIconNames().length >= ICON_MAX_COUNT) return 'too many icons';
    try {
      if (!fs.existsSync(ICON_DIR)) fs.mkdirSync(ICON_DIR);
      fs.writeFileSync(ICON_DIR + '/' + name + '.png', data);
    } catch (e) {
      return 'could not save';
    }
    settingsVersion++;
    return '';
  }

  function handleIconUpload(req, res, query) {
    var chunks = [];
    var size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size <= ICON_MAX_BYTES) chunks.push(chunk);
    });
    req.on('end', function () {
      if (!pinMatches(query.pin)) return sendHtml(res, 403, 'Wrong PIN');
      if (size > ICON_MAX_BYTES) return sendHtml(res, 413, 'too large');
      var problem = savePackIcon(query.name, Buffer.concat(chunks));
      sendHtml(res, problem ? 400 : 200, problem || 'saved');
    });
  }

  function sendHtml(res, code, html) {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  }

  function pinMatches(candidate) {
    if (candidate === setup.pin) return true;
    setup.badPins++;
    if (setup.badPins >= SETUP_MAX_BAD_PINS) setTimeout(stopSetup, 0);
    return false;
  }

  function handleSetupRequest(req, res) {
    var u = url.parse(req.url, true);
    if (req.method === 'GET' && u.pathname === '/') {
      if (!pinMatches(u.query.pin)) return sendHtml(res, 403, 'Wrong PIN. Scan the code on the TV again.');
      return sendHtml(res, 200, setupPage(''));
    }
    if (req.method === 'POST' && u.pathname === '/icon') return handleIconUpload(req, res, u.query);
    if (req.method !== 'POST' || u.pathname !== '/save') return sendHtml(res, 404, 'Not found');
    var body = '';
    var tooBig = false;
    req.on('data', function (chunk) {
      body += chunk;
      if (body.length > SETUP_MAX_BODY) {
        tooBig = true;
        body = '';
      }
    });
    req.on('end', function () {
      if (tooBig) return sendHtml(res, 413, 'Too long');
      var form = querystring.parse(body);
      if (!pinMatches(form.pin)) return sendHtml(res, 403, 'Wrong PIN. Scan the code on the TV again.');
      sendHtml(res, 200, setupPage(applySetup(form)));
    });
  }

  function stopSetup() {
    if (setup.timer) clearTimeout(setup.timer);
    if (setup.server) setup.server.close();
    setup = { server: null, pin: '', timer: null, badPins: 0 };
  }

  function startSetup(res) {
    stopSetup();
    var pin = String(100000 + crypto.randomBytes(4).readUInt32BE(0) % 900000);
    var server = http.createServer(handleSetupRequest);
    server.on('error', function () {
      stopSetup();
      reply(res, 500, { error: 'setup port unavailable' });
    });
    server.listen(SETUP_PORT, function () {
      setup = { server: server, pin: pin, badPins: 0, timer: setTimeout(stopSetup, SETUP_LIFETIME_MS) };
      reply(res, 200, {
        url: 'http://' + tvAddress() + ':' + SETUP_PORT + '/?pin=' + pin,
        pin: pin,
        expiresInMs: SETUP_LIFETIME_MS
      });
    });
  }

  /* ---------- HTTP for the page ---------- */

  function reply(res, code, body) {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': PAGE_ORIGIN,
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(body));
  }

  function serveIcon(res, id) {
    var file = appsCache.icons[id];
    if (!file) return reply(res, 404, { error: 'no icon' });
    fs.readFile(file, function (err, data) {
      if (err) return reply(res, 404, { error: 'no icon' });
      res.writeHead(200, {
        'Content-Type': /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png',
        'Cache-Control': 'max-age=86400'
      });
      res.end(data);
    });
  }

  function servePackIcon(res, name) {
    if (!ICON_NAME.test(name || '')) return reply(res, 404, { error: 'no icon' });
    fs.readFile(ICON_DIR + '/' + name + '.png', function (err, data) {
      if (err) return reply(res, 404, { error: 'no icon' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      res.end(data);
    });
  }

  function handleSleep(res, query) {
    var minutes = +query.minutes;
    if (SLEEP_STEPS.indexOf(minutes) === -1) return reply(res, 400, { error: 'unknown step' });
    startSleep(minutes);
    if (!minutes || remote.status === 'ready') return reply(res, 200, statusBody());
    // Get permission now, while someone is watching, not when the timer ends.
    talkToTv(null, function () { reply(res, 200, statusBody()); });
  }

  function handleLaunch(res, id) {
    listApps(function (err, list) {
      if (err) return reply(res, 500, { error: err.message });
      var known = list.some(function (app) { return app.id === id; });
      if (!known) return reply(res, 404, { error: 'unknown app' });
      tizen.application.launch(id, function () { reply(res, 200, { ok: true }); },
        function (e) { reply(res, 500, { error: e.message }); });
    });
  }

  function handleOpenSite(res, index) {
    var site = config.sites[+index];
    if (!site) return reply(res, 404, { error: 'unknown website' });
    openUrl(site.url, function (error) {
      if (error) return reply(res, 500, { error: error.message });
      reply(res, 200, { ok: true });
    });
  }

  // Weather is public data, so an old TV's outdated certificate list shouldn't stop it.
  // Calendar requests carry a secret address and always verify the certificate.
  function handleWeather(res) {
    fetchText(WEATHER_URL, { maxBytes: 64 * 1024, rejectUnauthorized: false }, function (error, text) {
      if (error) return reply(res, 502, { error: error.message });
      try {
        reply(res, 200, JSON.parse(text));
      } catch (e) {
        reply(res, 502, { error: 'bad weather data' });
      }
    });
  }

  var server = http.createServer(function (req, res) {
    var u = url.parse(req.url, true);
    if (u.pathname === '/icon') return serveIcon(res, u.query.id);
    if (u.pathname === '/pack') return servePackIcon(res, u.query.name);
    if (req.headers.origin !== PAGE_ORIGIN) return reply(res, 403, { error: 'forbidden' });

    if (u.pathname === '/status') {
      reply(res, 200, statusBody());
    } else if (u.pathname === '/apps') {
      listApps(function (err, list) {
        if (err) return reply(res, 500, { error: err.message });
        reply(res, 200, list);
      });
    } else if (u.pathname === '/launch') {
      handleLaunch(res, u.query.id);
    } else if (u.pathname === '/pack-icons') {
      reply(res, 200, packIconNames());
    } else if (u.pathname === '/sites') {
      reply(res, 200, config.sites.map(function (site) { return { name: site.name }; }));
    } else if (u.pathname === '/open-site') {
      handleOpenSite(res, u.query.i);
    } else if (u.pathname === '/calendar') {
      loadCalendar(function (body) { reply(res, 200, body); });
    } else if (u.pathname === '/weather') {
      handleWeather(res);
    } else if (u.pathname === '/setup/start') {
      startSetup(res);
    } else if (u.pathname === '/setup/stop') {
      stopSetup();
      reply(res, 200, { ok: true });
    } else if (u.pathname === '/sleep') {
      handleSleep(res, u.query);
    } else if (u.pathname === '/power') {
      talkToTv('KEY_POWER', function (error) {
        reply(res, error ? 500 : 200, error ? { error: error, remote: remote.status } : { ok: true });
      });
    } else {
      reply(res, 404, { error: 'not found' });
    }
  });

  // The port is taken when an earlier copy is still running. TizenBrew keeps services
  // alive until the TV restarts, and that copy keeps serving the page.
  server.on('error', function () {});
  server.listen(PORT, '127.0.0.1');
})();
