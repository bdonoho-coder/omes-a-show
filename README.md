# Omes a Show

A late 90s style home hub for older Samsung TVs (Tizen 3 and up): app tiles, website links, Austin weather, your Google Calendar, a clock and a sleep timer that keeps running while you watch something else.

Omes a Show is a [TizenBrew](https://github.com/reisxd/TizenBrew) app module. It needs TizenBrew, with Developer Mode's Host PC IP set to `127.0.0.1`.

## Install

In TizenBrew, press the green button, choose **Add GitHub Module** and enter `bdonoho-coder/omes-a-show`.

The first time you use the sleep timer or the off button, the TV asks whether to allow Omes a Show. Choose **Allow**: that permission is how it turns the TV off.

## Setup from a phone

Choose **Setup** on the TV and scan the code to add websites or connect a calendar. The setup page is only open while that window is on screen, and it needs the PIN in the code.

Settings, including your calendar's secret address, stay on the TV. They are never part of this repository.

## Layout

- `app/`: the page on the TV. Plain ES5, because older TVs have an old browser.
- `service/service.js`: runs in the background on the TV's Node. It keeps the timer, lists and opens apps, reads the calendar and serves the setup page. Also ES5.
- `test/`: `npm test` runs the service against a fake TV and checks that everything parses as ES5.

To preview the page in a desktop browser, open `app/index.html?mock=1`.

## Credits

- [VT323](https://fonts.google.com/specimen/VT323) font, SIL Open Font License (`app/fonts/OFL-LICENSE.txt`)
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase, MIT license
- Weather from [Open-Meteo](https://open-meteo.com/)
