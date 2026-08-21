'use strict';

// Compatibility shim for `npm test` (`node --test test/`) on Windows.
//
// On this platform/Node build the test runner does not expand a directory
// argument into its *.test.js files; it spawns `node <dir>` as if the
// directory were a single test file. The CJS loader then resolves the
// directory to this index.js, so requiring the suites here makes the fixed
// `node --test test/` invocation run everything in one child process.
//
// On runners that DO expand the directory, each *.test.js file runs in its
// own process and this file may be matched as a test file itself; in that
// case process.argv[1] points at index.js and we do nothing, so no suite
// ever runs twice.

const path = require('node:path');

if (path.basename(process.argv[1] || '') !== 'index.js') {
  require('./engine.test.js');
  require('./security.test.js');
  require('./api.test.js');
  require('./extzip.test.js');
}
