import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../src/server.js';
import { openDatabase } from '../src/db/index.js';
import { addBook, applyEnrichment, removeBook } from '../src/db/books.js';
import { seriesState, createSeries, addBooksToSeries } from '../src/db/series.js';

const config = {
  port: 0,
  databasePath: ':memory:',
  sheet: { gatewayUrl: '', gatewayToken: '' },
  googleBooks: { apiKey: '' },
  library: { name: 'Test Library' },
};

/** A library with five books by one author, the Harry Potter shape from the brief. */
function setup() {
  const db = openDatabase(':memory:');
  const rowling = [
    ['9790000001001', "Wizard School and the Stone (Wizard School #1)"],
    ['9790000001002', 'Wizard School and the Chamber (Wizard School #2)'],
    ['9790000001003', 'Wizard School and the Prisoner (Wizard School #3)'],
    ['9790000001004', 'Wizard School and the Goblet (Wizard School #4)'],
    ['9790000001005', 'A Standalone Book For Grown Ups'],
  ];
  for (const [isbn, title] of rowling) {
    addBook(db, isbn);
    applyEnrichment(db, isbn, { title, author: 'J. K. Someone' });
  }
  addBook(db, '9790000001006');
  applyEnrichment(db, '9790000001006', { title: 'Unrelated', author: 'Someone Else' });

  return { db, app: buildServer(config, db) };
}

test('same-author shortlist excludes other authors', async () => {
  const { app } = setup();
  const { books } = (await app.inject({ url: '/api/books/9790000001001/same-author' })).json();

  assert.equal(books.length, 5);
  assert.ok(!books.some((b) => b.title === 'Unrelated'));
});

test('position is pre-filled from the title where it is already there', async () => {
  // 42 books in the real library encode their series number this way.
  const { app } = setup();
  const { books } = (await app.inject({ url: '/api/books/9790000001001/same-author' })).json();

  const third = books.find((b) => b.title.includes('Prisoner'));
  assert.equal(third.suggestedPosition, 3);

  const standalone = books.find((b) => b.title.includes('Standalone'));
  assert.equal(standalone.suggestedPosition, null, 'no number in the title means no guess');
});

test('the full flow: create a series, tick books, get honest missing positions', async () => {
  const { app } = setup();

  const created = (await app.inject({
    method: 'POST',
    url: '/api/series',
    payload: { name: 'Wizard School', totalKnown: 7, mustReadInOrder: true },
  })).json();

  assert.equal(created.name, 'Wizard School');

  await app.inject({
    method: 'POST',
    url: `/api/series/${created.id}/books`,
    payload: {
      books: [
        { isbn: '9790000001001', position: 1 },
        { isbn: '9790000001002', position: 2 },
        { isbn: '9790000001003', position: 3 },
        { isbn: '9790000001004', position: 4 },
      ],
    },
  });

  const state = (await app.inject({ url: `/api/series/${created.id}` })).json();
  assert.equal(state.owned, 4);
  assert.deepEqual(state.ownedPositions, [1, 2, 3, 4]);
  assert.deepEqual(state.missingPositions, [5, 6, 7]);
  assert.equal(state.completeness, 'started');
  assert.equal(state.must_read_in_order, true);
});

test('a series with no total says nothing about what is missing', () => {
  // Never assume the highest owned position is the end of the series.
  const db = openDatabase(':memory:');
  addBook(db, '9790000001010');
  const series = createSeries(db, { name: 'Unknown Length' });
  addBooksToSeries(db, series.id, [{ isbn: '9790000001010', position: 2 }]);

  const state = seriesState(db, series.id);
  assert.deepEqual(state.missingPositions, []);
  assert.equal(state.completeness, 'unknown');
});

test('missing book one is distinguishable from merely incomplete', () => {
  const db = openDatabase(':memory:');
  for (const isbn of ['9790000001011', '9790000001012']) addBook(db, isbn);

  const series = createSeries(db, { name: 'Gap At The Start', totalKnown: 4 });
  addBooksToSeries(db, series.id, [
    { isbn: '9790000001011', position: 2 },
    { isbn: '9790000001012', position: 4 },
  ]);

  const state = seriesState(db, series.id);
  assert.equal(state.completeness, 'no-first', 'this is the case Karen cares about when gifting');
  assert.deepEqual(state.missingPositions, [1, 3]);
});

test('a complete series reports complete', () => {
  const db = openDatabase(':memory:');
  for (const isbn of ['9790000001013', '9790000001014']) addBook(db, isbn);

  const series = createSeries(db, { name: 'Whole Thing', totalKnown: 2 });
  addBooksToSeries(db, series.id, [
    { isbn: '9790000001013', position: 1 },
    { isbn: '9790000001014', position: 2 },
  ]);

  assert.equal(seriesState(db, series.id).completeness, 'complete');
});

test('books with no position are counted but not placed', () => {
  const db = openDatabase(':memory:');
  addBook(db, '9790000001015');
  const series = createSeries(db, { name: 'Unplaced', totalKnown: 3 });
  addBooksToSeries(db, series.id, [{ isbn: '9790000001015', position: null }]);

  const state = seriesState(db, series.id);
  assert.equal(state.owned, 1);
  assert.equal(state.unplaced, 1);
  assert.deepEqual(state.missingPositions, [1, 2, 3], 'an unplaced book fills no position');
});

test('removing a book from a series does not delete the book', async () => {
  const { db, app } = setup();
  const series = createSeries(db, { name: 'Temp', totalKnown: 2 });
  addBooksToSeries(db, series.id, [{ isbn: '9790000001001', position: 1 }]);

  await app.inject({ method: 'DELETE', url: `/api/series/${series.id}/books/9790000001001` });

  assert.equal(seriesState(db, series.id).owned, 0);
  const book = (await app.inject({ url: '/api/books/9790000001001' })).json();
  assert.ok(book.title, 'the book itself survives');
  assert.equal(book.series, null);
});

test('a removed book drops out of its series count', () => {
  const db = openDatabase(':memory:');
  for (const isbn of ['9790000001016', '9790000001017']) addBook(db, isbn);
  const series = createSeries(db, { name: 'Shrinking', totalKnown: 2 });
  addBooksToSeries(db, series.id, [
    { isbn: '9790000001016', position: 1 },
    { isbn: '9790000001017', position: 2 },
  ]);

  removeBook(db, '9790000001017');

  const state = seriesState(db, series.id);
  assert.equal(state.owned, 1);
  assert.deepEqual(state.missingPositions, [2], 'taking a book off the shelf makes it missing again');
});

test('duplicate series names are rejected rather than silently forked', async () => {
  const { app } = setup();
  await app.inject({ method: 'POST', url: '/api/series', payload: { name: 'Only One' } });
  const second = await app.inject({ method: 'POST', url: '/api/series', payload: { name: 'Only One' } });

  assert.equal(second.statusCode, 409);
});

test('a series needs a name', async () => {
  const { app } = setup();
  const res = await app.inject({ method: 'POST', url: '/api/series', payload: { name: '   ' } });
  assert.equal(res.statusCode, 400);
});
