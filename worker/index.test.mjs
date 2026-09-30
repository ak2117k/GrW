import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { apiOrigin } from './index.js';

test('apiOrigin prefers env.API_ORIGIN', () => {
  assert.equal(apiOrigin({ API_ORIGIN: 'https://api.example.in' }), 'https://api.example.in');
});

test('apiOrigin falls back to the Render origin when unset', () => {
  assert.equal(apiOrigin({}), 'https://grw-api.onrender.com');
});

test('API paths are proxied to the configured origin with path and query intact', async () => {
  let seen;
  globalThis.fetch = async (url) => { seen = url; return new Response('ok'); };
  const env = { API_ORIGIN: 'https://api.example.in', ASSETS: { fetch: () => new Response('asset') } };
  await worker.fetch(new Request('https://grw.example.dev/api/market?x=1'), env);
  assert.equal(seen, 'https://api.example.in/api/market?x=1');
});

test('non-API paths are served from assets', async () => {
  const env = { ASSETS: { fetch: () => new Response('asset') } };
  const res = await worker.fetch(new Request('https://grw.example.dev/dashboard'), env);
  assert.equal(await res.text(), 'asset');
});
