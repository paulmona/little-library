import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../src/server.js';
import { openDatabase } from '../src/db/index.js';
import { addBook, applyEnrichment, removeBook } from '../src/db/books.js';
import { createSeries, addBooksToSeries, incompleteSeries } from '../src/db/series.js';

const config = {
  port: 0,
  databasePath: ':memory:',
  sheet: { gatewayUrl: '', gatewayToken: '' },
  googleBooks: { apiKey: '' },
  library: { name: 'Test Library' },
};

function library() {
  const db = openDatabase(':memory:');

  const book = (isbn, title) => { addBook(db, isbn); applyEnrichment(db, isbn, { title, author: 'A' }); };
  ['9790000002001', '9790000002002', '9790000002003', '9790000002004', '9790000002005']
    .forEach((isbn, i) => book(isbn, `Book ${i + 1}`));

  // Missing book one — the gifting trap.
  const trap = createSeries(db, { name: 'No First', totalKnown: 4, mustReadInOrder: true });
  addBooksToSeries(db, trap.id, [
    { isbn: '9790000002001', position: 2 },
    { isbn: '9790000002002', position: 4 },
  ]);

  // Started properly, one short.
  const started = createSeries(db, { name: 'Nearly There', totalKnown: 3, mustReadInOrder: true });
  addBooksToSeries(db, started.id, [
    { isbn: '9790000002003', position: 1 },
    { isbn: '9790000002004', position: 2 },
  ]);

  // Open-ended, no total.
  const openEnded = createSeries(db, { name: 'Endless', totalKnown: null, mustReadInOrder: true });
  addBooksToSeries(db, openEnded.id, [{ isbn: '9790000002005', position: 1 }]);

  return { db, app: buildServer(config, db) };
}

test('the grid carries series state on each card', async () => {
  const { app } = library();
  const { books } = (await app.inject({ url: '/api/books' })).json();

  const trapped = books.find((b) => b.isbn === '9790000002001');
  assert.equal(trapped.series.name, 'No First');
  assert.equal(trapped.series.completeness, 'no-first');
  assert.equal(trapped.series.readInOrder, true);
  assert.equal(trapped.series.total, 4);
});

test('standalone books carry no series object at all', async () => {
  const { db, app } = library();
  addBook(db, '9790000002099');
  applyEnrichment(db, '9790000002099', { title: 'Alone', author: 'Z' });

  const { books } = (await app.inject({ url: '/api/books' })).json();
  assert.equal(books.find((b) => b.isbn === '9790000002099').series, undefined);
});

test('missing list covers only started, unfinished series', async () => {
  const { app } = library();
  const { series } = (await app.inject({ url: '/api/missing' })).json();

  const names = series.map((s) => s.name);
  assert.ok(names.includes('No First'));
  assert.ok(names.includes('Nearly There'));
  // No total means nothing can honestly be called missing.
  assert.ok(!names.includes('Endless'));
});

test('nearest to finished comes first', async () => {
  // A series needing one more book is the one worth looking for at a sale.
  const { app } = library();
  const { series } = (await app.inject({ url: '/api/missing' })).json();

  assert.equal(series[0].name, 'Nearly There');
  assert.deepEqual(series[0].missing, [3]);
});

test('missing entries are positions, and the ones held are listed', async () => {
  const { app } = library();
  const { series } = (await app.inject({ url: '/api/missing' })).json();

  const trap = series.find((s) => s.name === 'No First');
  assert.deepEqual(trap.missing, [1, 3]);
  assert.deepEqual(trap.have, [2, 4]);
  assert.equal(trap.books.length, 2);
});

test('a completed series drops off the list', () => {
  const db = openDatabase(':memory:');
  addBook(db, '9790000002010');
  const series = createSeries(db, { name: 'Done', totalKnown: 1 });
  addBooksToSeries(db, series.id, [{ isbn: '9790000002010', position: 1 }]);

  assert.equal(incompleteSeries(db).length, 0);
});

test('taking a book off the shelf puts its series back on the list', () => {
  const db = openDatabase(':memory:');
  for (const isbn of ['9790000002011', '9790000002012']) addBook(db, isbn);
  const series = createSeries(db, { name: 'Was Complete', totalKnown: 2 });
  addBooksToSeries(db, series.id, [
    { isbn: '9790000002011', position: 1 },
    { isbn: '9790000002012', position: 2 },
  ]);
  assert.equal(incompleteSeries(db).length, 0);

  removeBook(db, '9790000002012');

  const incomplete = incompleteSeries(db);
  assert.equal(incomplete.length, 1);
  assert.deepEqual(incomplete[0].missingPositions, [2]);
});

test('the missing page is served as a route', async () => {
  const { app } = library();
  const res = await app.inject({ url: '/api/missing' });
  assert.equal(res.statusCode, 200);
});
