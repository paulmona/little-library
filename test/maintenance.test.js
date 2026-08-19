import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runMaintenance } from '../src/server.js';
import { openDatabase } from '../src/db/index.js';
import { addBook, getBook, listBooks, applyEdit, getStats, removeBook } from '../src/db/books.js';
import { enrichLibrary } from '../src/enrich/run.js';

const config = {
  port: 0,
  databasePath: ':memory:',
  sheet: { gatewayUrl: 'https://gateway.example/exec', gatewayToken: 't' },
  googleBooks: { apiKey: '' },
  library: { name: 'Test Library' },
};

const noSheet = { ...config, sheet: { gatewayUrl: '', gatewayToken: '' } };

/** A fetch that answers the sheet gateway and Google Books, and nothing else. */
function fakeFetch({ sheetIsbns = [], titles = {}, fail = false } = {}) {
  return async (url) => {
    if (fail) throw new Error('getaddrinfo ENOTFOUND');

    if (url.startsWith('https://gateway.example/exec')) {
      return {
        ok: true,
        json: async () => ({ ok: true, books: sheetIsbns.map((isbn) => ({ isbn, ts: '' })) }),
      };
    }

    if (url.includes('googleapis.com/books')) {
      const isbn = url.match(/isbn:(\w+)/)?.[1];
      const title = titles[isbn];
      if (!title) return { ok: true, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          items: [{ volumeInfo: { title, authors: ['A Writer'], categories: ['Fiction'] } }],
        }),
      };
    }

    // Open Library and the cover fallback: recognise nothing.
    return { ok: true, json: async () => ({}) };
  };
}

test('a scanned ISBN becomes a real entry without anyone running a command', async () => {
  // The whole point: the container has no one to type `npm run enrich`.
  const db = openDatabase(':memory:');
  const fetchImpl = fakeFetch({
    sheetIsbns: ['9780000000001'],
    titles: { 9780000000001: 'The Discovered Book' },
  });

  const result = await runMaintenance(db, config, { fetchImpl });

  assert.equal(result.added, 1);
  assert.equal(result.enriched, 1);
  assert.equal(getBook(db, '9780000000001').title, 'The Discovered Book');
});

test('books already in the database get enriched too, not just new arrivals', async () => {
  const db = openDatabase(':memory:');
  addBook(db, '9780000000002');

  const result = await runMaintenance(db, noSheet, {
    fetchImpl: fakeFetch({ titles: { 9780000000002: 'Already Here' } }),
  });

  assert.equal(result.enriched, 1);
  assert.equal(getBook(db, '9780000000002').title, 'Already Here');
});

test('a pass over an enriched library does nothing and costs nothing', async () => {
  const db = openDatabase(':memory:');
  addBook(db, '9780000000003');
  const fetchImpl = fakeFetch({ titles: { 9780000000003: 'Done Already' } });

  await runMaintenance(db, noSheet, { fetchImpl });
  const second = await runMaintenance(db, noSheet, { fetchImpl });

  assert.equal(second.enriched, 0, 'the second pass should find nothing to do');
});

