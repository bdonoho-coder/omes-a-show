// Runs service.js the way TizenBrew does (vm.runInContext with a copy of the globals), with
// a fake Tizen API, a fake clock and a fake TV remote channel.
const assert = require('assert');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const querystring = require('querystring');
const tls = require('tls');
const vm = require('vm');

const ORIGIN = 'http://127.0.0.1:8081';
const PORT = 18094;
const SETUP_PORT = 18095;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omes-a-show-'));
const CONFIG = path.join(dir, 'config.json');
const ICON_DIR = path.join(dir, 'icons');
const ICON = path.join(dir, 'icon.png');
fs.writeFileSync(ICON, 'png-bytes');

execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=tv', '-days', '1',
  '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
const TLS_FILES = {
  key: fs.readFileSync(path.join(dir, 'key.pem')),
  cert: fs.readFileSync(path.join(dir, 'cert.pem'))
};

/* Fake TV: answers the WebSocket upgrade, then behaves as tv.mode says. */
const tv = { mode: 'allow', keys: [], lastPath: '' };

function textFrame(text) {
  const payload = Buffer.from(text);
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([header, payload]);
}

function readClientFrames(buffer, onText) {
  while (buffer.length >= 6) {
    let len = buffer[1] & 127;
    let offset = 2;
    if (len === 126) {
      len = buffer.readUInt16BE(2);
      offset = 4;
    }
    if (buffer.length < offset + 4 + len) break;
    const mask = buffer.slice(offset, offset + 4);
    const body = Buffer.alloc(len);
    for (let i = 0; i < len; i++) body[i] = buffer[offset + 4 + i] ^ mask[i % 4];
    onText(body.toString());
    buffer = buffer.slice(offset + 4 + len);
  }
  return buffer;
}

const tvServer = tls.createServer(TLS_FILES, (socket) => {
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = buffer.slice(0, end).toString();
      tv.lastPath = head.split(' ')[1];
      const key = /Sec-WebSocket-Key: (.*)/.exec(head)[1].trim();
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      upgraded = true;
      buffer = buffer.slice(end + 4);
      if (tv.mode === 'allow') socket.write(textFrame(JSON.stringify({ event: 'ms.channel.connect', data: { token: '12345' } })));
      if (tv.mode === 'deny') socket.write(textFrame(JSON.stringify({ event: 'ms.channel.unauthorized' })));
    }
    buffer = readClientFrames(buffer, (text) => {
      tv.keys.push(JSON.parse(text).params.DataOfCmd);
    });
  });
});

/* Fake Tizen API */
const launched = [];
const browsed = [];
const hubOpens = [];

class FakeControl {
  constructor(operation, uri, mime, category, data) {
    Object.assign(this, { operation, uri, data });
  }
}

class FakeControlData {
  constructor(key, value) {
    Object.assign(this, { key, value });
  }
}

const fakeTizen = {
  ApplicationControl: FakeControl,
  ApplicationControlData: FakeControlData,
  application: {
    getAppsInfo(ok) {
      ok([
        { id: '3201907018807', name: 'Netflix', show: true, iconPath: 'file://' + ICON },
        { id: 'com.samsung.tv.cobalt-yt', name: 'YouTube', show: true },
        { id: 'org.tizen.settings', name: 'Settings', show: true },
        { id: '3201000000000', name: 'Hidden app', show: false },
        { id: 'xvvl3S1bvH.TizenBrewStandalone', name: 'TizenBrew', show: true },
        { id: 'xvvl3S1TT1.TizenTubeStandalone', name: 'TizenTube', show: true },
        { id: 'AbCdEfGhIj.SomeApp', name: 'Another app', show: true }
      ]);
    },
    launchAppControl(control, appId, ok) {
      if (appId === 'xvvl3S1bvH.TizenBrewStandalone') hubOpens.push(control.data[0].value[0]);
      else browsed.push({ uri: control.uri, appId });
      if (ok) ok();
    },
    launch(id, ok, fail) {
      if (id === 'AbCdEfGhIj.SomeApp') return fail(new Error('refused'));
      launched.push(id);
      ok();
    }
  }
};

