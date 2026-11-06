# Omes a Show

A simple home hub for older Samsung TVs (Tizen 3 and up): app tiles, a clock and a sleep timer that keeps running while you watch something else.

Omes a Show is a [TizenBrew](https://github.com/reisxd/TizenBrew) app module. It needs TizenBrew, with Developer Mode's Host PC IP set to `127.0.0.1`.

## Install

In TizenBrew, press the green button, choose **Add GitHub Module** and enter `bdonoho-coder/omes-a-show`.

The first time you use the sleep timer or the off button, the TV asks whether to allow Omes a Show. Choose **Allow**: that permission is how it turns the TV off.

## Layout

- `app/`: the page on the TV. Plain ES5, because older TVs have an old browser.
- `service/service.js`: runs in the background on the TV's Node. It keeps the timer, lists and opens apps, and sends the power key. Also ES5.
- `test/`: `npm test` runs the service against a fake TV and checks that everything parses as ES5.

To preview the page in a desktop browser, open `app/index.html?mock=1`.
