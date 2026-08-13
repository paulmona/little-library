import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../src/server.js';
import { loadConfig, describeCapabilities } from '../src/config.js';

const testConfig = {
  port: 0,
  databasePath: ':memory:',
  sheet: { gatewayUrl: '', gatewayToken: '' },
  googleBooks: { apiKey: '' },
  library: { name: 'Test Library' },
};

test('health endpoint reports ok', async () => {
  const app = buildServer(testConfig);
  const res = await app.inject({ method: 'GET', url: '/health' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
  assert.equal(res.json().library, 'Test Library');
});

test('starts with no configuration at all', () => {
  // A fresh clone has no config.json. The app must still boot, so that
  // `npm start` works before anyone has credentials.
  const config = loadConfig({ path: './definitely-not-a-real-config.json' });

  assert.equal(config.port, 8080);
  assert.equal(config.library.name, 'Little Library');
});

test('malformed config fails loudly rather than silently defaulting', () => {
  // A missing file is fine and falls back to defaults. A file that exists but
  // is broken must not be quietly ignored, or a typo in production config
  // looks identical to having no config at all.
  const path = new URL('./fixtures/malformed.json', import.meta.url).pathname;

  assert.throws(() => loadConfig({ path }), SyntaxError);
});

test('capabilities reflect missing credentials', () => {
  assert.deepEqual(describeCapabilities(testConfig), {
    sheetIngest: false,
    metadataLookup: false,
  });

  const configured = {
    ...testConfig,
    sheet: { gatewayUrl: 'https://example.test/exec', gatewayToken: 'x' },
    googleBooks: { apiKey: 'y' },
  };

  assert.deepEqual(describeCapabilities(configured), {
    sheetIngest: true,
    metadataLookup: true,
  });
});

test('environment overrides file config', () => {
  process.env.LIBRARY_NAME = 'From Env';
  try {
    assert.equal(loadConfig({ path: './nope.json' }).library.name, 'From Env');
  } finally {
    delete process.env.LIBRARY_NAME;
  }
});
