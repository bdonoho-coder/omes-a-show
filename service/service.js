// Omes a Show service. TizenBrew runs this on the TV's Node, which can be as old as v4,
// so it stays ES5 and uses core modules only. It gives the page, which can't rely on the
// Tizen API, a local HTTP interface, and it owns the sleep timer: the page goes away as
// soon as another app opens, and the service doesn't.
(function () {
  var http = require('http');
  var tls = require('tls');
  var crypto = require('crypto');
  var fs = require('fs');
  var url = require('url');

  var env = (typeof process !== 'undefined' && process.env) || {};
  var PORT = +env.OMES_A_SHOW_PORT || 8092;
  var TV_HOST = env.TV_HOST || '127.0.0.1';
  var TV_PORT = +env.TV_PORT || 8002;
  var CONFIG_FILE = env.OMES_A_SHOW_CONFIG || '/home/owner/share/omes-a-show.json';
  var VERSION = '0.1.0';

  // TizenBrew serves module pages from here. Other pages on the TV, such as a website
  // open in another module, must not be able to open apps or turn the TV off.
  var PAGE_ORIGIN = 'http://127.0.0.1:8081';

  var SLEEP_STEPS = [0, 15, 30, 45, 60, 90, 120];
  var SLEEP_TICK_MS = 5000;
  // Timers don't run while the TV is off. A deadline this far in the past means the TV was
  // turned off by hand and has just come back on, so the power key would switch it off again.
  var SLEEP_LATE_LIMIT_MS = 60000;

  var ANSWER_TIMEOUT_MS = 30000;
  var KEY_SETTLE_MS = 1500;
  var APPS_MAX_AGE_MS = 60000;

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

  /* ---------- Saved pairing token ---------- */

  var config = { token: '' };
  try {
    config.token = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).token || '';
  } catch (e) { /* first run */ }

  function saveToken(token) {
    config.token = token;
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config));
    } catch (e) { /* the TV will ask for permission again next time */ }
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
          saveToken(String(msg.data.token));
        }
        if (!key) return finish(null, 'ready');
        socket.write(wsFrame(JSON.stringify({
          method: 'ms.remote.control',
          params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' }
        })));
        setTimeout(function () { finish(null, 'ready'); }, KEY_SETTLE_MS);
      } else if (msg.event === 'ms.channel.unauthorized') {
        saveToken('');
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
      remote: remote.status
    };
  }

  /* ---------- Apps ---------- */

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

  /* ---------- HTTP ---------- */

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

  var server = http.createServer(function (req, res) {
    var u = url.parse(req.url, true);
    if (u.pathname === '/icon') return serveIcon(res, u.query.id);
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
