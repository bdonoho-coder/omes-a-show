#!/usr/bin/env node
// Sends a folder of PNG icons from this PC to the TV. Icons stay on the TV, because icon
// packs often can't be redistributed through a public repository.
//
// On the TV, choose Setup and leave that window open. Then run:
//   node tools/send-icons.js "http://TV-IP:8095/?pin=123456" "C:\path\to\icons" [--logo "Name.png"]
const fs = require('fs');
const http = require('http');
const path = require('path');

const [address, folder, flag, logoFile] = process.argv.slice(2);
if (!address || !folder || (flag && (flag !== '--logo' || !logoFile))) {
  console.error('Usage: node tools/send-icons.js "<address shown on the TV>" "<folder>" [--logo "Name.png"]');
  process.exit(1);
}

const setup = new URL(address);
const pin = setup.searchParams.get('pin');

function slug(file) {
  return path.basename(file, '.png').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function send(file, name) {
  return new Promise((resolve, reject) => {
    const query = '/icon?pin=' + encodeURIComponent(pin) + '&name=' + encodeURIComponent(name);
    const req = http.request({ host: setup.hostname, port: setup.port, path: query, method: 'POST' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error(name + ': ' + body))));
    });
    req.on('error', reject);
    req.end(fs.readFileSync(path.join(folder, file)));
  });
}

(async () => {
  const files = fs.readdirSync(folder).filter((file) => /\.png$/i.test(file));
  for (const file of files) await send(file, slug(file));
  if (logoFile) await send(logoFile, 'omes-logo');
  console.log('Sent ' + files.length + ' icons' + (logoFile ? ' and the logo' : '') + '.');
})().catch((e) => {
  console.error('Stopped: ' + e.message);
  process.exit(1);
});
