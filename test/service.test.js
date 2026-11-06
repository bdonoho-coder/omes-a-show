// Runs service.js the way TizenBrew does (vm.runInContext with a copy of the globals), with
// a fake Tizen API, a fake clock and a fake TV remote channel.
const assert = require('assert');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const tls = require('tls');
const vm = require('vm');

const ORIGIN = 'http://127.0.0.1:8081';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omes-a-show-'));
const CONFIG = path.join(dir, 'config.json');
const ICON = path.join(dir, 'icon.png');
fs.writeFileSync(ICON, 'png-bytes');

execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=tv', '-days', '1',
  '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });

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

const tvServer = tls.createServer({
  key: fs.readFileSync(path.join(dir, 'key.pem')),
  cert: fs.readFileSync(path.join(dir, 'cert.pem'))
}, (socket) => {
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
const fakeTizen = {
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
    launch(id, ok, fail) {
      if (id === 'AbCdEfGhIj.SomeApp') return fail(new Error('refused'));
      launched.push(id);
      ok();
    }
  }
};

/* Fake clock: the service's sleep ticker only runs when the test says so. */
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
    env: { OMES_A_SHOW_PORT: String(port), TV_PORT: String(tvPort), OMES_A_SHOW_CONFIG: CONFIG }
  };
  sandbox.setInterval = (fn) => { clock.tickers.add(fn); return fn; };
  sandbox.clearInterval = (fn) => { clock.tickers.delete(fn); };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../service/service.js'), 'utf8'), vm.createContext(sandbox));
}

function get(port, urlPath, origin) {
  return new Promise((resolve, reject) => {
    const headers = origin === null ? {} : { Origin: origin || ORIGIN };
    http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { /* icon */ }
        resolve({ code: res.statusCode, json, body, headers: res.headers });
      });
    }).on('error', reject);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => Array.from(clock.tickers).forEach((fn) => fn());
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const PORT = 18092;

test('rejects other origins, and requests with no origin', async () => {
  assert.strictEqual((await get(PORT, '/status', 'https://evil.example')).code, 403);
  assert.strictEqual((await get(PORT, '/power', null)).code, 403);
  assert.strictEqual((await get(PORT, '/sleep?minutes=15', 'https://youtube.com')).code, 403);
  assert.strictEqual(clock.tickers.size, 0);
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
  assert.strictEqual(clock.tickers.size, 0);
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
  assert.strictEqual(clock.tickers.size, 1);
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

tvServer.listen(0, '127.0.0.1', async () => {
  loadService(PORT, tvServer.address().port);
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
