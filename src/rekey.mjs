// Re-encrypt all saved data after changing DATA_PASSWORD.
// Put the previous password in .env as OLD_DATA_PASSWORD, run `npm run rekey`, then remove that line.
// Also brings old data up to date (field names, source address used by the page).
import fs from 'node:fs';
import { encryptJson, decryptJson } from './crypto.mjs';

const dir = new URL('../docs/data/', import.meta.url);
const pw = (process.env.DATA_PASSWORD ?? '').trim();
const old = (process.env.OLD_DATA_PASSWORD ?? '').trim();
if (!pw) throw new Error('Missing env: DATA_PASSWORD');

let done = 0;
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.enc.json'))) {
  const url = new URL(f, dir);
  const box = JSON.parse(fs.readFileSync(url, 'utf8'));
  let data;
  try { data = await decryptJson(box, pw); } catch {
    if (!old) throw new Error(`${f}: not readable with DATA_PASSWORD. Set OLD_DATA_PASSWORD in .env.`);
    try { data = await decryptJson(box, old); } catch { throw new Error(`${f}: not readable with DATA_PASSWORD or OLD_DATA_PASSWORD.`); }
  }

  // Older field names for the posting record.
  if (data.hhPosted) { data.postLedger = { ...data.hhPosted, ...data.postLedger }; delete data.hhPosted; }
  for (const it of Object.values(data.items ?? {})) if (it.hh) { it.post ??= it.hh; delete it.hh; }
  for (const r of data.runs ?? []) {
    if (r.hhPosted != null) { r.posted = r.hhPosted; delete r.hhPosted; }
    if (r.kind === 'post-hh') r.kind = 'post';
  }
  if (f === 'state.enc.json') {
    data.sourceUrl = (process.env.SOURCE_URL ?? '').trim().replace(/\/+$/, '') || data.sourceUrl;
    data.dayHashes = {}; // the next save writes every day file fresh
  }

  fs.writeFileSync(url, JSON.stringify(await encryptJson(data, pw)));
  done++;
}
console.log(`Re-encrypted ${done} file(s) with DATA_PASSWORD. You can now remove OLD_DATA_PASSWORD from .env.`);
