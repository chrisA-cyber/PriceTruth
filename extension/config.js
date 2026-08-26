'use strict';

// Runtime values are rewritten in downloaded bundles by the PriceTruth server.
// The checked-in defaults keep an unpacked development copy useful and ensure
// this file remains valid without a build step.
(function (global) {
  global.PTConfig = Object.freeze({
    appUrl: 'http://localhost:4780',
    demoHost: 'localhost',
    extensionVersion: '1.0.0',
  });
})(typeof self !== 'undefined' ? self : this);
