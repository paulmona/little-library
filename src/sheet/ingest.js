import { addBook } from '../db/books.js';

/** The scanner writes odd characters sometimes; normalise before comparing. */
export const normaliseIsbn = (value) => String(value ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();

/**
 * Read the ISBN list from the Apps Script gateway.
 *
 * The gateway URL is itself a credential — anyone holding it can read and
 * append — so it is never logged. `doGet` with no isbn returns the list.
 */
export async function fetchSheetIsbns({ gatewayUrl, gatewayToken }, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${gatewayUrl}?token=${encodeURIComponent(gatewayToken)}`);
  if (!res.ok) throw new Error(`Sheet gateway returned HTTP ${res.status}`);

  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Sheet gateway reported failure');

  // Keep the first timestamp seen per ISBN — a book can be scanned twice, and
  // the earliest scan is when it actually arrived.
  const firstSeen = new Map();
  for (const row of data.books ?? []) {
    const isbn = normaliseIsbn(row.isbn);
    if (isbn && !firstSeen.has(isbn)) firstSeen.set(isbn, row.ts || '');
  }

  return firstSeen;
}

/**
 * Pull anything new from the sheet into SQLite.
 *
 * addBook is INSERT OR IGNORE, so this will not resurrect a book Karen has
 * removed — the ISBN stays in the sheet forever, and that is the whole reason
 * removal is a tombstone rather than a delete.
 */
export function ingestIsbns(db, firstSeen) {
  let added = 0;

  for (const [isbn, timestamp] of firstSeen) {
    const existing = db.prepare('SELECT isbn FROM books WHERE isbn = ?').get(isbn);
    if (existing) continue;

    addBook(db, isbn, { addedAt: timestamp || new Date().toISOString() });
    added += 1;
  }

  return { seen: firstSeen.size, added };
}

/**
 * One full pass. Returns counts; never throws for a network problem, because
 * an unreachable sheet must not take the library down — Karen should still be
 * able to read her own catalogue when Google is having a bad minute.
 */
export async function syncFromSheet(db, sheetConfig, options = {}) {
  try {
    const firstSeen = await fetchSheetIsbns(sheetConfig, options);
    return { ok: true, ...ingestIsbns(db, firstSeen) };
  } catch (err) {
    return { ok: false, error: err.message, seen: 0, added: 0 };
  }
}
