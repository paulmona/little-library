import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../src/server.js';
import { openDatabase } from '../src/db/index.js';
import { loadSampleLibrary } from '../src/sample/load.js';

const config = {
  port: 0,
  databasePath: ':memory:',
  sheet: { gatewayUrl: '', gatewayToken: '' },
  googleBooks: { apiKey: '' },
  library: { name: 'Test Library' },
};

function app() {
  const db = openDatabase(':memory:');
  loadSampleLibrary(db);
  return buildServer(config, db);
}

test('GET /api/books returns the library', async () => {
  const res = await app().inject({ method: 'GET', url: '/api/books' });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.equal(body.sort, 'title');
  assert.ok(body.books.length >= 25);
  assert.ok(body.books[0].isbn);
});

test('sort parameter is honoured', async () => {
  const server = app();
  const byAuthor = (await server.inject({ url: '/api/books?sort=author' })).json();
  assert.equal(byAuthor.sort, 'author');

  const authors = byAuthor.books.map((b) => b.author ?? '');
  const sorted = [...authors].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  assert.deepEqual(authors.filter(Boolean), sorted.filter(Boolean));
});

test('an unknown sort falls back instead of erroring', async () => {
  // This is a URL someone might edit by hand; a bad sort shouldn't break the page.
  const res = await app().inject({ url: '/api/books?sort=; DROP TABLE books' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().sort, 'title');
});

test('GET /api/stats reports counts and the library name', async () => {
  const body = (await app().inject({ url: '/api/stats' })).json();
  assert.ok(body.books >= 25);
  assert.ok(body.authors > 5);
  assert.equal(body.library, 'Test Library');
});

test('GET /api/books/:isbn includes the full ordered series', async () => {
  const body = (await app().inject({ url: '/api/books/9790000000302' })).json();

  assert.equal(body.title, 'The Copper Orrery');
  assert.equal(body.series.name, 'The Orrery Sequence');
  assert.equal(body.series.mustReadInOrder, true);

  const positions = body.series.entries.map((e) => e.position);
  assert.deepEqual(positions, [1, 2, 3, 4], 'entries must arrive in reading order');

  // The point of storing entries separately: it knows about books not owned.
  const unowned = body.series.entries.filter((e) => !e.isbn);
  assert.equal(unowned.length, 2);
});

test('a standalone book reports no series rather than an empty one', async () => {
  const body = (await app().inject({ url: '/api/books/9790000000501' })).json();
  assert.equal(body.series, null);
});

test('unknown ISBN is a 404, not a crash', async () => {
  const res = await app().inject({ url: '/api/books/9999999999999' });
  assert.equal(res.statusCode, 404);
});

test('an unenriched book still returns cleanly', async () => {
  // Scanned but never looked up. The UI has to cope, so the API must not 500.
  const res = await app().inject({ url: '/api/books/9790000000602' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().title, null);
  assert.deepEqual(res.json().topics, []);
});

test('the frontend is served', async () => {
  const res = await app().inject({ url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<div class="grid" id="grid">/);
});
