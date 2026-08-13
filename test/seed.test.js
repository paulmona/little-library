import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const proposal = JSON.parse(
  readFileSync(new URL('../src/seed/series-proposal.json', import.meta.url), 'utf8'),
);

const allGroups = [...proposal.continuingStories, ...proposal.standaloneSets];
const allBooks = allGroups.flatMap((g) => g.books.map((b) => ({ ...b, series: g.name })));

// The proposal is hand-authored, so these guard the authoring rather than the code.

test('no book is claimed by two series', () => {
  const seen = new Map();
  for (const book of allBooks) {
    const existing = seen.get(book.isbn);
    assert.equal(existing, undefined, `${book.isbn} is in both "${existing}" and "${book.series}"`);
    seen.set(book.isbn, book.series);
  }
});

test('series names are unique', () => {
  const names = allGroups.map((g) => g.name);
  assert.equal(new Set(names).size, names.length);
});

test('positions are sane', () => {
  for (const book of allBooks) {
    if (book.position === null) continue;
    assert.ok(Number.isInteger(book.position) && book.position > 0,
      `${book.series} has a bad position for ${book.isbn}: ${book.position}`);
  }
});

test('no series claims more books than its stated total', () => {
  // Duplicates are excluded — owning two copies of book 3 is not two entries.
  for (const group of allGroups) {
    if (!group.totalKnown) continue;
    const distinct = new Set(
      group.books.filter((b) => !b.duplicateOf).map((b) => b.position).filter((p) => p !== null),
    );
    assert.ok(distinct.size <= group.totalKnown,
      `${group.name} claims ${distinct.size} distinct positions but says the total is ${group.totalKnown}`);
  }
});

test('no position exceeds its series total', () => {
  for (const group of allGroups) {
    if (!group.totalKnown) continue;
    for (const book of group.books) {
      if (book.position === null) continue;
      assert.ok(book.position <= group.totalKnown,
        `${group.name} has a book at position ${book.position} but a total of ${group.totalKnown}`);
    }
  }
});

test('every duplicateOf points at a book in the same series', () => {
  for (const group of allGroups) {
    const isbns = new Set(group.books.map((b) => b.isbn));
    for (const book of group.books.filter((b) => b.duplicateOf)) {
      assert.ok(isbns.has(book.duplicateOf),
        `${group.name}: ${book.isbn} claims to duplicate ${book.duplicateOf}, which is not in this series`);
    }
  }
});

test('continuing stories are the small, careful tier', () => {
  // The whole point of the two tiers: only a genuine story arc warns about
  // gifting. If this list ever balloons, the warning stops meaning anything.
  assert.ok(proposal.continuingStories.length < 25,
    'continuing stories should stay a short, deliberate list');
});

test('long open-ended series carry no total', () => {
  // Animorphs ran to 54 books. A missing list of 51 numbers helps nobody, so
  // the total is deliberately absent and the app reports "unknown".
  const animorphs = proposal.continuingStories.find((g) => g.name === 'Animorphs');
  assert.equal(animorphs.totalKnown, null);
});
