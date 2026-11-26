// Decides whether this workflow run should do a full scrape. Writes go=true/false to $GITHUB_OUTPUT.
// GitHub's schedule is unreliable (runs come late, get merged or skipped), so instead of trusting
// the exact time, a full run happens when:
//   - it was started by hand ("Run workflow"), or
//   - the last full run is 3 hours old or more, or
//   - the web page asked for something (Scrape now / Retry post).
import fs from 'node:fs';
import { rpc, log } from './common.mjs';

const EVERY_MIN = Number(process.env.RUN_EVERY_MINUTES || 180) - 10; // small margin for GitHub delays
const event = process.env.GITHUB_EVENT_NAME || 'manual';
let go = event !== 'schedule';
let why = go ? event : '';
let due = false;

if (!go) {
  try {
    const o = await rpc('minuty_overview');
    const last = (o.runs || []).find((r) => r.kind !== 'post');
    const ageMin = last ? (Date.now() - new Date(last.at)) / 6e4 : Infinity;
    const pending = (o.requests || []).filter((r) => !r.done_at);
    if (ageMin >= EVERY_MIN) { go = true; due = true; why = `last full run ${Math.round(ageMin)} min ago`; }
    else if (pending.length) { go = true; why = `${pending.length} request(s) from the web page`; }
    else why = `nothing to do (last full run ${Math.round(ageMin)} min ago)`;
  } catch (e) {
    // Can't reach the database: run anyway rather than silently skip.
    go = true; why = `database check failed (${e.message.split('\n')[0]})`;
  }
}
log(`check: go=${go} (${why})`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `go=${go}\ndue=${due}\n`);
