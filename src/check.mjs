// Decides whether this workflow run should do a full scrape. Writes go=true/false to $GITHUB_OUTPUT.
// - the 3-hourly schedule and the manual "Run workflow" button always run;
// - the 10-minute check runs only when the web page asked for something (Scrape now / Retry post).
import fs from 'node:fs';
import { rpc, log } from './common.mjs';

const event = process.env.GITHUB_EVENT_NAME || 'manual';
const cron = process.env.SCHEDULE || '';
let go = event !== 'schedule' || cron === process.env.MAIN_CRON;
let why = go ? `${event} ${cron}`.trim() : 'no requests';
if (!go) {
  const pending = await rpc('minuty_pending').catch((e) => { log(`check: ${e.message}`); return []; });
  if (pending.length) { go = true; why = `${pending.length} request(s) from the web page`; }
}
log(`check: go=${go} (${why})`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `go=${go}\n`);
