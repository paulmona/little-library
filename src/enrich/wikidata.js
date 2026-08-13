/**
 * Series resolution via Wikidata.
 *
 * Google Books and Open Library both carry series fields that are effectively
 * empty — Open Library returned nothing even for Harry Potter, and the original
 * generator's title-parsing matched 0 of 107 real books. Wikidata is the only
 * source that models this properly, via `part of series` (P179) with a
 * `series ordinal` (P1545) qualifier.
 *
 * Matching is the hard part, not querying. Wikidata's ISBN coverage is thin, so
 * a book has to be found by title and confirmed by author. When in doubt this
 * returns nothing: a wrong series is worse than no series, because it would put
 * books Karen doesn't own onto a missing list she shops from.
 */

const USER_AGENT = 'little-library/0.1 (https://github.com/paulmona/little-library)';

const SEARCH = 'https://www.wikidata.org/w/api.php';
const ENTITY = 'https://www.wikidata.org/wiki/Special:EntityData';
const SPARQL = 'https://query.wikidata.org/sparql';

const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

/** Compare people loosely: "J. K. Rowling" vs "Joanne Rowling" should match on surname. */
export function authorsMatch(ours, theirs) {
  if (!ours || !theirs) return false;

  const surname = (name) => name
    .toLowerCase()
    .replace(/[^a-z\s.]/g, '')
    .split(/\s+/)
    .filter((part) => part.length > 1 && !part.endsWith('.'))
    .pop();

  const a = surname(ours);
  const b = surname(theirs);
  return Boolean(a && b && a === b);
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Candidate Wikidata items for a title. */
export async function searchByTitle(title, { fetchImpl = fetch, limit = 5 } = {}) {
  const url = `${SEARCH}?action=wbsearchentities&format=json&language=en&type=item&limit=${limit}&search=${encodeURIComponent(title)}&origin=*`;
  try {
    return (await getJson(url, fetchImpl)).search ?? [];
  } catch {
    return [];
  }
}

/**
 * Read an entity's author and series claims.
 * Returns { authorIds, series: { id, position } | null }.
 */
export async function getEntityClaims(qid, { fetchImpl = fetch } = {}) {
  try {
    const data = await getJson(`${ENTITY}/${qid}.json`, fetchImpl);
    const claims = data.entities?.[qid]?.claims ?? {};

    const authorIds = (claims.P50 ?? [])
      .map((c) => c.mainsnak?.datavalue?.value?.id)
      .filter(Boolean);

    const seriesClaim = (claims.P179 ?? [])[0];
    const seriesId = seriesClaim?.mainsnak?.datavalue?.value?.id ?? null;
    const ordinal = seriesClaim?.qualifiers?.P1545?.[0]?.datavalue?.value ?? null;

    return {
      authorIds,
      // A P2093 "author name string" is used when the author has no item.
      authorStrings: (claims.P2093 ?? []).map((c) => c.mainsnak?.datavalue?.value).filter(Boolean),
      series: seriesId ? { id: seriesId, position: ordinal === null ? null : Number(ordinal) } : null,
    };
  } catch {
    return { authorIds: [], authorStrings: [], series: null };
  }
}

export async function getLabel(qid, { fetchImpl = fetch } = {}) {
  try {
    const data = await getJson(`${ENTITY}/${qid}.json`, fetchImpl);
    return data.entities?.[qid]?.labels?.en?.value ?? null;
  } catch {
    return null;
  }
}

/** Every member of a series, in reading order. */
export async function getSeriesMembers(seriesQid, { fetchImpl = fetch } = {}) {
  const query = `SELECT ?workLabel ?ordinal WHERE {
    ?work wdt:P179 wd:${seriesQid} .
    OPTIONAL { ?work p:P179 ?st . ?st ps:P179 wd:${seriesQid} ; pq:P1545 ?ordinal }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
  } ORDER BY xsd:integer(?ordinal)`;

  try {
    const url = `${SPARQL}?format=json&query=${encodeURIComponent(query)}`;
    const data = await getJson(url, fetchImpl);

    return (data.results?.bindings ?? [])
      .map((row) => ({
        title: row.workLabel?.value ?? null,
        position: row.ordinal ? Number(row.ordinal.value) : null,
      }))
      // Entries with no ordinal can't be placed in reading order, and a
      // missing-books list has to be ordered to be useful.
      .filter((entry) => entry.title && entry.position !== null);
  } catch {
    return [];
  }
}

/**
 * Resolve one book to a series. Returns null when nothing matches confidently.
 */
export async function resolveSeries(book, options = {}) {
  if (!book.title || !book.author) return null;

  const candidates = await searchByTitle(book.title, options);

  for (const candidate of candidates) {
    const claims = await getEntityClaims(candidate.id, options);
    if (!claims.series) continue;

    // Confirm the author before trusting the match. Without this, a different
    // book sharing a title drags in the wrong series entirely.
    let confirmed = claims.authorStrings.some((name) => authorsMatch(book.author, name));

    if (!confirmed) {
      for (const authorId of claims.authorIds) {
        const label = await getLabel(authorId, options);
        if (authorsMatch(book.author, label)) { confirmed = true; break; }
      }
    }

    if (!confirmed) continue;

    const seriesName = await getLabel(claims.series.id, options);
    if (!seriesName) continue;

    return {
      wikidataId: claims.series.id,
      seriesName,
      position: claims.series.position,
      matchedItem: candidate.id,
    };
  }

  return null;
}
