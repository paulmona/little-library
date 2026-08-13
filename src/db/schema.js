/**
 * Forward-only migrations, applied in order and tracked with PRAGMA user_version.
 * Never edit a migration that has shipped; append a new one instead.
 */
export const MIGRATIONS = [
  // 1 — books, series, and the override ledger
  `
  CREATE TABLE books (
    isbn            TEXT PRIMARY KEY,
    title           TEXT,
    author          TEXT,
    cover_url       TEXT,
    genre           TEXT,
    topics          TEXT,           -- JSON array
    age_min         INTEGER,
    age_max         INTEGER,
    series_id       INTEGER REFERENCES series(id),
    series_position REAL,           -- REAL so 0.5 "prequel" style entries fit
    added_at        TEXT NOT NULL,
    edited_at       TEXT,
    enriched_at     TEXT
  );

  CREATE TABLE series (
    name               TEXT PRIMARY KEY,
    id                 INTEGER UNIQUE,
    total_known        INTEGER,     -- NULL means genuinely unknown, never assume
    must_read_in_order INTEGER NOT NULL DEFAULT 0,
    wikidata_id        TEXT
  );

  CREATE TABLE series_entries (
    series_id INTEGER NOT NULL,
    position  REAL NOT NULL,
    title     TEXT NOT NULL,
    isbn      TEXT,                 -- NULL when it is a book the library does not own
    PRIMARY KEY (series_id, position)
  );

  -- Which fields a human set by hand. Enrichment must never touch these.
  -- This is the mechanism that stops an automated refresh silently undoing
  -- someone's corrections, which is the worst failure this app could have.
  CREATE TABLE field_overrides (
    isbn  TEXT NOT NULL,
    field TEXT NOT NULL,
    set_at TEXT NOT NULL,
    PRIMARY KEY (isbn, field)
  );

  CREATE INDEX idx_books_title  ON books(title);
  CREATE INDEX idx_books_author ON books(author);
  CREATE INDEX idx_books_added  ON books(added_at);
  CREATE INDEX idx_books_series ON books(series_id);
  `,
];

export function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return MIGRATIONS.length;
}
