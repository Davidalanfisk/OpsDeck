import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeWebsiteUrl } from '../shared/website-url.ts';

test('website URLs default to HTTPS and reject credentials or non-web schemes', () => {
  assert.equal(normalizeWebsiteUrl('www.bbc.co.uk'), 'https://www.bbc.co.uk/');
  assert.equal(normalizeWebsiteUrl(' http://127.0.0.1:8080/news '), 'http://127.0.0.1:8080/news');
  assert.throws(() => normalizeWebsiteUrl('javascript:alert(1)'), /http or https/);
  assert.throws(() => normalizeWebsiteUrl('https://user:pass@example.com'), /without credentials/);
});
