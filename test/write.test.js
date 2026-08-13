import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../src/server.js';
import { openDatabase } from '../src/db/index.js';
import { loadSampleLibrary } from '../src/sample/load.js';
import { getBook, getStats, applyEnrichment, addBook, removeBook } from '../src/db/books.js';
import { importBooksJson } from '../src/import/books-json.js';

const config = {
  port: 0,
  databasePath: ':memory:',
  sheet: { gatewayUrl: '', gatewayToken: '' },
  googleBooks: { apiKey: '' },
  library: { name: 'Test Library' },
};

function setup() {
  const db = openDatabase(':memory:');
  loadSampleLibrary(db);
  return { db, app: buildServer(config, db) };
}

const SOME_BOOK = '9790000000501';

test('PATCH edits a book and pins the fields', async () => {
  const { db, app } = setup();

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/books/${SOME_BOOK}`,
    payload: { age_min: 11, age_max: 15 },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().changed.sort(), ['age_max', 'age_min']);
  assert.equal(getBook(db, SOME_BOOK).age_min, 11);

  // The pin is the point: enrichment must not undo it.
  applyEnrichment(db, SOME_BOOK, { age_min: 9, age_max: 12 });
  assert.equal(getBook(db, SOME_BOOK).age_min, 11);
});

test('PATCH sets edited_at', async () => {
  const { db, app } = setup();
  assert.equal(getBook(db, SOME_BOOK).edited_at, null);

  await app.inject({ method: 'PATCH', url: `/api/books/${SOME_BOOK}`, payload: { genre: 'Adventure' } });
  assert.ok(getBook(db, SOME_BOOK).edited_at);
});

test('PATCH with nothing editable is a 400, not a silent success', async () => {
  const { app } = setup();
  const res = await app.inject({ method: 'PATCH', url: `/api/books/${SOME_BOOK}`, payload: { isbn: 'hacked' } });
  assert.equal(res.statusCode, 400);
});

test('PATCH on an unknown book is a 404', async () => {
  const { app } = setup();
  const res = await app.inject({ method: 'PATCH', url: '/api/books/0000000000000', payload: { genre: 'x' } });
  assert.equal(res.statusCode, 404);
});

test('DELETE tombstones rather than destroying', async () => {
  const { db, app } = setup();
  const before = getStats(db).books;

  const res = await app.inject({ method: 'DELETE', url: `/api/books/${SOME_BOOK}` });
  assert.equal(res.statusCode, 200);

  assert.equal(getStats(db).books, before - 1, 'stats exclude removed books');
  assert.equal(getBook(db, SOME_BOOK), null, 'normal reads hide it');
  assert.ok(getBook(db, SOME_BOOK, { includeRemoved: true }).removed_at, 'the row is still there');
});

test('a removed book stays gone when the sheet re-offers it', async () => {
  // The whole reason for tombstones. The ISBN stays in the Google Sheet after
  // Karen takes the book off the shelf, so an import would otherwise resurrect it.
  const { db, app } = setup();
  await app.inject({ method: 'DELETE', url: `/api/books/${SOME_BOOK}` });

  addBook(db, SOME_BOOK);

  assert.equal(getBook(db, SOME_BOOK), null, 'a re-scan must not bring a removed book back');
});

test('re-importing books.json does not resurrect a removed book', async () => {
  const db = openDatabase(':memory:');
  const record = {
    9790000000901: { isbn: '9790000000901', title: 'Gone Book', author: 'A', addedAt: '2026-01-01T00:00:00Z' },
  };
  importBooksJson(db, record);
  removeBook(db, '9790000000901');

  importBooksJson(db, record);
  assert.equal(getBook(db, '9790000000901'), null);
});

test('removing a book leaves its series entry, flipped to unowned', async () => {
  // This is what feeds the missing-books view: the entry must survive.
  const { db, app } = setup();
  const owned = '9790000000101';

  await app.inject({ method: 'DELETE', url: `/api/books/${owned}` });

  const entries = db.prepare(
    'SELECT COUNT(*) AS n FROM series_entries WHERE isbn = ?',
  ).get(owned);
  assert.equal(entries.n, 1, 'the series entry must not be deleted with the book');
});

test('restore brings a book back', async () => {
  const { db, app } = setup();
  const before = getStats(db).books;

  await app.inject({ method: 'DELETE', url: `/api/books/${SOME_BOOK}` });
  const res = await app.inject({ method: 'POST', url: `/api/books/${SOME_BOOK}/restore` });

  assert.equal(res.statusCode, 200);
  assert.equal(getStats(db).books, before);
  assert.ok(getBook(db, SOME_BOOK));
});

test('restoring a book that was never removed is a 404', async () => {
  const { app } = setup();
  const res = await app.inject({ method: 'POST', url: `/api/books/${SOME_BOOK}/restore` });
  assert.equal(res.statusCode, 404);
});

test('a removed book disappears from the grid listing', async () => {
  const { app } = setup();
  await app.inject({ method: 'DELETE', url: `/api/books/${SOME_BOOK}` });

  const { books } = (await app.inject({ url: '/api/books' })).json();
  assert.ok(!books.some((b) => b.isbn === SOME_BOOK));
});