/* Fake clock: the service's tickers only run when the test says so. */
const clock = { now: 1000000, tickers: new Set() };
class FakeDate extends Date {
  static now() { return clock.now; }
}

function loadService(port, tvPort) {
  const sandbox = {};
  ['Buffer', 'console', 'setTimeout', 'clearTimeout'].forEach((prop) => { sandbox[prop] = global[prop]; });
  sandbox.require = require;
  sandbox.tizen = fakeTizen;
  sandbox.module = { exports: {} };
  sandbox.Date = FakeDate;
  sandbox.process = {
    env: {
      OMES_A_SHOW_PORT: String(port),
      OMES_A_SHOW_SETUP_PORT: String(SETUP_PORT),
      TV_PORT: String(tvPort),
      OMES_A_SHOW_CONFIG: CONFIG,
      OMES_A_SHOW_ICONS: ICON_DIR
    }
  };
  sandbox.setInterval = (fn) => { clock.tickers.add(fn); return fn; };
  sandbox.clearInterval = (fn) => { clock.tickers.delete(fn); };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../service/service.js'), 'utf8'), vm.createContext(sandbox));
}

function get(port, urlPath, origin) {
  return new Promise((resolve, reject) => {
    const headers = origin === null ? {} : { Origin: origin || ORIGIN };
    http.get({ host: '127.0.0.1', port, path: urlPath, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { /* icon or page */ }
        resolve({ code: res.statusCode, json, body, headers: res.headers });
      });
    }).on('error', reject);
  });
}

