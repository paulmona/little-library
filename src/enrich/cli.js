#!/usr/bin/env node
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';
import { enrichLibrary } from './run.js';
import { syncFromSheet } from '../sheet/ingest.js';

const force = process.argv.includes('--refresh');
const skipSheet = process.argv.includes('--no-sheet');

const config = loadConfig();
const db = openDatabase(config.databasePath);

if (!skipSheet && config.sheet.gatewayUrl) {
  const sync = await syncFromSheet(db, config.sheet);
  if (sync.ok) console.log(`Sheet: ${sync.seen} ISBNs, ${sync.added} new`);
  else console.warn(`Sheet unreachable (${sync.error}) — continuing with what we have`);
}

if (!config.googleBooks.apiKey) {
  console.warn('No Google Books API key configured; lookups will be rate limited.');
}

const result = await enrichLibrary(db, {
  apiKey: config.googleBooks.apiKey,
  force,
  onProgress: ({ isbn, title }) => console.log(title ? `  ${isbn}  ${title}` : `  ${isbn}  (not found)`),
});

console.log(`\nConsidered ${result.considered}, enriched ${result.enriched}, unresolved ${result.failed}.`);
