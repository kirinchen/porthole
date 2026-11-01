import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxCsp, untrustedApiRequest, RUN_SANDBOX } from './sandbox.ts';

test('sandboxCsp:HTML 給 allow-scripts、SVG 純 sandbox、其他不加;run 一律 sandbox', () => {
  assert.equal(sandboxCsp('.html', false), RUN_SANDBOX);
  assert.equal(sandboxCsp('.svg', false), 'sandbox');
  assert.equal(sandboxCsp('.png', false), null);
  assert.equal(sandboxCsp('.pdf', false), null);
  assert.equal(sandboxCsp('.js', true), RUN_SANDBOX);
  assert.ok(!RUN_SANDBOX.includes('allow-same-origin'));
});

test('untrustedApiRequest:擋 opaque origin 與跨站,放行同源與 curl', () => {
  assert.equal(untrustedApiRequest({ origin: 'null', 'sec-fetch-site': 'cross-site' }), true);
  assert.equal(untrustedApiRequest({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }), true);
  assert.equal(untrustedApiRequest({ origin: 'http://100.114.93.81:4321', 'sec-fetch-site': 'same-origin' }), false);
  assert.equal(untrustedApiRequest({ 'sec-fetch-site': 'none' }), false);
  assert.equal(untrustedApiRequest({}), false);
});