function upload(urlPath, data) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: SETUP_PORT, path: urlPath, method: 'POST', agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function post(port, urlPath, form) {
  return new Promise((resolve, reject) => {
    const data = querystring.stringify(form);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method: 'POST',
      agent: false,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ code: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const setupIsClosed = () => new Promise((resolve) => {
  const socket = net.connect(SETUP_PORT, '127.0.0.1');
  socket.on('connect', () => { socket.destroy(); resolve(false); });
  socket.on('error', () => resolve(true));
});

let feedPort = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => Array.from(clock.tickers).forEach((fn) => fn());
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('rejects other origins, and requests with no origin', async () => {
  assert.strictEqual((await get(PORT, '/status', 'https://evil.example')).code, 403);
  assert.strictEqual((await get(PORT, '/power', null)).code, 403);
  assert.strictEqual((await get(PORT, '/setup/start', 'https://evil.example')).code, 403);
  assert.strictEqual((await get(PORT, '/sleep?minutes=15', 'https://youtube.com')).code, 403);
  assert.strictEqual((await get(PORT, '/status')).json.sleepRemainingMs, 0);
});

test('lists user apps only, sorted, without TizenBrew or standalone TizenTube', async () => {
  const res = await get(PORT, '/apps');
  assert.deepStrictEqual(res.json.map((a) => a.id), ['AbCdEfGhIj.SomeApp', '3201907018807', 'com.samsung.tv.cobalt-yt']);
  assert.strictEqual(res.headers['access-control-allow-origin'], ORIGIN);
});

test('serves icons for known apps', async () => {
  const res = await get(PORT, '/icon?id=3201907018807', null);
  assert.strictEqual(res.body, 'png-bytes');
  assert.strictEqual((await get(PORT, '/icon?id=com.samsung.tv.cobalt-yt', null)).code, 404);
  assert.strictEqual((await get(PORT, '/icon?id=../../etc/passwd', null)).code, 404);
});

test('launches known apps and refuses unknown ones', async () => {
  assert.strictEqual((await get(PORT, '/launch?id=3201907018807')).code, 200);
  assert.deepStrictEqual(launched, ['3201907018807']);
  assert.strictEqual((await get(PORT, '/launch?id=org.tizen.settings')).code, 404);
  assert.strictEqual((await get(PORT, '/launch?id=AbCdEfGhIj.SomeApp')).code, 500);
  assert.deepStrictEqual(launched, ['3201907018807']);
});

test('rejects sleep values that are not on the list', async () => {
  assert.strictEqual((await get(PORT, '/sleep?minutes=7')).code, 400);
  assert.strictEqual((await get(PORT, '/sleep?minutes=abc')).code, 400);
});

test('a denied permission is reported and no token is kept', async () => {
  tv.mode = 'deny';
  const res = await get(PORT, '/sleep?minutes=15');
  assert.strictEqual(res.json.remote, 'denied');
  assert.ok(!fs.existsSync(CONFIG) || JSON.parse(fs.readFileSync(CONFIG, 'utf8')).token === '');
  await get(PORT, '/sleep?minutes=0');
  tv.mode = 'allow';
});

test('setting a timer asks permission straight away and saves the token, without a key', async () => {
  tv.keys.length = 0;
  const res = await get(PORT, '/sleep?minutes=15');
  assert.strictEqual(res.json.remote, 'ready');
  assert.strictEqual(res.json.sleepRemainingMs, 15 * 60000);
  assert.strictEqual(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).token, '12345');
  assert.deepStrictEqual(tv.keys, []);
  await get(PORT, '/sleep?minutes=0');
});

test('the timer sends the power key once when it ends, using the saved token', async () => {
  tv.keys.length = 0;
  await get(PORT, '/sleep?minutes=30');
  clock.now += 29 * 60000;
  tick();
  await wait(100);
  assert.deepStrictEqual(tv.keys, []);
  clock.now += 60000;
  tick();
  await wait(300);
  assert.deepStrictEqual(tv.keys, ['KEY_POWER']);
  assert.ok(tv.lastPath.includes('token=12345'));
  assert.ok(tv.lastPath.includes('name=' + Buffer.from('Omes a Show').toString('base64')));
  tick();
  await wait(100);
  assert.deepStrictEqual(tv.keys, ['KEY_POWER']);
  assert.strictEqual((await get(PORT, '/status')).json.sleepRemainingMs, 0);
});

test('a timer that ended while the TV was off does not switch it off again', async () => {
  tv.keys.length = 0;
  await get(PORT, '/sleep?minutes=15');
  clock.now += 8 * 3600000;
  tick();
  await wait(300);
  assert.deepStrictEqual(tv.keys, []);
  assert.strictEqual((await get(PORT, '/status')).json.sleepRemainingMs, 0);
});

test('turning the timer off stops it', async () => {
  tv.keys.length = 0;
  await get(PORT, '/sleep?minutes=15');
  await get(PORT, '/sleep?minutes=0');
  clock.now += 15 * 60000;
  tick();
  await wait(100);
  assert.deepStrictEqual(tv.keys, []);
});

test('setting a new timer replaces the old one', async () => {
  tv.keys.length = 0;
  await get(PORT, '/sleep?minutes=15');
  await get(PORT, '/sleep?minutes=60');
  clock.now += 15 * 60000;
  tick();
  await wait(100);
  assert.deepStrictEqual(tv.keys, []);
  await get(PORT, '/sleep?minutes=0');
});

test('/power sends the key and reports success', async () => {
  tv.keys.length = 0;
  const res = await get(PORT, '/power');
  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(tv.keys, ['KEY_POWER']);
});

test('/power reports failure when the TV refuses', async () => {
  tv.mode = 'deny';
  const res = await get(PORT, '/power');
  assert.strictEqual(res.code, 500);
  assert.strictEqual(res.json.error, 'denied');
  tv.mode = 'allow';
});

test('a long gap between ticks opens the hub, and a short one does not', async () => {
  tick();
  hubOpens.length = 0;
  clock.now += 15000;
  tick();
  await wait(20);
  assert.strictEqual(hubOpens.length, 0);
  clock.now += 6 * 3600000;
  tick();
  await wait(20);
  assert.strictEqual(hubOpens.length, 1);
  assert.deepStrictEqual(JSON.parse(hubOpens[0]), { moduleName: 'bdonoho-coder/omes-a-show', moduleType: 'gh' });
});

test('the setup page is closed until the TV opens it', async () => {
  assert.ok(await setupIsClosed());
});

test('setup needs the PIN, and saves websites that show up as tiles', async () => {
  const start = (await get(PORT, '/setup/start')).json;
  assert.ok(/^\d{6}$/.test(start.pin));
  assert.ok(start.url.endsWith(':' + SETUP_PORT + '/?pin=' + start.pin));
  assert.strictEqual((await get(SETUP_PORT, '/?pin=000000', null)).code, 403);
  assert.strictEqual((await post(SETUP_PORT, '/save', { pin: '000000', siteUrl: 'https://x.example' })).code, 403);
  assert.deepStrictEqual((await get(PORT, '/sites')).json, []);
  assert.strictEqual((await get(SETUP_PORT, '/?pin=' + start.pin, null)).code, 200);

  const before = (await get(PORT, '/status')).json.settingsVersion;
  const saved = await post(SETUP_PORT, '/save', { pin: start.pin, siteName: 'Movie <b>Night</b>', siteUrl: 'https://movies.example/watch' });
  assert.ok(saved.body.includes('Website added.'));
  assert.ok(saved.body.includes('Movie &lt;b&gt;Night&lt;/b&gt;'));
  assert.ok(!saved.body.includes('<b>Night'));
  assert.deepStrictEqual((await get(PORT, '/sites')).json, [{ name: 'Movie <b>Night</b>', url: 'https://movies.example/watch', useBrowser: false }]);
  assert.strictEqual((await get(PORT, '/status')).json.settingsVersion, before + 1);

  assert.strictEqual((await get(PORT, '/open-site?i=0')).code, 200);
  assert.deepStrictEqual(browsed[0], { uri: 'https://movies.example/watch', appId: 'org.tizen.browser' });
  assert.strictEqual((await get(PORT, '/open-site?i=9')).code, 404);

  await post(SETUP_PORT, '/save', { pin: start.pin, siteName: 'Plain', siteUrl: 'https://plain.example/', useBrowser: '1' });
  assert.strictEqual((await get(PORT, '/sites')).json[1].useBrowser, true);
  await post(SETUP_PORT, '/save', { pin: start.pin, removeSite: '1' });

  const bad = await post(SETUP_PORT, '/save', { pin: start.pin, siteUrl: 'javascript:alert(1)' });
  assert.ok(bad.body.includes('needs to start with'));
  assert.strictEqual((await get(PORT, '/sites')).json.length, 1);

  await post(SETUP_PORT, '/save', { pin: start.pin, removeSite: '0' });
  assert.deepStrictEqual((await get(PORT, '/sites')).json, []);
  await get(PORT, '/setup/stop');
  await wait(50);
  assert.ok(await setupIsClosed());
});

test('setup closes itself after too many wrong PINs', async () => {
  await get(PORT, '/setup/start');
  for (let i = 0; i < 5; i++) await get(SETUP_PORT, '/?pin=000000', null);
  await wait(50);
  assert.ok(await setupIsClosed());
});

test('icon uploads need the PIN and a real PNG', async () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('pixels')]);
  assert.deepStrictEqual((await get(PORT, '/pack-icons')).json, []);
  const { pin } = (await get(PORT, '/setup/start')).json;
  assert.strictEqual(await upload('/icon?pin=000000&name=netflix', png), 403);
  assert.strictEqual(await upload('/icon?pin=' + pin + '&name=netflix', Buffer.from('not an image')), 400);
  assert.strictEqual(await upload('/icon?pin=' + pin + '&name=..%2F..%2Fevil', png), 400);
  assert.strictEqual(await upload('/icon?pin=' + pin + '&name=big', Buffer.alloc(300 * 1024)), 413);
  assert.deepStrictEqual((await get(PORT, '/pack-icons')).json, []);

  const before = (await get(PORT, '/status')).json.settingsVersion;
  assert.strictEqual(await upload('/icon?pin=' + pin + '&name=netflix', png), 200);
  assert.deepStrictEqual((await get(PORT, '/pack-icons')).json, ['netflix']);
  assert.strictEqual((await get(PORT, '/status')).json.settingsVersion, before + 1);
  assert.strictEqual((await get(PORT, '/pack?name=netflix', null)).code, 200);
  assert.strictEqual((await get(PORT, '/pack?name=..%2Fconfig', null)).code, 404);
  assert.strictEqual((await get(PORT, '/pack?name=missing', null)).code, 404);
  await get(PORT, '/setup/stop');
});

