import { stripHtml, inferGenre, inferAge, inferTags } from './infer.js';
import { parseAgeRange } from '../import/books-json.js';

/**
 * Metadata lookup, ported from the original generator. Three sources tried in
 * order, then a cover fallback. `fetchImpl` is injectable so tests never touch
 * the network.
 */

/**
 * A source that is unreachable is not the same as a source that has never
 * heard of the book. The first should be retried, the second should not, and
 * for a long time both looked identical from the outside: an empty cover.
 *
 * 429 and 5xx are the service having a bad minute. A 404 is an answer.
 */
const RETRYABLE = (status) => status === 429 || status >= 500;

export async function lookupGoogleBooks(isbn, { apiKey = '', fetchImpl = fetch, onSourceDown = () => {} } = {}) {
  try {
    const key = apiKey ? `&key=${apiKey}&country=US` : '';
    const res = await fetchImpl(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}${key}`);
    if (!res.ok) {
      if (RETRYABLE(res.status)) onSourceDown('google-books');
      return null;
    }

    const volume = (await res.json()).items?.[0]?.volumeInfo;
    if (!volume) return null;

    return {
      title: volume.title,
      authors: volume.authors ?? [],
      subjects: volume.categories ?? [],
      description: stripHtml(volume.description ?? ''),
      pageCount: volume.pageCount ?? 0,
      year: (volume.publishedDate ?? '').slice(0, 4),
      // Only imageLinks means a real jacket exists; anything else is a placeholder.
      cover: volume.imageLinks?.thumbnail ?? volume.imageLinks?.smallThumbnail ?? '',
    };
  } catch {
    onSourceDown('google-books');
    return null;
  }
}

export async function lookupOpenLibrary(isbn, { fetchImpl = fetch, onSourceDown = () => {} } = {}) {
  try {
    const res = await fetchImpl(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
    if (!res.ok) {
      if (RETRYABLE(res.status)) onSourceDown('open-library');
      return null;
    }

    const info = (await res.json())[`ISBN:${isbn}`];
    if (!info) return null;

    return {
      title: info.title,
      authors: (info.authors ?? []).map((a) => a.name).filter(Boolean),
      subjects: (info.subjects ?? []).map((s) => (typeof s === 'string' ? s : s.name)).filter(Boolean),
      pageCount: info.number_of_pages ?? 0,
      year: (info.publish_date ?? '').match(/\d{4}/)?.[0] ?? '',
      cover: info.cover?.medium ?? info.cover?.large ?? '',
    };
  } catch {
    onSourceDown('open-library');
    return null;
  }
}

export async function lookupOpenLibrarySearch(isbn, { fetchImpl = fetch, onSourceDown = () => {} } = {}) {
  try {
    const res = await fetchImpl(`https://openlibrary.org/search.json?isbn=${isbn}&fields=title,author_name,first_publish_year,subject,cover_i&limit=1`);
    if (!res.ok) {
      if (RETRYABLE(res.status)) onSourceDown('open-library-search');
      return null;
    }

    const doc = (await res.json()).docs?.[0];
    if (!doc) return null;

    return {
      title: doc.title,
      authors: doc.author_name ?? [],
      subjects: (doc.subject ?? []).slice(0, 40),
      year: doc.first_publish_year ? String(doc.first_publish_year) : '',
      cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : '',
    };
  } catch {
    onSourceDown('open-library-search');
    return null;
  }
}

/**
 * When the scanned edition has no jacket, borrow one from another edition of
 * the same book. Matching on author as well as title is deliberate: without it
 * a different book sharing a title supplies the cover.
 */
export async function coverFromOtherEdition(title, author, { apiKey = '', fetchImpl = fetch, onSourceDown = () => {} } = {}) {
  if (!title || !author || author === 'Unknown author') return '';

  try {
    const query = `intitle:${title} inauthor:${author.split(',')[0]}`;
    const key = apiKey ? `&key=${apiKey}&country=US` : '';
    const res = await fetchImpl(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5${key}`);
    if (!res.ok) {
      if (RETRYABLE(res.status)) onSourceDown('google-books-cover');
      return '';
    }

    for (const item of (await res.json()).items ?? []) {
      const links = item.volumeInfo?.imageLinks;
      if (links?.thumbnail || links?.smallThumbnail) {
        return links.thumbnail ?? links.smallThumbnail;
      }
    }
  } catch {
    // A missing cover is cosmetic. Never fail enrichment over it, but do say
    // the source was unreachable so the book is not written off as coverless.
    onSourceDown('google-books-cover');
  }

  return '';
}

/**
 * Turn a bare ISBN into the fields the books table stores.
 * Returns null when no source recognised the ISBN at all.
 */
export async function enrichIsbn(isbn, options = {}) {
  // Which sources could not be reached on this attempt. An empty cover with
  // this set populated means "ask again later", not "this book has no jacket".
  const down = new Set();
  const opts = { ...options, onSourceDown: (source) => down.add(source) };

  const google = await lookupGoogleBooks(isbn, opts);
  const openLibrary = await lookupOpenLibrary(isbn, opts);
  const search = google || openLibrary ? null : await lookupOpenLibrarySearch(isbn, opts);

  const found = google ?? openLibrary ?? search;
  if (!found) return down.size > 0 ? { degraded: [...down] } : null;

  const title = google?.title ?? openLibrary?.title ?? search?.title ?? '';
  const authors = google?.authors?.length ? google.authors
    : openLibrary?.authors?.length ? openLibrary.authors
      : search?.authors ?? [];

  const subjects = [
    ...(google?.subjects ?? []),
    ...(openLibrary?.subjects ?? []),
    ...(search?.subjects ?? []),
  ];

  const author = authors.join(', ');
  let cover = google?.cover || openLibrary?.cover || search?.cover || '';
  if (!cover) cover = await coverFromOtherEdition(title, author, opts);

  const { age_min, age_max } = parseAgeRange(inferAge(subjects));
  const year = google?.year || openLibrary?.year || search?.year || '';

  return {
    title: title || null,
    author: author || null,
    cover_url: cover || null,
    genre: inferGenre(subjects, title),
    topics: inferTags(subjects),
    age_min,
    age_max,
    description: google?.description || null,
    page_count: google?.pageCount || openLibrary?.pageCount || null,
    year: year ? Number(year) : null,
    ...(down.size > 0 ? { degraded: [...down] } : {}),
  };
}
