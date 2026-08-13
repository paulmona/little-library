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
