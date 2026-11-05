const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isAppURL, isExternalURL, isTrustedSender } = require('../policy.cjs');
const site = 'https://iangor.github.io/Listik/';
test('only the configured project on its HTTPS origin is trusted', () => {
  assert.equal(isAppURL(site), true);
  assert.equal(isAppURL(site + '?db=test#item'), true);
  assert.equal(isAppURL(site + 'nested/'), true);
  for (const url of ['https://iangor.github.io/Other/', 'https://iangor.github.io/Listik-evil/', 'https://iangor.github.io.evil/Listik/', 'http://iangor.github.io/Listik/', 'https://user@iangor.github.io/Listik/', 'file:///Listik/', 'data:text/html,hi', 'javascript:alert(1)', 'https://iangor.github.io/Listik/%2e%2e/Other/']) {
    assert.equal(isAppURL(url), false, url);
  }
});
test('IPC rejects other windows and child frames', () => {
  const frame = { url: site };
  const contents = { mainFrame: frame };
  assert.equal(isTrustedSender({ sender: contents, senderFrame: frame }, contents), true);
  assert.equal(isTrustedSender({ sender: {}, senderFrame: frame }, contents), false);
  assert.equal(isTrustedSender({ sender: contents, senderFrame: { url: site } }, contents), false);
  frame.url = 'https://iangor.github.io/Other/';
  assert.equal(isTrustedSender({ sender: contents, senderFrame: frame }, contents), false);
});
test('external opening rejects executable schemes and credentials', () => {
  for (const url of ['https://example.org/', 'http://example.org/', 'mailto:a@example.org']) assert.equal(isExternalURL(url), true);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'https://user:pw@example.org']) assert.equal(isExternalURL(url), false);
});
