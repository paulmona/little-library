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

test('deep-linking to a book serves the app shell, not a 404', async () => {
  // The card used to link straight at the API and render raw JSON in the
  // browser. /book/<isbn> must serve the page so a refresh or a shared link works.
  const res = await app().inject({ url: '/book/9790000000302' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<div id="detail-view"/);
});

test('the grid links to the app route, never to the API', async () => {
  const res = await app().inject({ url: '/app.js' });
  assert.match(res.body, /href="\/book\//);
  assert.doesNotMatch(res.body, /class="book-card" href="\/api\//);
});

test('the list endpoint omits fields the grid never renders', async () => {
  // description alone was 201 KB of a 584 KB response across a real 643-book
  // library. The detail endpoint still returns it.
  const { books } = (await app().inject({ url: '/api/books' })).json();
  const book = books.find((b) => b.title);

  assert.equal(book.description, undefined, 'description belongs to the detail view only');
  assert.equal(book.page_count, undefined);
  assert.equal(book.year, undefined);

  // Everything a card draws must still be there.
  for (const field of ['isbn', 'title', 'author', 'cover_url', 'genre', 'topics']) {
    assert.ok(field in book, `grid needs ${field}`);
  }
});

test('the detail endpoint still returns the full record', async () => {
  const body = (await app().inject({ url: '/api/books/9790000000501' })).json();
  assert.ok('description' in body);
  assert.ok('year' in body);
});
