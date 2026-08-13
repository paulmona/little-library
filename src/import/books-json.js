import { readFileSync } from 'node:fs';

import { addBook, applyEnrichment } from '../db/books.js';

/**
 * One-off importer for the `books.json` produced by the original static site
 * generator, so an existing library carries over instead of starting empty.
 *
 * The importer ships; the data does not. A real catalogue is a description of
 * a home and never belongs in this repo.
 */

/**
 * The old format stores age as a display string: "8-12", "16+", "13+".
 * Returns { age_min, age_max }, where a null max means open-ended.
 */
export function parseAgeRange(value) {
  if (typeof value !== 'string' || value.trim() === '') return { age_min: null, age_max: null };

  const range = value.match(/^\s*(\d+)\s*[-–—]\s*(\d+)\s*$/);
  if (range) return { age_min: Number(range[1]), age_max: Number(range[2]) };

  const open = value.match(/^\s*(\d+)\s*\+\s*$/);
  if (open) return { age_min: Number(open[1]), age_max: null };

  const single = value.match(/^\s*(\d+)\s*$/);
  if (single) return { age_min: Number(single[1]), age_max: Number(single[1]) };

  // Anything else is left unset rather than guessed. Better an empty age than
  // a wrong one on a book someone is choosing for a child.
  return { age_min: null, age_max: null };
}

const nullIfEmpty = (v) => (v === undefined || v === '' ? null : v);

export function mapRecord(record) {
  const { age_min, age_max } = parseAgeRange(record.age);

  return {
    title: nullIfEmpty(record.title),
    author: nullIfEmpty(record.author),
    cover_url: nullIfEmpty(record.cover),
    genre: nullIfEmpty(record.genre),
    topics: Array.isArray(record.tags) ? record.tags : [],
    age_min,
    age_max,
    description: nullIfEmpty(record.description),
    page_count: nullIfEmpty(record.pageCount),
    year: nullIfEmpty(record.year),
  };
}

/**
 * @param data  the parsed books.json: an object keyed by ISBN
 * @returns counts, so a caller can report what happened without inspecting the data
 */
export function importBooksJson(db, data) {
  let imported = 0;
  let unenriched = 0;

  for (const [isbn, record] of Object.entries(data)) {
    // Preserve the original acquisition date. Stamping everything with the
    // import date would destroy "recently added", which is a sort Karen uses.
    addBook(db, isbn, { addedAt: record.addedAt ?? new Date().toISOString() });
    applyEnrichment(db, isbn, mapRecord(record));

    imported += 1;
    if (!record.title) unenriched += 1;
  }

  return { imported, unenriched };
}

export function importBooksJsonFile(db, path) {
  return importBooksJson(db, JSON.parse(readFileSync(path, 'utf8')));
}
