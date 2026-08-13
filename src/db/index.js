import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { migrate } from './schema.js';

export function openDatabase(path = ':memory:') {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);

  // Foreign keys are off by default in SQLite and silently do nothing without this.
  db.exec('PRAGMA foreign_keys = ON');
  // WAL survives the container being killed mid-write better than the default.
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');

  migrate(db);
  return db;
}
