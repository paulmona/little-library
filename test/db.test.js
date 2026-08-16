import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/db/index.js';
import {
  addBook,
  getBook,
  applyEnrichment,
  applyEdit,
  clearOverride,
  overriddenFields,
  listBooks,
  getStats,
} from '../src/db/books.js';

const fresh = () => openDatabase(':memory:');

test('migrations are idempotent', () => {
  const db = fresh();
  const version = db.prepare('PRAGMA user_version').get().user_version;
  assert.ok(version > 0);

  // Re-running must not throw or duplicate anything.
  const again = fresh();
  assert.equal(again.prepare('PRAGMA user_version').get().user_version, version);
});

test('adding the same ISBN twice is harmless', () => {
  const db = fresh();
  addBook(db, '9780000000001');
  addBook(db, '9780000000001');
  assert.equal(getStats(db).books, 1);
});

test('enrichment populates an empty book', () => {
  const db = fresh();
  addBook(db, '9780000000001');
  applyEnrichment(db, '9780000000001', {
    title: 'A Wizard of Earthsea',
    author: 'Ursula K. Le Guin',
    topics: ['fantasy', 'coming of age'],
    age_min: 10,
    age_max: 14,
  });

  const book = getBook(db, '9780000000001');
  assert.equal(book.title, 'A Wizard of Earthsea');
  assert.deepEqual(book.topics, ['fantasy', 'coming of age']);
  assert.equal(book.age_max, 14);
});

// The critical behaviour of this whole module. If this ever regresses, a
// routine background refresh silently discards work a human did by hand.
test('a human edit survives later enrichment', () => {
  const db = fresh();
  addBook(db, '9780000000001');
  applyEnrichment(db, '9780000000001', { title: 'Original Title', age_min: 8, age_max: 12 });

  applyEdit(db, '9780000000001', { age_min: 10, age_max: 13 });

  // Enrichment runs again and tries to reassert the old values.
  const written = applyEnrichment(db, '9780000000001', {
    title: 'Corrected By Provider',
    age_min: 8,
    age_max: 12,
  });

  const book = getBook(db, '9780000000001');
  assert.equal(book.age_min, 10, 'edited age_min must not be overwritten');
  assert.equal(book.age_max, 13, 'edited age_max must not be overwritten');
  assert.equal(book.title, 'Corrected By Provider', 'unedited fields still update');
  assert.deepEqual(written, ['title']);
});

test('overrides are recorded per field, not per book', () => {
  const db = fresh();
  addBook(db, '9780000000001');
  applyEdit(db, '9780000000001', { genre: 'Horror' });

  assert.deepEqual(overriddenFields(db, '9780000000001'), ['genre']);

  applyEnrichment(db, '9780000000001', { genre: 'Fiction', author: 'Someone' });
  const book = getBook(db, '9780000000001');
  assert.equal(book.genre, 'Horror');
  assert.equal(book.author, 'Someone');
});

test('clearing an override hands the field back to enrichment', () => {
  const db = fresh();
  addBook(db, '9780000000001');
  applyEdit(db, '9780000000001', { genre: 'Horror' });
  clearOverride(db, '9780000000001', 'genre');

  applyEnrichment(db, '9780000000001', { genre: 'Fiction' });
  assert.equal(getBook(db, '9780000000001').genre, 'Fiction');
});

test('editing stamps edited_at, enrichment does not', () => {
  const db = fresh();
  addBook(db, '9780000000001');

  applyEnrichment(db, '9780000000001', { title: 'X' });
  assert.equal(getBook(db, '9780000000001').edited_at, null);
  assert.ok(getBook(db, '9780000000001').enriched_at);

  applyEdit(db, '9780000000001', { title: 'Y' });
  assert.ok(getBook(db, '9780000000001').edited_at);
});

test('enrichment with nothing writable still records the attempt', () => {
  const db = fresh();
  addBook(db, '9780000000001');
  applyEdit(db, '9780000000001', { title: 'Pinned' });

  const written = applyEnrichment(db, '9780000000001', { title: 'Ignored' });
  assert.deepEqual(written, []);
  assert.ok(getBook(db, '9780000000001').enriched_at, 'enriched_at still updates');
});

test('non-enrichable fields are rejected from both paths', () => {
  const db = fresh();
  addBook(db, '9780000000001');

  applyEdit(db, '9780000000001', { isbn: 'tampered', added_at: 'nope' });
  const book = getBook(db, '9780000000001');
  assert.equal(book.isbn, '9780000000001');
  assert.notEqual(book.added_at, 'nope');
});

test('sorting', () => {
  const db = fresh();
  addBook(db, '1', { addedAt: '2020-01-01T00:00:00Z' });
  addBook(db, '2', { addedAt: '2026-01-01T00:00:00Z' });
  applyEnrichment(db, '1', { title: 'Zebra', author: 'Adams', genre: 'Fiction' });
  applyEnrichment(db, '2', { title: 'Apple', author: 'Zeal' });

  assert.deepEqual(listBooks(db, { sort: 'title' }).map((b) => b.title), ['Apple', 'Zebra']);
  assert.deepEqual(listBooks(db, { sort: 'author' }).map((b) => b.author), ['Adams', 'Zeal']);
  assert.deepEqual(listBooks(db, { sort: 'added' }).map((b) => b.isbn), ['2', '1']);
  // Genreless books sort last, not first.
  assert.deepEqual(listBooks(db, { sort: 'genre' }).map((b) => b.isbn), ['1', '2']);
});

test('unknown sort falls back rather than throwing', () => {
  const db = fresh();
  addBook(db, '1');
  assert.doesNotThrow(() => listBooks(db, { sort: 'nonsense; DROP TABLE books' }));
  assert.equal(getStats(db).books, 1);
});

test('stats count distinct authors', () => {
  const db = fresh();
  addBook(db, '1');
  addBook(db, '2');
  addBook(db, '3');
  applyEnrichment(db, '1', { author: 'Same' });
  applyEnrichment(db, '2', { author: 'Same' });
  applyEnrichment(db, '3', { author: 'Different' });

  const stats = getStats(db);
  assert.equal(stats.books, 3);
  assert.equal(stats.authors, 2);
});
