import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runMaintenance } from '../src/server.js';
import { openDatabase } from '../src/db/index.js';
import { addBook, getBook, listBooks, applyEdit } from '../src/db/books.js';
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

test('enrichment does not overwrite what Karen has corrected', async () => {
  const db = openDatabase(':memory:');
  addBook(db, '9780000000006');
  applyEdit(db, '9780000000006', { title: 'The Name She Wants' });

  await runMaintenance(db, noSheet, {
    fetchImpl: fakeFetch({ titles: { 9780000000006: 'What Google Thinks' } }),
  });

  assert.equal(getBook(db, '9780000000006').title, 'The Name She Wants');
});
