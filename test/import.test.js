import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/db/index.js';
import { getBook, getStats, applyEdit, listBooks } from '../src/db/books.js';
import { parseAgeRange, mapRecord, importBooksJson } from '../src/import/books-json.js';

// Synthetic records in the shape the old generator produced. The real
// books.json is never used in tests and never enters this repo.
const OLD_FORMAT = {
  9790000000701: {
    isbn: '9790000000701',
    title: 'The Paper Boat',
    author: 'Vera Lindholm',
    cover: 'https://example.test/cover1.jpg',
    genre: 'Fiction',
    age: '8-12',
    tags: ['rivers', 'friendship'],
    description: 'A boat, some paper.',
    pageCount: 210,
    year: 2019,
    addedAt: '2026-01-02T08:00:00Z',
    series: '',
    seriesNum: '',
  },
  9790000000702: {
    isbn: '9790000000702',
    title: 'Older Readers Only',
    author: 'Kit Marlow',
    cover: '',
    genre: 'Fiction',
    age: '16+',
    tags: [],
    addedAt: '2026-01-03T08:00:00Z',
  },
  // Scanned but never enriched — six of these exist in the real export.
  9790000000703: {
    isbn: '9790000000703',
    addedAt: '2026-01-04T08:00:00Z',
  },
};

test('parses the age formats the old app produced', () => {
  assert.deepEqual(parseAgeRange('8-12'), { age_min: 8, age_max: 12 });
  assert.deepEqual(parseAgeRange('16+'), { age_min: 16, age_max: null });
  assert.deepEqual(parseAgeRange('10'), { age_min: 10, age_max: 10 });
});

test('an unparseable age is left unset rather than guessed', () => {
  // A wrong age on a book being chosen for a child is worse than no age.
  for (const value of ['', 'all ages', undefined, null, 'YA']) {
    assert.deepEqual(parseAgeRange(value), { age_min: null, age_max: null });
  }
});

test('maps the old field names onto the schema', () => {
  const mapped = mapRecord(OLD_FORMAT['9790000000701']);
  assert.equal(mapped.cover_url, 'https://example.test/cover1.jpg');
  assert.deepEqual(mapped.topics, ['rivers', 'friendship']);
  assert.equal(mapped.page_count, 210);
  assert.equal(mapped.age_max, 12);
});

test('empty strings become null rather than empty text', () => {
  const mapped = mapRecord(OLD_FORMAT['9790000000702']);
  assert.equal(mapped.cover_url, null, 'an empty cover must be NULL so sorting and fallbacks work');
});

test('imports every record, including unenriched ones', () => {
  const db = openDatabase(':memory:');
  const result = importBooksJson(db, OLD_FORMAT);

  assert.deepEqual(result, { imported: 3, unenriched: 1 });
  assert.equal(getStats(db).books, 3);
});

test('preserves the original added date', () => {
  // Stamping everything with the import date would destroy "recently added".
  const db = openDatabase(':memory:');
  importBooksJson(db, OLD_FORMAT);

  assert.equal(getBook(db, '9790000000701').added_at, '2026-01-02T08:00:00Z');
});

test('re-importing does not duplicate or lose edits', () => {
  const db = openDatabase(':memory:');
  importBooksJson(db, OLD_FORMAT);

  applyEdit(db, '9790000000701', { genre: 'Corrected By Karen' });
  importBooksJson(db, OLD_FORMAT);

  assert.equal(getStats(db).books, 3);
  assert.equal(getBook(db, '9790000000701').genre, 'Corrected By Karen');
});

test('unenriched books still sort last after an import', () => {
  const db = openDatabase(':memory:');
  importBooksJson(db, OLD_FORMAT);

  assert.equal(listBooks(db, { sort: 'title' }).at(-1).isbn, '9790000000703');
});
