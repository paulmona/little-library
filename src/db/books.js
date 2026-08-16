/**
 * Fields that automated enrichment is allowed to write, and that a human is
 * allowed to override. Anything outside this list is app-managed and not
 * subject to the override rules.
 */
export const ENRICHABLE_FIELDS = [
  'title',
  'author',
  'cover_url',
  'genre',
  'topics',
  'age_min',
  'age_max',
  'description',
  'page_count',
  'year',
];

const JSON_FIELDS = new Set(['topics']);

const now = () => new Date().toISOString();

function encode(field, value) {
  if (value === undefined) return undefined;
  if (JSON_FIELDS.has(field)) return value === null ? null : JSON.stringify(value);
  return value;
}

function decodeRow(row) {
  if (!row) return null;
  return {
    ...row,
    topics: row.topics ? JSON.parse(row.topics) : [],
    must_read_in_order: row.must_read_in_order === undefined
      ? undefined
      : Boolean(row.must_read_in_order),
  };
}

/**
 * Insert a bare ISBN discovered by the scanner. Idempotent, and deliberately
 * does NOT resurrect a removed book: the ISBN stays in the Google Sheet after
 * Karen takes the book off the shelf, so every import would otherwise bring it
 * back. INSERT OR IGNORE leaves the tombstoned row untouched.
 */
export function addBook(db, isbn, { addedAt = now() } = {}) {
  db.prepare('INSERT OR IGNORE INTO books (isbn, added_at) VALUES (?, ?)').run(isbn, addedAt);
  return getBook(db, isbn);
}

/** @param includeRemoved only for undo and for tests asserting the tombstone */
export function getBook(db, isbn, { includeRemoved = false } = {}) {
  const row = db.prepare(
    `SELECT b.*, s.name AS series_name, s.total_known, s.must_read_in_order
       FROM books b LEFT JOIN series s ON s.id = b.series_id
      WHERE b.isbn = ?${includeRemoved ? '' : ' AND b.removed_at IS NULL'}`,
  ).get(isbn);
  return decodeRow(row);
}

/**
 * Take a book off the shelf. Kept as a tombstone rather than deleted so the
 * next Sheet import doesn't bring it straight back, and so undo is trivial.
 * The series entry is deliberately left alone — it flips to unowned, which is
 * exactly what the missing-books view is for.
 */
export function removeBook(db, isbn) {
  const result = db.prepare(
    'UPDATE books SET removed_at = ? WHERE isbn = ? AND removed_at IS NULL',
  ).run(now(), isbn);
  return result.changes > 0;
}

export function restoreBook(db, isbn) {
  const result = db.prepare(
    'UPDATE books SET removed_at = NULL WHERE isbn = ? AND removed_at IS NOT NULL',
  ).run(isbn);
  return result.changes > 0;
}

/** Fields a human has pinned for this book. */
export function overriddenFields(db, isbn) {
  return db.prepare('SELECT field FROM field_overrides WHERE isbn = ?')
    .all(isbn)
    .map((r) => r.field);
}

/**
 * Write automatically-discovered metadata, skipping anything a human has edited.
 *
 * This asymmetry is the whole point: enrichment runs unattended and repeatedly,
 * so it must never be able to undo a correction someone made deliberately.
 * Returns the fields it actually wrote.
 */
export function applyEnrichment(db, isbn, fields) {
  const pinned = new Set(overriddenFields(db, isbn));
  const writable = Object.keys(fields)
    .filter((f) => ENRICHABLE_FIELDS.includes(f))
    .filter((f) => !pinned.has(f))
    .filter((f) => fields[f] !== undefined);

  if (writable.length === 0) {
    db.prepare('UPDATE books SET enriched_at = ? WHERE isbn = ?').run(now(), isbn);
    return [];
  }

  const assignments = writable.map((f) => `${f} = ?`).join(', ');
  const values = writable.map((f) => encode(f, fields[f]));

  db.prepare(`UPDATE books SET ${assignments}, enriched_at = ? WHERE isbn = ?`)
    .run(...values, now(), isbn);

  return writable;
}

/**
 * Write a human's edit and pin those fields so enrichment leaves them alone.
 */
export function applyEdit(db, isbn, fields) {
  const writable = Object.keys(fields)
    .filter((f) => ENRICHABLE_FIELDS.includes(f))
    .filter((f) => fields[f] !== undefined);

  if (writable.length === 0) return [];

  const assignments = writable.map((f) => `${f} = ?`).join(', ');
  const values = writable.map((f) => encode(f, fields[f]));
  const timestamp = now();

  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE books SET ${assignments}, edited_at = ? WHERE isbn = ?`)
      .run(...values, timestamp, isbn);

    const pin = db.prepare(
      'INSERT OR REPLACE INTO field_overrides (isbn, field, set_at) VALUES (?, ?, ?)',
    );
    for (const field of writable) pin.run(isbn, field, timestamp);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return writable;
}

/** Undo a pin so enrichment can manage the field again. */
export function clearOverride(db, isbn, field) {
  db.prepare('DELETE FROM field_overrides WHERE isbn = ? AND field = ?').run(isbn, field);
}

// SQLite sorts NULL before text, which would put books that were scanned but
// never enriched at the very top of every list — the least useful cards leading
// the grid. Push empty values to the end of every sort instead.
const nullsLast = (column) => `(${column} IS NULL OR ${column} = '')`;

// The title tiebreak gets the same treatment, or an unenriched book climbs back
// up whenever it ties on the primary key.
const byTitle = `${nullsLast('b.title')}, b.title COLLATE NOCASE`;

const SORTS = {
  title: `ORDER BY ${byTitle}`,
  author: `ORDER BY ${nullsLast('b.author')}, b.author COLLATE NOCASE, ${byTitle}`,
  added: 'ORDER BY b.added_at DESC',
  genre: `ORDER BY ${nullsLast('b.genre')}, b.genre COLLATE NOCASE, ${byTitle}`,
};

// Only what a card renders. `description` alone was 201 KB of a 584 KB
// response across a real 643-book library, for a field the grid never shows.
const GRID_COLUMNS = `
  b.isbn, b.title, b.author, b.cover_url, b.genre, b.topics,
  b.age_min, b.age_max, b.added_at, b.edited_at, b.enriched_at,
  b.series_id, b.series_position
`;

export function listBooks(db, { sort = 'title', columns = GRID_COLUMNS } = {}) {
  const order = SORTS[sort] ?? SORTS.title;
  return db.prepare(
    `SELECT ${columns}, s.name AS series_name, s.total_known, s.must_read_in_order
       FROM books b LEFT JOIN series s ON s.id = b.series_id
      WHERE b.removed_at IS NULL
       ${order}`,
  ).all().map(decodeRow);
}

export function getStats(db) {
  const { books } = db.prepare('SELECT COUNT(*) AS books FROM books WHERE removed_at IS NULL').get();
  const { authors } = db.prepare(
    "SELECT COUNT(DISTINCT author) AS authors FROM books WHERE removed_at IS NULL AND author IS NOT NULL AND author != ''",
  ).get();
  // Books the background pass has not looked up yet. Zero means the catalogue
  // is as complete as the internet is going to make it, which is the only way
  // to tell a missing cover from one that has not arrived.
  const { pending } = db.prepare(
    'SELECT COUNT(*) AS pending FROM books WHERE removed_at IS NULL AND enriched_at IS NULL',
  ).get();

  return { books, authors, pending };
}