test('a saved calendar address is never shown back, and its certificate is verified', async () => {
  const start = (await get(PORT, '/setup/start')).json;
  const secret = 'https://127.0.0.1:' + feedPort + '/secret-abc/basic.ics';
  const saved = await post(SETUP_PORT, '/save', { pin: start.pin, calendarUrl: secret });
  assert.ok(!saved.body.includes('secret-abc'));
  assert.ok(saved.body.includes('A calendar is connected.'));
  assert.ok(!(await get(SETUP_PORT, '/?pin=' + start.pin, null)).body.includes('secret-abc'));
  // The test feed has a self-signed certificate, so the request must fail.
  const body = (await get(PORT, '/calendar')).json;
  assert.strictEqual(body.configured, true);
  assert.ok(body.error);
  assert.ok(!body.error.includes('secret-abc'));
  assert.deepStrictEqual(body.events, []);
  await post(SETUP_PORT, '/save', { pin: start.pin, removeCalendar: '1' });
  assert.deepStrictEqual((await get(PORT, '/calendar')).json, { configured: false, events: [] });
  await get(PORT, '/setup/stop');
});

/* Calendar reading. The parsing functions are private, so this runs its own copy of the
   service with one line added to expose them. */
let calendarCopy = null;

function calendarFunctions() {
  if (calendarCopy) return calendarCopy;
  const source = fs.readFileSync(path.join(__dirname, '../service/service.js'), 'utf8');
  const marker = '  var calendar = { at: 0,';
  assert.ok(source.includes(marker));
  const exposed = source.replace(marker, '  this.calendarForTests = { parseIcs: parseIcs, expandCalendar: expandCalendar };\n' + marker);
  const sandbox = {
    Buffer,
    console,
    setTimeout,
    clearTimeout,
    setInterval() {},
    clearInterval() {},
    require,
    tizen: fakeTizen,
    process: { env: { OMES_A_SHOW_PORT: '18096', OMES_A_SHOW_CONFIG: path.join(dir, 'other.json') } }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(exposed, context);
  const inner = context.calendarForTests;
  // Arrays from another vm context fail deepStrictEqual, so bring results across as JSON.
  calendarCopy = {
    parseIcs: inner.parseIcs,
    expandCalendar: (events, from, to) => JSON.parse(JSON.stringify(inner.expandCalendar(events, from, to)))
  };
  return calendarCopy;
}

const utc = (y, m, d, h, min) => Date.UTC(y, m - 1, d, h || 0, min || 0);
const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT', 'UID:single', 'SUMMARY:Dentist\\, downtown', 'DTSTART;TZID=America/Chicago:20261110T153000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:zulu', 'SUMMARY:Call', 'DTSTART:20261110T200000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:allday', 'SUMMARY:Market', 'DTSTART;VALUE=DATE:20261111', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:gone', 'SUMMARY:Cancelled', 'STATUS:CANCELLED', 'DTSTART:20261110T100000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:long', 'SUMMARY:Folded', ' title', 'DTSTART:20261112T100000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:old', 'SUMMARY:Long ago', 'DTSTART:20200101T100000', 'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

test('reads single, UTC, all-day, cancelled and folded events', async () => {
  const { parseIcs, expandCalendar } = calendarFunctions();
  const out = expandCalendar(parseIcs(ICS), utc(2026, 11, 9), utc(2026, 11, 15));
  assert.deepStrictEqual(out.map((e) => [e.title, e.allDay, e.utc, e.at]), [
    ['Dentist, downtown', false, false, utc(2026, 11, 10, 15, 30)],
    ['Call', false, true, utc(2026, 11, 10, 20)],
    ['Market', true, false, utc(2026, 11, 11)],
    ['Foldedtitle', false, false, utc(2026, 11, 12, 10)]
  ]);
});

function occurrences(rule, extra, from, to) {
  const { parseIcs, expandCalendar } = calendarFunctions();
  const ics = ['BEGIN:VEVENT', 'UID:r', 'SUMMARY:R', 'DTSTART:20260105T090000', 'RRULE:' + rule].concat(extra || [], ['END:VEVENT']).join('\r\n');
  return expandCalendar(parseIcs(ics), from, to).map((e) => new Date(e.at).toISOString().slice(0, 10));
}

test('repeats weekly on chosen days, skipping excluded dates', async () => {
  // 2026-01-05 is a Monday.
  assert.deepStrictEqual(occurrences('FREQ=WEEKLY;BYDAY=MO,TH', ['EXDATE:20261112T090000'], utc(2026, 11, 8), utc(2026, 11, 17)),
    ['2026-11-09', '2026-11-16']);
});

test('repeats every other week', async () => {
  assert.deepStrictEqual(occurrences('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', [], utc(2026, 1, 5), utc(2026, 2, 3)),
    ['2026-01-05', '2026-01-19', '2026-02-02']);
});

test('repeats daily, and respects COUNT and UNTIL', async () => {
  assert.deepStrictEqual(occurrences('FREQ=DAILY;COUNT=3', [], utc(2026, 1, 1), utc(2026, 2, 1)),
    ['2026-01-05', '2026-01-06', '2026-01-07']);
  assert.deepStrictEqual(occurrences('FREQ=DAILY;INTERVAL=2;UNTIL=20260110T000000Z', [], utc(2026, 1, 1), utc(2026, 2, 1)),
    ['2026-01-05', '2026-01-07', '2026-01-09']);
});

test('repeats monthly by date and by weekday, and yearly', async () => {
  assert.deepStrictEqual(occurrences('FREQ=MONTHLY', [], utc(2026, 3, 1), utc(2026, 5, 1)), ['2026-03-05', '2026-04-05']);
  assert.deepStrictEqual(occurrences('FREQ=MONTHLY;BYDAY=2TU', [], utc(2026, 11, 1), utc(2026, 12, 31)), ['2026-11-10', '2026-12-08']);
  assert.deepStrictEqual(occurrences('FREQ=MONTHLY;BYDAY=-1FR', [], utc(2026, 11, 1), utc(2026, 12, 31, 23)), ['2026-11-27', '2026-12-25']);
  assert.deepStrictEqual(occurrences('FREQ=YEARLY', [], utc(2027, 1, 1), utc(2027, 12, 31)), ['2027-01-05']);
});

test('a moved occurrence replaces the original', async () => {
  const { parseIcs, expandCalendar } = calendarFunctions();
  const ics = ['BEGIN:VEVENT', 'UID:w', 'SUMMARY:Class', 'DTSTART:20261102T090000', 'RRULE:FREQ=WEEKLY', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:w', 'SUMMARY:Class moved', 'RECURRENCE-ID:20261109T090000', 'DTSTART:20261110T120000', 'END:VEVENT'].join('\r\n');
  const out = expandCalendar(parseIcs(ics), utc(2026, 11, 8), utc(2026, 11, 12));
  assert.deepStrictEqual(out.map((e) => e.title), ['Class moved']);
});

tvServer.listen(0, '127.0.0.1', async () => {
  loadService(PORT, tvServer.address().port);
  const feed = https.createServer(TLS_FILES, (req, res) => res.end('BEGIN:VCALENDAR'));
  await new Promise((resolve) => feed.listen(0, '127.0.0.1', resolve));
  feedPort = feed.address().port;
  await wait(100);
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('ok - ' + t.name);
    } catch (e) {
      failed++;
      console.log('FAILED - ' + t.name + '\n' + e.message);
    }
  }
  console.log((tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
});
