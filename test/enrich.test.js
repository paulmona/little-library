import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/db/index.js';
import { addBook, getBook, applyEdit } from '../src/db/books.js';
import { inferGenre, inferAge, inferTags, inferSeries, stripHtml } from '../src/enrich/infer.js';
import { enrichIsbn, coverFromOtherEdition } from '../src/enrich/lookup.js';
import { enrichLibrary } from '../src/enrich/run.js';
import { normaliseIsbn, ingestIsbns, syncFromSheet } from '../src/sheet/ingest.js';

/** Minimal fake fetch: routes by URL substring, so no test touches the network. */
function fakeFetch(routes) {
  return async (url) => {
    for (const [needle, body] of Object.entries(routes)) {
      if (url.includes(needle)) {
        if (body === 'ERROR') return { ok: false, status: 500 };
        return { ok: true, json: async () => body };
      }
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

// ------------------------------------------------------------------ inference

test('genre inference matches the original rules', () => {
  assert.equal(inferGenre(['Dragons, fiction'], 'The Dragon'), 'Fantasy');
  assert.equal(inferGenre(['Detective stories'], ''), 'Mystery');
  assert.equal(inferGenre([], ''), 'Fiction');
});

test('age inference returns the old display strings', () => {
  assert.equal(inferAge(['Young adult fiction']), '13+');
  assert.equal(inferAge(['Juvenile fiction']), '8-12');
  assert.equal(inferAge([]), '');
});

test('tag inference drops catalogue noise', () => {
  const tags = inferTags(['Juvenile fiction', 'Dragons', 'Accessible book', 'Friendship']);
  assert.deepEqual(tags, ['Dragons', 'Friendship']);
});

test('stripHtml removes markup from descriptions', () => {
  assert.equal(stripHtml('<p>One</p><p>Two</p>'), 'One\n\nTwo');
});

test('series inference finds nothing in plain titles', () => {
  // Recorded because it matters: run against the real 107-book library this
  // matched zero titles, which is why series data has to come from Wikidata.
  assert.equal(inferSeries('A Handful of Time').name, '');
  assert.equal(inferSeries('The Thing (Some Series, Book 3)').name, 'Some Series');
});

// -------------------------------------------------------------------- lookup

test('enrichIsbn merges Google Books', async () => {
  const fetchImpl = fakeFetch({
    'googleapis.com': {
      items: [{
        volumeInfo: {
          title: 'A Test Book',
          authors: ['Someone'],
          categories: ['Juvenile fiction', 'Dragons'],
          description: '<p>Words.</p>',
          pageCount: 200,
          publishedDate: '1999-05-01',
          imageLinks: { thumbnail: 'https://example.test/c.jpg' },
        },
      }],
    },
  });

  const fields = await enrichIsbn('9790000000801', { fetchImpl });
  assert.equal(fields.title, 'A Test Book');
  assert.equal(fields.author, 'Someone');
  assert.equal(fields.genre, 'Fantasy');
  assert.equal(fields.year, 1999);
  assert.equal(fields.age_min, 8);
  assert.equal(fields.description, 'Words.');
});

test('falls back to Open Library when Google has nothing', async () => {
  const fetchImpl = fakeFetch({
    'googleapis.com': { items: [] },
    'openlibrary.org/api/books': {
      'ISBN:9790000000802': {
        title: 'Fallback Book',
        authors: [{ name: 'Other Person' }],
        subjects: ['Detective stories'],
        number_of_pages: 100,
        publish_date: 'January 2001',
        cover: { medium: 'https://example.test/ol.jpg' },
      },
    },
  });

  const fields = await enrichIsbn('9790000000802', { fetchImpl });
  assert.equal(fields.title, 'Fallback Book');
  assert.equal(fields.genre, 'Mystery');
  assert.equal(fields.year, 2001);
});

test('an unknown ISBN enriches to null rather than throwing', async () => {
  const fetchImpl = fakeFetch({ 'googleapis.com': { items: [] }, 'openlibrary.org': {} });
  assert.equal(await enrichIsbn('9790000000803', { fetchImpl }), null);
});

test('a source being down does not break the others', async () => {
  const fetchImpl = fakeFetch({
    'googleapis.com': 'ERROR',
    'openlibrary.org/api/books': {
      'ISBN:9790000000804': { title: 'Survived', authors: [], subjects: [] },
    },
  });

  assert.equal((await enrichIsbn('9790000000804', { fetchImpl })).title, 'Survived');
});

test('cover fallback requires a matching author', async () => {
  const fetchImpl = fakeFetch({
    'googleapis.com': { items: [{ volumeInfo: { imageLinks: { thumbnail: 'https://example.test/alt.jpg' } } }] },
  });

  assert.equal(await coverFromOtherEdition('A Title', 'An Author', { fetchImpl }), 'https://example.test/alt.jpg');
  // Without an author there is no way to tell editions apart from different books.
  assert.equal(await coverFromOtherEdition('A Title', 'Unknown author', { fetchImpl }), '');
  assert.equal(await coverFromOtherEdition('A Title', '', { fetchImpl }), '');
});

// ---------------------------------------------------------------- batch run

test('enrichLibrary only touches books that need it', async () => {
  const db = openDatabase(':memory:');
  addBook(db, '9790000000805');

  const fetchImpl = fakeFetch({
    'googleapis.com': { items: [{ volumeInfo: { title: 'Filled In', authors: ['A'], categories: [] } }] },
  });

  const first = await enrichLibrary(db, { fetchImpl, delayMs: 0 });
  assert.deepEqual(first, { considered: 1, enriched: 1, failed: 0 });
  assert.equal(getBook(db, '9790000000805').title, 'Filled In');

  // Second run: already enriched, so nothing is reconsidered.
  const second = await enrichLibrary(db, { fetchImpl, delayMs: 0 });
  assert.equal(second.considered, 0);
});

test('enrichment never overwrites an edit, even on a forced refresh', async () => {
  const db = openDatabase(':memory:');
  addBook(db, '9790000000806');
  applyEdit(db, '9790000000806', { title: 'Karen Knows Best' });

  const fetchImpl = fakeFetch({
    'googleapis.com': { items: [{ volumeInfo: { title: 'Provider Title', authors: ['A'], categories: [] } }] },
  });

  await enrichLibrary(db, { fetchImpl, delayMs: 0, force: true });
  assert.equal(getBook(db, '9790000000806').title, 'Karen Knows Best');
});

// -------------------------------------------------------------- sheet ingest

test('ISBNs are normalised before comparison', () => {
  assert.equal(normaliseIsbn(' 978-0-14-032268-2 '), '9780140322682');
  assert.equal(normaliseIsbn('097522980x'), '097522980X');
});

test('ingest adds only new ISBNs and keeps the scan date', () => {
  const db = openDatabase(':memory:');
  const sheet = new Map([['9790000000807', '2026-05-01T10:00:00Z']]);

  assert.deepEqual(ingestIsbns(db, sheet), { seen: 1, added: 1 });
  assert.equal(getBook(db, '9790000000807').added_at, '2026-05-01T10:00:00Z');

  // Running again changes nothing.
  assert.deepEqual(ingestIsbns(db, sheet), { seen: 1, added: 0 });
});

test('ingest does not resurrect a removed book', async () => {
  const db = openDatabase(':memory:');
  const sheet = new Map([['9790000000808', '2026-05-01T10:00:00Z']]);
  ingestIsbns(db, sheet);

  db.prepare('UPDATE books SET removed_at = ? WHERE isbn = ?').run('2026-06-01T00:00:00Z', '9790000000808');

  ingestIsbns(db, sheet);
  assert.equal(getBook(db, '9790000000808'), null, 'the sheet keeps the ISBN forever; removal must stick');
});

test('an unreachable sheet degrades instead of throwing', async () => {
  const db = openDatabase(':memory:');
  const result = await syncFromSheet(db, { gatewayUrl: 'https://x.test/exec', gatewayToken: 't' }, {
    fetchImpl: async () => { throw new Error('network down'); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.added, 0);
});
