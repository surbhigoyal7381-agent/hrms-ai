#!/usr/bin/env node
/**
 * Applies the SQL migrations in order, tracking what has run.
 *
 * Migrations are hand-written SQL, not generated: the security model (RLS
 * policies, grants, exclusion constraints) lives in them and must be reviewable
 * line by line in a diff.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example and fill it in.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

if (process.argv.includes('--reset')) {
  console.warn('--reset drops the public schema. Refusing unless HRMS_ALLOW_RESET=1.');
  if (process.env.HRMS_ALLOW_RESET !== '1') process.exit(1);
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migration (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

const applied = new Set(
  (await client.query('SELECT name FROM schema_migration')).rows.map((r) => r.name),
);
const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();

for (const file of files) {
  if (applied.has(file)) { console.log(`skip  ${file}`); continue; }
  const sql = await readFile(join(DIR, file), 'utf8');
  try {
    // Each migration is one transaction: a half-applied security model is worse
    // than none, because it looks applied.
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log(`apply ${file}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`FAILED ${file}\n${err.message}`);
    process.exit(1);
  }
}

await client.end();
console.log('migrations up to date');
