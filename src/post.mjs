// Post already-scraped jobs to the job board without scraping again.
//   npm run post -- --limit=1     post only the newest one
//   npm run post -- --no-ai       use the saved AI text, no Groq calls
//   npm run post -- --dry         show what would be filled in, post nothing
import { CFG, log, requireEnv, loadStore, saveStore, launchBrowser, newPage, ensureAi } from './common.mjs';
import { postJobs, postable } from './poster.mjs';
import { buildJob } from './job-map.mjs';

const arg = (k) => process.argv.slice(2).find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
const limit = Number(arg('limit')?.split('=')[1]) || Infinity;
const dry = !!arg('dry');
// --no-ai: post with the AI text already saved, no Groq calls
const noAi = !!arg('no-ai');

requireEnv(dry ? ['dataPassword'] : ['dataPassword', 'targetUrl', 'targetEmail', 'targetPassword']);
const store = await loadStore();
if (!store) throw new Error('No scraped data yet. Run npm run scrape first.');
const run = { at: new Date().toISOString(), kind: 'post', notes: [] };

if (!dry && !noAi) await ensureAi(store, run);

if (dry) {
  const q = postable(store, { needAi: false }).slice(0, limit);
  log(`${q.length} job(s) would be posted:`);
  for (const it of q) {
    const j = buildJob(it, CFG);
    console.log(JSON.stringify({ ...j, emails: j.emails.map((e) => e.replace(/^(.).*@/, '$1***@')) }, null, 2));
  }
} else {
  const browser = await launchBrowser();
  try {
    await postJobs(await newPage(browser), store, { limit, run, needAi: !noAi });
  } finally {
    await browser.close();
    store.runs = [run, ...(store.runs ?? [])].slice(0, 200);
    await saveStore(store);
    log('Saved.', JSON.stringify(run));
  }
}
