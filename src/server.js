import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadConfig, describeCapabilities } from './config.js';
import { openDatabase } from './db/index.js';
import {
  listBooks, getBook, getStats, applyEdit, removeBook, restoreBook, ENRICHABLE_FIELDS,
} from './db/books.js';
import {
  getSeriesEntries, listSeriesWithCounts, getSeriesById, createSeries, updateSeries,
  addBooksToSeries, removeBookFromSeries, booksBySameAuthor, seriesState,
  allSeriesStates, incompleteSeries,
} from './db/series.js';
import { inferSeries } from './enrich/infer.js';
import { loadSampleLibrary } from './sample/load.js';
import { syncFromSheet } from './sheet/ingest.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

const VALID_SORTS = new Set(['title', 'author', 'added', 'genre']);

export function buildServer(config, db) {
  const app = Fastify({ logger: false });

  app.register(fastifyStatic, { root: PUBLIC_DIR });

  // Book detail is a client-side route. Serve the shell so a deep link or a
  // refresh on /book/<isbn> works rather than 404ing.
  app.get('/book/:isbn', (request, reply) => reply.sendFile('index.html'));
  app.get('/missing', (request, reply) => reply.sendFile('index.html'));

  app.get('/health', async () => ({
    status: 'ok',
    library: config.library.name,
    capabilities: describeCapabilities(config),
  }));

  app.get('/api/stats', async () => ({
    ...getStats(db),
    library: config.library.name,
  }));

  app.get('/api/books', async (request) => {
    const requested = request.query.sort;
    // An unrecognised sort falls back rather than erroring — this is a URL a
    // person might edit by hand, and a broken sort shouldn't mean a broken page.
    const sort = VALID_SORTS.has(requested) ? requested : 'title';

    // Series state is computed once for the whole library rather than per book.
    // Only the handful of fields a card actually draws are attached.
    const states = allSeriesStates(db);
    const books = listBooks(db, { sort }).map((book) => {
      const state = book.series_id ? states.get(book.series_id) : null;
      if (!state) return book;

      return {
        ...book,
        series: {
          name: state.name,
          total: state.total_known,
          owned: state.owned,
          readInOrder: state.must_read_in_order,
          completeness: state.completeness,
          missingCount: state.missingPositions.length,
        },
      };
    });

    return { sort, books };
  });

  /**
   * The garage-sale cheat sheet: series she has started and not finished.
   * Served entirely from SQLite so it works on bad signal in someone's driveway.
   */
  app.get('/api/missing', async () => ({
    series: incompleteSeries(db).map((state) => ({
      id: state.id,
      name: state.name,
      total: state.total_known,
      owned: state.owned,
      readInOrder: state.must_read_in_order,
      have: state.ownedPositions,
      missing: state.missingPositions,
      books: state.books.map((b) => ({ isbn: b.isbn, title: b.title, position: b.series_position })),
    })),
  }));

  app.get('/api/books/:isbn', async (request, reply) => {
    const book = getBook(db, request.params.isbn);
    if (!book) return reply.code(404).send({ error: 'No such book' });

    // A book in a series carries the whole ordered list, including entries the
    // library doesn't own. That is what the detail view and the missing-books
    // view are both built on.
    return { ...book, series: book.series_id ? seriesState(db, book.series_id) : null };
  });

  app.patch('/api/books/:isbn', async (request, reply) => {
    const { isbn } = request.params;
    if (!getBook(db, isbn)) return reply.code(404).send({ error: 'No such book' });

    const changed = applyEdit(db, isbn, request.body ?? {});
    if (changed.length === 0) {
      return reply.code(400).send({ error: 'No editable fields supplied', editable: ENRICHABLE_FIELDS });
    }

    return { changed, book: getBook(db, isbn) };
  });

  // Tombstone rather than DELETE. The ISBN stays in the Google Sheet after a
  // book leaves the shelf, so a hard delete would be undone by the next import.
  app.delete('/api/books/:isbn', async (request, reply) => {
    if (!removeBook(db, request.params.isbn)) {
      return reply.code(404).send({ error: 'No such book' });
    }
    return { removed: request.params.isbn };
  });

  app.post('/api/books/:isbn/restore', async (request, reply) => {
    if (!restoreBook(db, request.params.isbn)) {
      return reply.code(404).send({ error: 'Not removed' });
    }
    return { restored: request.params.isbn, book: getBook(db, request.params.isbn) };
  });

  // ---- series -------------------------------------------------------------
  // Membership is entirely manual. See VIE-52: automated resolution covered
  // 25-30% of this library at best, and a wrong series would put books Karen
  // does not own onto the list she shops from.

  app.get('/api/series', async () => ({ series: listSeriesWithCounts(db) }));

  app.get('/api/series/:id', async (request, reply) => {
    const state = seriesState(db, Number(request.params.id));
    if (!state) return reply.code(404).send({ error: 'No such series' });
    return state;
  });

  app.post('/api/series', async (request, reply) => {
    const { name, totalKnown = null, mustReadInOrder = false } = request.body ?? {};
    if (!name || !String(name).trim()) {
      return reply.code(400).send({ error: 'A series needs a name' });
    }

    try {
      return createSeries(db, { name: String(name).trim(), totalKnown, mustReadInOrder });
    } catch (err) {
      // name is UNIQUE; adding to the existing one is almost certainly intended.
      if (String(err.message).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'A series with that name already exists' });
      }
      throw err;
    }
  });

  app.patch('/api/series/:id', async (request, reply) => {
    const updated = updateSeries(db, Number(request.params.id), request.body ?? {});
    if (!updated) return reply.code(404).send({ error: 'No such series' });
    return updated;
  });

  app.post('/api/series/:id/books', async (request, reply) => {
    const id = Number(request.params.id);
    if (!getSeriesById(db, id)) return reply.code(404).send({ error: 'No such series' });

    const members = (request.body?.books ?? []).filter((m) => m && m.isbn);
    if (members.length === 0) return reply.code(400).send({ error: 'No books supplied' });

    addBooksToSeries(db, id, members);
    return seriesState(db, id);
  });

  app.delete('/api/series/:id/books/:isbn', async (request, reply) => {
    if (!removeBookFromSeries(db, request.params.isbn)) {
      return reply.code(404).send({ error: 'No such book' });
    }
    return seriesState(db, Number(request.params.id));
  });

  /**
   * The shortlist Karen picks from when building a series: other books by the
   * same author, with a position pre-filled from the title where one is
   * already encoded, e.g. "... (Baby-Sitters Little Sister #16)".
   */
  app.get('/api/books/:isbn/same-author', async (request) => {
    const candidates = booksBySameAuthor(db, request.params.isbn);
    return {
      books: candidates.map((book) => ({
        ...book,
        suggestedPosition: book.series_position ?? inferSeries(book.title).position,
      })),
    };
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const demo = process.argv.includes('--demo');
  const config = loadConfig();
  const db = openDatabase(demo ? ':memory:' : config.databasePath);

  if (demo) {
    const { books } = loadSampleLibrary(db);
    console.log(`[little-library] demo mode — ${books} sample books, nothing persisted`);
  } else {
    for (const [name, available] of Object.entries(describeCapabilities(config))) {
      if (!available) console.warn(`[little-library] ${name} unavailable — missing configuration`);
    }
  }

  // Pull new scans in periodically so a book scanned on the phone appears
  // without anyone doing anything. Failures are logged, never fatal.
  if (!demo && config.sheet.gatewayUrl) {
    const sync = async () => {
      const result = await syncFromSheet(db, config.sheet);
      if (!result.ok) console.warn(`[little-library] sheet sync failed: ${result.error}`);
      else if (result.added > 0) console.log(`[little-library] sheet sync: ${result.added} new`);
    };
    sync();
    setInterval(sync, 15 * 60 * 1000).unref();
  }

  buildServer(config, db)
    .listen({ port: config.port, host: '0.0.0.0' })
    .then(() => console.log(`[little-library] listening on http://localhost:${config.port}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
