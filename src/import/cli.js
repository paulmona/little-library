#!/usr/bin/env node
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';
import { importBooksJsonFile } from './books-json.js';

const path = process.argv[2];

if (!path) {
  console.error('Usage: npm run import -- <path-to-books.json>');
  console.error('Imports a books.json from the original static generator into the database.');
  process.exit(1);
}

const config = loadConfig();
const db = openDatabase(config.databasePath);

const { imported, unenriched } = importBooksJsonFile(db, path);

console.log(`Imported ${imported} books into ${config.databasePath}`);
if (unenriched > 0) {
  console.log(`${unenriched} have no title yet — they were scanned but never looked up.`);
}
