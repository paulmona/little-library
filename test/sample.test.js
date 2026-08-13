import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/db/index.js';
import { listBooks, getStats, getBook } from '../src/db/books.js';
import { getSeries, getSeriesEntries, listSeries } from '../src/db/series.js';
import { loadSampleLibrary, readSampleLibrary } from '../src/sample/load.js';

function loaded() {
  const db = openDatabase(':memory:');
  loadSampleLibrary(db);
  return db;
}

test('sample library loads', () => {
  const db = loaded();
  const stats = getStats(db);
  assert.ok(stats.books >= 25, `expected a useful number of books, got ${stats.books}`);
  assert.ok(stats.authors > 5);
});

test('loading twice is idempotent', () => {
  const db = openDatabase(':memory:');
  loadSampleLibrary(db);
  const first = getStats(db);
  loadSampleLibrary(db);
  assert.deepEqual(getStats(db), first);
});

test('contains no real ISBNs', () => {
  // 979-0 is the reserved musical-works prefix and will never be a real book,
  // which is what makes it safe as fake data in a public repo.
  const data = readSampleLibrary();
  for (const book of data.books) {
    assert.match(book.isbn, /^9790000000\d{3}$/, `${book.isbn} does not look deliberately fake`);
  }
});

// Each of these is a display state the grid and missing-books view must handle.
test('covers every series completeness state', () => {
  const db = loaded();

  const complete = getSeries(db, 'The Lantern Keepers');
  const completeEntries = getSeriesEntries(db, complete.id);
  assert.equal(completeEntries.length, 5);
  assert.ok(completeEntries.every((e) => e.isbn), 'complete series should own every entry');

  const hasFirst = getSeries(db, 'Marbury Wood');
  const hasFirstEntries = getSeriesEntries(db, hasFirst.id);
  assert.ok(hasFirstEntries.find((e) => e.position === 1).isbn, 'should own book 1');
  assert.ok(hasFirstEntries.some((e) => !e.isbn), 'should be missing some');

  const missingFirst = getSeries(db, 'The Orrery Sequence');
  const missingFirstEntries = getSeriesEntries(db, missingFirst.id);
  assert.equal(missingFirstEntries.find((e) => e.position === 1).isbn, null, 'should not own book 1');
  assert.ok(missingFirstEntries.some((e) => e.isbn), 'should own something');
});

test('includes a series with an unknown total', () => {
  const db = loaded();
  const unknown = getSeries(db, 'Detective Pepper');
  assert.equal(unknown.total_known, null, 'total must stay NULL, never inferred from what we hold');
  assert.equal(unknown.must_read_in_order, false);
});

test('read-in-order flag is set on the series that need it', () => {
  const db = loaded();
  const ordered = listSeries(db).filter((s) => s.must_read_in_order);
  assert.ok(ordered.length >= 3);
});

test('includes a book with no genre and one with almost nothing', () => {
  const db = loaded();

  const noGenre = getBook(db, '9790000000601');
  assert.ok(noGenre, 'expected the genreless book');
  assert.equal(noGenre.genre, null);

  const minimal = getBook(db, '9790000000602');
  assert.ok(minimal, 'expected the unenriched book');
  assert.equal(minimal.title, null, 'a scanned-but-unknown book is a real state the UI must survive');
});

test('genreless books sort last', () => {
  const db = loaded();
  const byGenre = listBooks(db, { sort: 'genre' });
  const genreless = new Set(['9790000000601', '9790000000602']);

  // Both land at the end. Their order relative to each other is incidental
  // (SQLite puts the NULL title first), so don't assert it.
  const tail = byGenre.slice(-2).map((b) => b.isbn);
  assert.deepEqual(new Set(tail), genreless);
});

test('standalone books outnumber series books', () => {
  const db = loaded();
  const books = listBooks(db);
  const standalone = books.filter((b) => !b.series_id);
  assert.ok(
    standalone.length > books.length / 2,
    'a real little library is mostly standalone books; the sample should reflect that',
  );
});
