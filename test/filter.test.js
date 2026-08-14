import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The filter predicate lives in the browser bundle, so it is reimplemented here
 * against the same rules. These tests pin the *behaviour* that matters — how
 * unknown values are treated, and that filters stack — rather than the code.
 *
 * The rules under test:
 *   - a book with no age range cannot be confirmed suitable, so an age filter
 *     excludes it rather than assuming
 *   - filters combine; each narrows what the others left
 */

function matches(book, { query = '', genre = '', series = '', age = null } = {}) {
  if (query) {
    const haystack = `${book.title ?? ''} ${book.author ?? ''} ${book.series_name ?? ''} ${(book.topics ?? []).join(' ')}`;
    if (!haystack.toLowerCase().includes(query)) return false;
  }
  if (genre && book.genre !== genre) return false;

  if (age !== null) {
    if (book.age_min === null && book.age_max === null) return false;
    if (book.age_min !== null && age < book.age_min) return false;
    if (book.age_max !== null && age > book.age_max) return false;
  }

  if (series) {
    const inSeries = Boolean(book.series_id);
    if (series === 'in' && !inSeries) return false;
    if (series === 'standalone' && inSeries) return false;
    if (series === 'order' && !book.series?.readInOrder) return false;
    if (series === 'nofirst' && book.series?.completeness !== 'no-first') return false;
  }
  return true;
}

const fantasy = {
  title: 'Dragon Book', author: 'A Writer', genre: 'Fantasy', topics: ['dragons'],
  age_min: 8, age_max: 12, series_id: 1, series_name: 'Dragons',
  series: { readInOrder: true, completeness: 'no-first' },
};

const picture = {
  title: 'Sleepy Bear', author: 'B Writer', genre: 'Picture book', topics: [],
  age_min: 2, age_max: 5, series_id: null,
};

const unknownAge = {
  title: 'Mystery Age', author: 'C Writer', genre: 'Fiction', topics: [],
  age_min: null, age_max: null, series_id: null,
};

const safeSeries = {
  title: 'Book One', author: 'D Writer', genre: 'Fantasy', topics: [],
  age_min: 9, age_max: 13, series_id: 2, series_name: 'Complete Thing',
  series: { readInOrder: true, completeness: 'complete' },
};

test('genre filter', () => {
  assert.equal(matches(fantasy, { genre: 'Fantasy' }), true);
  assert.equal(matches(picture, { genre: 'Fantasy' }), false);
});

test('age matches when it falls inside the range', () => {
  assert.equal(matches(fantasy, { age: 10 }), true);
  assert.equal(matches(fantasy, { age: 4 }), false);
  assert.equal(matches(picture, { age: 4 }), true);
});

test('a book with no age range is excluded rather than assumed suitable', () => {
  // 168 of the real library have no age data. Guessing would put an adult
  // novel in front of a request for something for a six-year-old.
  assert.equal(matches(unknownAge, { age: 6 }), false);
  assert.equal(matches(unknownAge, {}), true, 'but it is visible when not filtering by age');
});

test('open-ended ages still match above the minimum', () => {
  const teen = { title: 'Older', age_min: 13, age_max: null, topics: [] };
  assert.equal(matches(teen, { age: 15 }), true);
  assert.equal(matches(teen, { age: 9 }), false);
});

test('series status filters', () => {
  assert.equal(matches(fantasy, { series: 'in' }), true);
  assert.equal(matches(picture, { series: 'in' }), false);
  assert.equal(matches(picture, { series: 'standalone' }), true);
  assert.equal(matches(fantasy, { series: 'order' }), true);
  assert.equal(matches(fantasy, { series: 'nofirst' }), true);
  assert.equal(matches(safeSeries, { series: 'nofirst' }), false, 'a complete series is not missing book 1');
});

test('filters stack', () => {
  const books = [fantasy, picture, unknownAge, safeSeries];

  // "Fantasy, for a ten-year-old" — both fantasy books qualify on genre,
  // both on age, so the series filter is what separates them.
  const both = books.filter((b) => matches(b, { genre: 'Fantasy', age: 10 }));
  assert.deepEqual(both.map((b) => b.title), ['Dragon Book', 'Book One']);

  const safe = books.filter((b) => matches(b, { genre: 'Fantasy', age: 10, series: 'nofirst' }));
  assert.deepEqual(safe.map((b) => b.title), ['Dragon Book']);
});

test('search combines with filters and covers topics', () => {
  assert.equal(matches(fantasy, { query: 'dragons' }), true, 'topics are searchable');
  assert.equal(matches(fantasy, { query: 'dragons', genre: 'Picture book' }), false);
});

test('no filters means everything passes', () => {
  for (const book of [fantasy, picture, unknownAge, safeSeries]) {
    assert.equal(matches(book, {}), true);
  }
});
