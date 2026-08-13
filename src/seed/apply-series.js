#!/usr/bin/env node
/**
 * Apply a one-time series proposal to an existing library.
 *
 * Dry run by default — it prints what it would do and changes nothing. Pass
 * --apply to commit. Series membership is a claim about someone's books, so it
 * should be reviewed before it lands rather than after.
 */
import { readFileSync } from 'node:fs';

import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';
import { getSeries, createSeries, addBooksToSeries, seriesState } from '../db/series.js';

const apply = process.argv.includes('--apply');
const path = process.argv.find((a) => a.endsWith('.json'))
  ?? new URL('./series-proposal.json', import.meta.url).pathname;

const proposal = JSON.parse(readFileSync(path, 'utf8'));
const config = loadConfig();
const db = openDatabase(config.databasePath);

const known = new Set(
  db.prepare('SELECT isbn FROM books WHERE removed_at IS NULL').all().map((r) => r.isbn),
);

let created = 0;
let linked = 0;
let skipped = 0;
const missing = [];

function seed(group, readInOrder) {
  const present = group.books.filter((b) => known.has(b.isbn));
  const absent = group.books.filter((b) => !known.has(b.isbn));
  absent.forEach((b) => missing.push({ series: group.name, isbn: b.isbn }));

  if (present.length === 0) {
    skipped += 1;
    console.log(`  SKIP  ${group.name} — none of its books are in the library`);
    return;
  }

  const flag = readInOrder ? 'read-in-order' : 'set';
  const total = group.totalKnown ? `, ${group.totalKnown} total` : ', total unknown';
  console.log(`  ${apply ? 'SEED' : 'would'}  ${group.name} — ${present.length} books (${flag}${total})`);

  if (!apply) return;

  const existing = getSeries(db, group.name);
  const series = existing ?? createSeries(db, {
    name: group.name,
    totalKnown: group.totalKnown ?? null,
    mustReadInOrder: readInOrder,
  });
  if (!existing) created += 1;

  addBooksToSeries(db, series.id, present.map((b) => ({ isbn: b.isbn, position: b.position ?? null })));
  linked += present.length;
}

console.log(`\n=== ${proposal.continuingStories.length} series where reading order matters ===\n`);
for (const group of proposal.continuingStories) seed(group, true);

console.log('');
if (missing.length) {
  console.log(`${missing.length} proposed ISBNs are not in the library (removed, or a typo in the proposal):`);
  missing.slice(0, 10).forEach((m) => console.log(`  ${m.isbn}  ${m.series}`));
  if (missing.length > 10) console.log(`  ... and ${missing.length - 10} more`);
  console.log('');
}

if (apply) {
  console.log(`Created ${created} series, linked ${linked} books, skipped ${skipped}.`);
  console.log('\nSeries missing book one:');
  for (const group of proposal.continuingStories) {
    const series = getSeries(db, group.name);
    if (!series) continue;
    const state = seriesState(db, series.id);
    if (state.completeness === 'no-first') {
      console.log(`  ${group.name} — has ${state.ownedPositions.join(', ')}, missing ${state.missingPositions.join(', ')}`);
    }
  }
} else {
  console.log('Dry run. Nothing changed. Re-run with --apply to commit.');
}
