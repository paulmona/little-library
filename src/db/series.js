/**
 * Series are stored separately from books because a series knows about entries
 * the library does not own — that is the whole point of the missing-books view.
 * A series_entry with a NULL isbn is a book that exists in the world but not on
 * the shelf.
 */

export function upsertSeries(db, { name, totalKnown = null, mustReadInOrder = false, wikidataId = null }) {
  db.prepare(
    `INSERT INTO series (name, total_known, must_read_in_order, wikidata_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       total_known        = COALESCE(excluded.total_known, series.total_known),
       must_read_in_order = excluded.must_read_in_order,
       wikidata_id        = COALESCE(excluded.wikidata_id, series.wikidata_id)`,
  ).run(name, totalKnown, mustReadInOrder ? 1 : 0, wikidataId);

  return getSeries(db, name);
}

export function getSeries(db, name) {
  const row = db.prepare('SELECT * FROM series WHERE name = ?').get(name);
  if (!row) return null;
  return { ...row, must_read_in_order: Boolean(row.must_read_in_order) };
}

export function setSeriesEntries(db, seriesId, entries) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM series_entries WHERE series_id = ?').run(seriesId);
    const insert = db.prepare(
      'INSERT INTO series_entries (series_id, position, title, isbn) VALUES (?, ?, ?, ?)',
    );
    for (const entry of entries) {
      insert.run(seriesId, entry.position, entry.title, entry.isbn ?? null);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSeriesEntries(db, seriesId) {
  return db.prepare(
    'SELECT position, title, isbn FROM series_entries WHERE series_id = ? ORDER BY position',
  ).all(seriesId);
}

/** Attach a book to a series at a position. */
export function linkBookToSeries(db, isbn, seriesId, position) {
  db.prepare('UPDATE books SET series_id = ?, series_position = ? WHERE isbn = ?')
    .run(seriesId, position, isbn);
}

export function listSeries(db) {
  return db.prepare('SELECT * FROM series ORDER BY name COLLATE NOCASE')
    .all()
    .map((row) => ({ ...row, must_read_in_order: Boolean(row.must_read_in_order) }));
}

/**
 * Series membership is manual (see VIE-52 for why automation was cancelled).
 * Karen supplies the total, ticks which of her books belong, and gives each a
 * position. Missing entries are therefore *positions*, not titles — she knows
 * a series has 7 books and owns 1, 2 and 4, so 3, 5, 6 and 7 are missing.
 */

export function listSeriesWithCounts(db) {
  return db.prepare(`
    SELECT s.*, COUNT(b.isbn) AS owned
      FROM series s
      LEFT JOIN books b ON b.series_id = s.id AND b.removed_at IS NULL
     GROUP BY s.id
     ORDER BY s.name COLLATE NOCASE
  `).all().map((row) => ({ ...row, must_read_in_order: Boolean(row.must_read_in_order) }));
}

export function getSeriesById(db, id) {
  const row = db.prepare('SELECT * FROM series WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, must_read_in_order: Boolean(row.must_read_in_order) };
}

export function createSeries(db, { name, totalKnown = null, mustReadInOrder = false }) {
  db.prepare(
    'INSERT INTO series (name, total_known, must_read_in_order) VALUES (?, ?, ?)',
  ).run(name, totalKnown, mustReadInOrder ? 1 : 0);
  return getSeries(db, name);
}

export function updateSeries(db, id, { name, totalKnown, mustReadInOrder }) {
  const current = getSeriesById(db, id);
  if (!current) return null;

  db.prepare(
    'UPDATE series SET name = ?, total_known = ?, must_read_in_order = ? WHERE id = ?',
  ).run(
    name ?? current.name,
    totalKnown === undefined ? current.total_known : totalKnown,
    (mustReadInOrder === undefined ? current.must_read_in_order : mustReadInOrder) ? 1 : 0,
    id,
  );

  return getSeriesById(db, id);
}

/** @param members [{ isbn, position }] — position may be null when unknown */
export function addBooksToSeries(db, seriesId, members) {
  const link = db.prepare('UPDATE books SET series_id = ?, series_position = ? WHERE isbn = ?');

  db.exec('BEGIN');
  try {
    for (const { isbn, position } of members) {
      link.run(seriesId, position ?? null, isbn);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return members.length;
}

/** Detach a book. Never deletes the book itself. */
export function removeBookFromSeries(db, isbn) {
  const result = db.prepare(
    'UPDATE books SET series_id = NULL, series_position = NULL WHERE isbn = ?',
  ).run(isbn);
  return result.changes > 0;
}

/**
 * Other books by the same author — the shortlist Karen picks from. This is the
 * one signal that is always present and always correct, and it turns "find your
 * series books among 643" into "pick from the 5 by this author".
 */
export function booksBySameAuthor(db, isbn) {
  const book = db.prepare('SELECT author FROM books WHERE isbn = ?').get(isbn);
  if (!book?.author) return [];

  return db.prepare(`
    SELECT isbn, title, series_id, series_position, cover_url
      FROM books
     WHERE author = ? AND removed_at IS NULL
     ORDER BY (title IS NULL OR title = ''), title COLLATE NOCASE
  `).all(book.author);
}

/**
 * What Karen owns and what she is missing, by position.
 *
 * Deliberately honest about the unknown: with no total we report the owned
 * positions and say nothing about what is missing, rather than assuming the
 * highest owned position is the end of the series.
 */
export function seriesState(db, seriesId) {
  const series = getSeriesById(db, seriesId);
  if (!series) return null;

  const books = db.prepare(`
    SELECT isbn, title, series_position FROM books
     WHERE series_id = ? AND removed_at IS NULL
     ORDER BY (series_position IS NULL), series_position
  `).all(seriesId);

  const ownedPositions = new Set(
    books.map((b) => b.series_position).filter((p) => p !== null),
  );

  const total = series.total_known;
  const missingPositions = total
    ? Array.from({ length: total }, (_, i) => i + 1).filter((p) => !ownedPositions.has(p))
    : [];

  const hasFirst = ownedPositions.has(1);
  let completeness;
  if (!total) completeness = 'unknown';
  else if (missingPositions.length === 0) completeness = 'complete';
  else if (hasFirst) completeness = 'started';
  else completeness = 'no-first';

  return {
    ...series,
    owned: books.length,
    books,
    ownedPositions: [...ownedPositions].sort((a, b) => a - b),
    missingPositions,
    unplaced: books.filter((b) => b.series_position === null).length,
    completeness,
  };
}

/**
 * State for every series in one pass, so the grid can show completeness on each
 * card without a query per book.
 */
export function allSeriesStates(db) {
  const states = new Map();
  for (const series of listSeries(db)) {
    states.set(series.id, seriesState(db, series.id));
  }
  return states;
}

/**
 * Series Karen has started but not finished, for the missing-books view.
 *
 * Only series with a known total can say what is missing; one without a total
 * is honestly excluded rather than padded out with guesses. Sorted by how close
 * she is to finishing, because a series needing one more book is the one worth
 * looking for at a sale.
 */
export function incompleteSeries(db) {
  return [...allSeriesStates(db).values()]
    .filter((state) => state.owned > 0 && state.missingPositions.length > 0)
    .sort((a, b) => a.missingPositions.length - b.missingPositions.length
      || a.name.localeCompare(b.name));
}
