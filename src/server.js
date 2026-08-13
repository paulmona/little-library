import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadConfig, describeCapabilities } from './config.js';
import { openDatabase } from './db/index.js';
import { listBooks, getBook, getStats } from './db/books.js';
import { getSeriesEntries } from './db/series.js';
import { loadSampleLibrary } from './sample/load.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

const VALID_SORTS = new Set(['title', 'author', 'added', 'genre']);

export function buildServer(config, db) {
  const app = Fastify({ logger: false });

  app.register(fastifyStatic, { root: PUBLIC_DIR });

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

    return { sort, books: listBooks(db, { sort }) };
  });

  app.get('/api/books/:isbn', async (request, reply) => {
    const book = getBook(db, request.params.isbn);
    if (!book) return reply.code(404).send({ error: 'No such book' });

    // A book in a series carries the whole ordered list, including entries the
    // library doesn't own. That is what the detail view and the missing-books
    // view are both built on.
    const series = book.series_id
      ? { name: book.series_name, totalKnown: book.total_known, mustReadInOrder: book.must_read_in_order, entries: getSeriesEntries(db, book.series_id) }
      : null;

    return { ...book, series };
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

  buildServer(config, db)
    .listen({ port: config.port, host: '0.0.0.0' })
    .then(() => console.log(`[little-library] listening on http://localhost:${config.port}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
