// The TV's browser and Node are old. Anything newer than ES5 fails to parse there.
var acorn = require('acorn');
var fs = require('fs');
var path = require('path');

['app/hub.js', 'service/service.js'].forEach(function (file) {
  var source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  acorn.parse(source, { ecmaVersion: 5 });
  console.log('ok - ' + file + ' parses as ES5');
});
