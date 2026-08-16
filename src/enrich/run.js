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
  let consecutiveFailures = 0;
  let abandoned = false;

  for (const book of candidates) {
    const fields = await enrichIsbn(book.isbn, { apiKey, fetchImpl });

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
      const written = applyEnrichment(db, book.isbn, fields);
      enriched += 1;
      onProgress({ isbn: book.isbn, title: fields.title, written });
    } else {
      consecutiveFailures += 1;
      // Nothing recognised the ISBN. Still stamp the attempt so it is not
      // retried on every run; a forced refresh can try again later.
      applyEnrichment(db, book.isbn, {});
      failed += 1;
      onProgress({ isbn: book.isbn, title: null, written: [] });
    }

    // Be a good citizen with third-party APIs.
    if (delayMs) await sleep(delayMs);
  }

  return { considered: candidates.length, enriched, failed, abandoned };
}
