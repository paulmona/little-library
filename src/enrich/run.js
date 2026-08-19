import { applyEnrichment, listBooks } from '../db/books.js';
import { enrichIsbn } from './lookup.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Enrich books that need it. By default only those never looked up, matching
 * the original generator's behaviour; `force` re-looks-up everything, which is
 * the equivalent of its --refresh flag.
 *
 * Manual edits are safe either way: applyEnrichment refuses to write a field
 * Karen has pinned.
 */
export async function enrichLibrary(db, {
  apiKey = '',
  force = false,
  delayMs = 200,
  onProgress = () => {},
  fetchImpl = fetch,
  stopAfterConsecutiveFailures = 0,
} = {}) {
  const candidates = listBooks(db).filter((book) => (force ? true : !book.enriched_at || !book.title));

  let enriched = 0;
  let failed = 0;
  let incomplete = 0;
  let consecutiveFailures = 0;
  let abandoned = false;

  for (const book of candidates) {
    const result = await enrichIsbn(book.isbn, { apiKey, fetchImpl });
    const degraded = result?.degraded;
    // A result carrying nothing but a degraded list means every source was
    // unreachable, which is a different thing from an unrecognised ISBN.
    const fields = result && Object.keys(result).length > (degraded ? 1 : 0) ? result : null;

    // Every source failing in a row means the network is down, not that the
    // library is full of unknown books. Stop rather than stamp the whole
    // catalogue as attempted, which would need --refresh to ever undo.
    if (!fields && stopAfterConsecutiveFailures
        && consecutiveFailures + 1 >= stopAfterConsecutiveFailures) {
      abandoned = true;
      break;
    }

    if (fields) {
      consecutiveFailures = 0;
      // Half an answer is not an answer. If a source was unreachable and the
      // cover is still empty, keep what we got but leave the book unstamped so
      // the next pass asks again. Stamping here is what silently wrote off 28
      // covers during an Open Library outage: an empty cover from a source
      // that never replied is indistinguishable from a book with no jacket.
      const stamp = !(degraded && !fields.cover_url);
      const written = applyEnrichment(db, book.isbn, fields, { stamp });
      if (stamp) enriched += 1; else incomplete += 1;
      onProgress({ isbn: book.isbn, title: fields.title, written, degraded });
    } else if (degraded) {
      // Nothing came back and we know why: leave it pending and try again.
      consecutiveFailures += 1;
      incomplete += 1;
      onProgress({ isbn: book.isbn, title: null, written: [], degraded });
    } else {
      consecutiveFailures += 1;
      // Nothing recognised the ISBN, and every source answered. Stamp the
      // attempt so it is not retried on every run; --refresh can try again.
      applyEnrichment(db, book.isbn, {});
      failed += 1;
      onProgress({ isbn: book.isbn, title: null, written: [] });
    }

    // Be a good citizen with third-party APIs.
    if (delayMs) await sleep(delayMs);
  }

  return { considered: candidates.length, enriched, failed, incomplete, abandoned };
}
