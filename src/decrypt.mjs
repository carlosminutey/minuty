// Prints the decrypted data as JSON: npm run decrypt > out.json
//   npm run decrypt              state + today's and yesterday's posts
//   npm run decrypt -- 2026-11-25   one day's posts
import fs from 'node:fs';
import { decryptJson } from './crypto.mjs';
import { loadStore } from './common.mjs';

const day = process.argv[2];
let data;
if (day) {
  const file = new URL(`../docs/data/${day}.enc.json`, import.meta.url);
  data = await decryptJson(JSON.parse(fs.readFileSync(file, 'utf8')), process.env.DATA_PASSWORD);
} else {
  data = await loadStore();
}
process.stdout.write(JSON.stringify(data, null, 2));
