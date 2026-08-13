import { readFileSync } from 'node:fs';

import { addBook, applyEnrichment } from '../db/books.js';
import { upsertSeries, setSeriesEntries, linkBookToSeries } from '../db/series.js';

const SAMPLE_PATH = new URL('./sample-library.json', import.meta.url);

export function readSampleLibrary(path = SAMPLE_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Populate a database with the synthetic library. Used by tests and by
 * `--demo`, so that a fresh clone shows a working app without credentials
 * and without anybody's real catalogue.
 */
export function loadSampleLibrary(db, data = readSampleLibrary()) {
  const seriesIds = new Map();

  for (const series of data.series) {
    const saved = upsertSeries(db, {
      name: series.name,
      totalKnown: series.total_known,
      mustReadInOrder: series.must_read_in_order,
    });
    seriesIds.set(series.name, saved.id);
    setSeriesEntries(db, saved.id, series.entries);
  }

  for (const book of data.books) {
    addBook(db, book.isbn, { addedAt: book.added_at });

    applyEnrichment(db, book.isbn, {
      title: book.title,
      author: book.author,
      cover_url: book.cover_url ?? null,
      genre: book.genre ?? null,
      topics: book.topics ?? [],
      age_min: book.age_min ?? null,
      age_max: book.age_max ?? null,
    });

    if (book.series) {
      linkBookToSeries(db, book.isbn, seriesIds.get(book.series), book.series_position);
    }
  }

  return { books: data.books.length, series: data.series.length };
}