test('an unreachable sheet does not stop enrichment', async () => {
  // Karen must still get metadata when the gateway is down.
  const db = openDatabase(':memory:');
  addBook(db, '9780000000004');

  const fetchImpl = async (url) => {
    if (url.startsWith('https://gateway.example/exec')) throw new Error('gateway down');
    if (url.includes('googleapis.com/books')) {
      return {
        ok: true,
        json: async () => ({ items: [{ volumeInfo: { title: 'Survived', authors: [] } }] }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  const result = await runMaintenance(db, config, { fetchImpl });

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /sheet sync/);
  assert.equal(result.enriched, 1, 'enrichment still ran');
});

test('runMaintenance never throws, whatever the network does', async () => {
  const db = openDatabase(':memory:');
  addBook(db, '9780000000005');

  const result = await runMaintenance(db, config, { fetchImpl: fakeFetch({ fail: true }) });

  assert.ok(result.errors.length > 0);
  assert.equal(result.enriched, 0);
});

test('a total outage does not burn the whole library as attempted', async () => {
  // Every lookup failing stamps enriched_at, which would mean these books are
  // never retried. If the container starts before the network is up, that
  // would silently cost the entire catalogue until someone ran --refresh.
  const db = openDatabase(':memory:');
  for (let i = 0; i < 40; i += 1) addBook(db, `978000000${String(i).padStart(4, '0')}`);

  await runMaintenance(db, noSheet, { fetchImpl: fakeFetch({ fail: true }) });

  const stamped = listBooks(db).filter((b) => b.enriched_at).length;
  assert.ok(stamped < 15, `expected the pass to give up early, but it stamped ${stamped} of 40`);
});

test('the outage guard does not fire on a library of genuinely unknown ISBNs', async () => {
  // Without a threshold this is indistinguishable from an outage, so the
  // default has to leave the CLI's behaviour alone.
  const db = openDatabase(':memory:');
  for (let i = 0; i < 20; i += 1) addBook(db, `979000000${String(i).padStart(4, '0')}`);

  const run = await enrichLibrary(db, { fetchImpl: fakeFetch({}), delayMs: 0 });

  assert.equal(run.abandoned, false);
  assert.equal(run.failed, 20, 'every book was attempted and stamped');
});

test('stats report how many books are still waiting to be looked up', async () => {
  // This is what tells a cover that does not exist from one that has not
  // arrived yet. Without it, a half-loaded library looks like a broken one.
  const db = openDatabase(':memory:');
  addBook(db, '9780000000007');
  addBook(db, '9780000000008');

  assert.equal(getStats(db).pending, 2);

  await runMaintenance(db, noSheet, {
    fetchImpl: fakeFetch({ titles: { 9780000000007: 'Found' } }),
  });

  // Both were attempted; one resolved, one did not. Neither is still pending.
  assert.equal(getStats(db).pending, 0, 'an attempted book is not still waiting');
});

test('a removed book is not counted as pending forever', () => {
  const db = openDatabase(':memory:');
  addBook(db, '9780000000009');
  assert.equal(getStats(db).pending, 1);

  removeBook(db, '9780000000009');
  assert.equal(getStats(db).pending, 0);
});

test('enrichment does not overwrite what Karen has corrected', async () => {
  const db = openDatabase(':memory:');
  addBook(db, '9780000000006');
  applyEdit(db, '9780000000006', { title: 'The Name She Wants' });

  await runMaintenance(db, noSheet, {
    fetchImpl: fakeFetch({ titles: { 9780000000006: 'What Google Thinks' } }),
  });

  assert.equal(getBook(db, '9780000000006').title, 'The Name She Wants');
});

// ---------------------------------------------------------- degraded sources

/**
 * The bug these cover: on 2026-08-16 the container's only enrichment pass ran
 * while Open Library was down. Google answered with metadata but no jacket for
 * 28 books, so they were written with an empty cover and stamped as finished.
 * A stamped book is never retried, so those covers were lost silently and had
 * to be backfilled by hand three days later.
 */

/** Google answers with metadata but no cover; Open Library is unreachable. */
function outageFetch({ status = null } = {}) {
  return async (url) => {
    if (url.includes('googleapis.com/books')) {
      if (url.includes('intitle:')) return { ok: true, json: async () => ({ items: [] }) };
      return {
        ok: true,
        json: async () => ({
          items: [{ volumeInfo: { title: 'Metadata Only', authors: ['A Writer'], categories: ['Fiction'] } }],
        }),
      };
    }
    // Open Library: down, either by transport error or by a retryable status.
    if (status) return { ok: false, status, json: async () => ({}) };
    throw new Error('ETIMEDOUT');
  };
}

test('a book is not written off as coverless when the cover source was down', async () => {
  const db = openDatabase(':memory:');
  addBook(db, '9780000000020');

  await runMaintenance(db, noSheet, { fetchImpl: outageFetch() });

  const book = getBook(db, '9780000000020');
  assert.equal(book.title, 'Metadata Only', 'what did arrive is kept');
  assert.equal(book.cover_url, null);
  assert.equal(book.enriched_at, null, 'but it is NOT marked finished');
  assert.equal(getStats(db).pending, 1, 'so it is still queued for another look');
});

test('the retry succeeds once the source comes back', async () => {
  const db = openDatabase(':memory:');
  addBook(db, '9780000000021');

  await runMaintenance(db, noSheet, { fetchImpl: outageFetch() });
  assert.equal(getBook(db, '9780000000021').cover_url, null);

  // Open Library recovers and supplies the jacket.
  const recovered = async (url) => {
    if (url.includes('googleapis.com/books')) {
      return { ok: true, json: async () => ({ items: [{ volumeInfo: { title: 'Metadata Only', authors: ['A Writer'] } }] }) };
    }
    return {
      ok: true,
      json: async () => ({ 'ISBN:9780000000021': { title: 'Metadata Only', cover: { medium: 'https://covers.example/1.jpg' } } }),
    };
  };
  await runMaintenance(db, noSheet, { fetchImpl: recovered });

  const book = getBook(db, '9780000000021');
  assert.equal(book.cover_url, 'https://covers.example/1.jpg');
  assert.ok(book.enriched_at, 'and now it is finished');
  assert.equal(getStats(db).pending, 0);
});

test('a 429 or a 500 counts as down, a 404 counts as an answer', async () => {
  for (const status of [429, 503]) {
    const db = openDatabase(':memory:');
    addBook(db, '9780000000022');
    await runMaintenance(db, noSheet, { fetchImpl: outageFetch({ status }) });
    assert.equal(getBook(db, '9780000000022').enriched_at, null, `${status} should leave it pending`);
  }

  // 404 from Open Library is a real answer: this edition has no record there.
  const db = openDatabase(':memory:');
  addBook(db, '9780000000023');
  await runMaintenance(db, noSheet, { fetchImpl: outageFetch({ status: 404 }) });
  const book = getBook(db, '9780000000023');
  assert.ok(book.enriched_at, '404 means the book really has no cover, so stop asking');
  assert.equal(book.cover_url, null);
});

test('an unrecognised ISBN is still stamped, so it is not retried forever', async () => {
  // The distinction that matters: nobody has heard of this book, but everyone
  // answered. That is settled, unlike an outage.
  const db = openDatabase(':memory:');
  addBook(db, '9790000009999');

  await runMaintenance(db, noSheet, { fetchImpl: fakeFetch({}) });

  assert.ok(getBook(db, '9790000009999').enriched_at);
  assert.equal(getStats(db).pending, 0);
});

test('a total outage leaves everything pending rather than stamped', async () => {
  const db = openDatabase(':memory:');
  for (let i = 0; i < 6; i += 1) addBook(db, `978000001${String(i).padStart(4, '0')}`);

  const result = await runMaintenance(db, noSheet, { fetchImpl: fakeFetch({ fail: true }) });

  assert.equal(result.enriched, 0);
  assert.equal(getStats(db).pending, 6, 'nothing was written off');
});
