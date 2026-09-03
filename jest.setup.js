// PHASE-2 deploy gate: jsdom test env pre-Node 18 didn't expose
// TextEncoder / TextDecoder globally. Some backend libs (jsonwebtoken,
// bcryptjs, @aws-sdk/*) reach for them at module load via
// `new TextEncoder()` / `require('util').TextEncoder`. Without this
// polyfill the test suite produced `ReferenceError: TextEncoder is not
// defined` on every backend/__tests__/ file, blocking Pages deploys.
//
// Node 22 ships TextEncoder as a global, but jsdom's test env resolves
// it lazily, so we explicitly attach the Node builtin. Mirrored on the
// global object so both `new TextEncoder()` and `require('util').TextEncoder`
// find it.
const { TextEncoder, TextDecoder } = require('util');
if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = TextDecoder;
}

import '@testing-library/jest-dom';
