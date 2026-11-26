// Prints the saved data as JSON: npm run decrypt > out.json
//   npm run decrypt                 state + today's and yesterday's posts
//   npm run decrypt -- 2026-11-25   one day's posts
import { loadStore, rpc } from './common.mjs';

const day = process.argv[2];
const data = day ? await rpc('minuty_day', { p_day: day }) : await loadStore();
process.stdout.write(JSON.stringify(data, null, 2));
