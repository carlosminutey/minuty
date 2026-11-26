// Creates or updates the database tables and functions (sql/schema.sql) and stores the
// bcrypt hash of DATA_PASSWORD. Run once, and again after changing DATA_PASSWORD:
//   npm run db:setup
// Needs SUPABASE_DB_PASSWORD and SUPABASE_DB_HOST in .env (only used here, never on GitHub).
import fs from 'node:fs';
import pg from 'pg';

const need = (k) => { const v = (process.env[k] ?? '').trim(); if (!v) throw new Error(`Missing env: ${k}`); return v; };
const ref = new URL(need('SUPABASE_URL')).host.split('.')[0];
const client = new pg.Client({
  host: need('SUPABASE_DB_HOST'),
  port: 5432,
  user: `postgres.${ref}`,
  password: need('SUPABASE_DB_PASSWORD'),
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
});

await client.connect();
await client.query(fs.readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
await client.query(
  `insert into public.minuty_auth (id, pass_hash) values (1, extensions.crypt($1, extensions.gen_salt('bf', 10)))
   on conflict (id) do update set pass_hash = excluded.pass_hash`,
  [need('DATA_PASSWORD')],
);
await client.query(`notify pgrst, 'reload schema'`);
await client.end();
console.log('Database ready: tables, functions and the DATA_PASSWORD hash are set.');
