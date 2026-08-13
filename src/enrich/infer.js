/**
 * Inference rules ported from the original generator's build.mjs. These are
 * crude heuristics over subject strings, but they are the ones that produced
 * the existing library, so changing them would silently reclassify books Karen
 * has already seen.
 */

export function stripHtml(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function inferGenre(subjects, title) {
  const all = `${subjects.join(' ')} ${title ?? ''}`.toLowerCase();

  if (/dragon|magic|wizard|witch|fantasy|fairy|quest|elf|enchant/.test(all)) return 'Fantasy';
  if (/mystery|detective|crime|murder|thriller/.test(all)) return 'Mystery';
  if (/science fiction|sci-fi|space|robot|alien|dystop|futur/.test(all)) return 'Sci-Fi / Dystopian';
  if (/graphic novel|comic/.test(all)) return 'Graphic Novel';
  if (/adventure/.test(all)) return 'Adventure';
  if (/horror|ghost|supernatural/.test(all)) return 'Horror';
  if (/histor/.test(all)) return 'Historical Fiction';
  if (/romance|love story/.test(all)) return 'Romance';
  if (/non-?fiction|biography|memoir/.test(all)) return 'Non-Fiction';

  const first = subjects.find((s) => s.length < 30);
  if (!first) return 'Fiction';

  return first
    .split(' ')
    .slice(0, 3)
    .map((word) => (word[0] ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** Returns the old display string, e.g. "8-12" or "13+". */
export function inferAge(subjects) {
  const all = subjects.join(' ').toLowerCase();

  if (/young adult|teen|ya /.test(all)) return '13+';
  if (/picture book|ages 3|ages 4|ages 5/.test(all)) return '4-7';
  if (/juvenile|children|middle grade|ages 8|ages 9|ages 10/.test(all)) return '8-12';
  if (/adult/.test(all)) return '16+';
  return '';
}

const TAG_STOPWORDS = /^(juvenile fiction|fiction|young adult fiction|juvenile literature|large type books|protected daisy|accessible book|in library|nyt:|new york times bestseller|bestseller)/i;

export function inferTags(subjects, limit = 8) {
  const seen = new Set();
  const tags = [];

  for (const subject of subjects) {
    const clean = String(subject).trim();
    if (!clean || clean.length > 40 || TAG_STOPWORDS.test(clean)) continue;

    const key = clean.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    tags.push(clean);
    if (tags.length >= limit) break;
  }

  return tags;
}

/**
 * Series from a title like "The Thing (Some Series, Book 3)".
 *
 * Kept for parity, but worth knowing it found nothing: run against the real
 * 107-book library it matched 0 titles. Series data has to come from Wikidata
 * (VIE-52), not from parsing titles.
 */
export function inferSeries(title) {
  const match = String(title ?? '').match(/\(([^)]+?),?\s*(?:book|#|vol\.?)\s*(\d+)\)/i);
  if (match) return { name: match[1].trim(), position: Number(match[2]) };
  return { name: '', position: null };
}
