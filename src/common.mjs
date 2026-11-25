// Shared bits for scrape.mjs and post.mjs: config, encrypted store, browser, AI step.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { encryptJson, decryptJson } from './crypto.mjs';
import { rewrite, loadRules } from './groq.mjs';

// Encrypted data for the web page: docs/data/state.enc.json (records, run log, list of days)
// plus one docs/data/YYYY-MM-DD.enc.json per IST day, so past days never change once done.
const DATA_DIR = new URL('../docs/data/', import.meta.url);
const LEGACY_STORE = new URL('../docs/data.enc.json', import.meta.url);

export const env = (k, d) => (process.env[k] ?? '').trim() || d;
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export const CFG = {
  // Site addresses live in env / GitHub Secrets, not in the code.
  sourceUrl: env('SOURCE_URL', '').replace(/\/+$/, ''),
  targetUrl: env('TARGET_URL', '').replace(/\/+$/, ''),
  email: env('SOURCE_EMAIL'),
  password: env('SOURCE_PASSWORD'),
  dataPassword: env('DATA_PASSWORD'),
  autoUnlock: env('AUTO_UNLOCK', 'true') === 'true',
  // 0 = no limit
  maxUnlocksPerRun: Number(env('MAX_UNLOCKS_PER_RUN', '0')) || Infinity,
  // Only posts created in the last N hours are kept. Older posts are dropped.
  windowHours: Number(env('WINDOW_HOURS', '24')) || 24,
  tzOffsetMin: Number(env('TZ_OFFSET_MINUTES', '330')), // IST = UTC+5:30, no daylight saving
  headless: env('HEADLESS', 'true') !== 'false',
  channel: env('BROWSER_CHANNEL', '') || undefined, // e.g. "chrome" to use installed Chrome locally
  // AI rewrite: skipped when no key is set.
  groqKey: env('GROQ_API_KEY', ''),
  groqModel: env('GROQ_MODEL', 'openai/gpt-oss-120b'),
  // Job board posting: skipped when no login is set.
  targetEmail: env('TARGET_EMAIL', ''),
  targetPassword: env('TARGET_PASSWORD', ''),
  autoPost: env('AUTO_POST', 'true') === 'true',
  // 0 = no limit
  maxPostsPerRun: Number(env('MAX_POSTS_PER_RUN', '0')) || Infinity,
};

export function requireEnv(keys) {
  const names = { email: 'SOURCE_EMAIL', password: 'SOURCE_PASSWORD', dataPassword: 'DATA_PASSWORD', targetEmail: 'TARGET_EMAIL', targetPassword: 'TARGET_PASSWORD', sourceUrl: 'SOURCE_URL', targetUrl: 'TARGET_URL' };
  for (const k of keys) if (!CFG[k]) throw new Error(`Missing env: ${names[k] ?? k}`);
}

// IST calendar date (YYYY-MM-DD) of an ISO time.
export function istDate(iso, offsetMin = CFG.tzOffsetMin) {
  return new Date(new Date(iso).getTime() + offsetMin * 60_000).toISOString().slice(0, 10);
}

// If DATA_PASSWORD was changed, set OLD_DATA_PASSWORD once: files are read with the old one
// and saved again with the new one (npm run rekey).
const readBox = async (url) => {
  const box = JSON.parse(fs.readFileSync(url, 'utf8'));
  try {
    return await decryptJson(box, CFG.dataPassword);
  } catch (e) {
    const old = env('OLD_DATA_PASSWORD', '');
    if (!old) throw new Error('Cannot decrypt the saved data with DATA_PASSWORD. If you changed it, add OLD_DATA_PASSWORD (the previous one) to .env and run: npm run rekey');
    return decryptJson(box, old);
  }
};
const writeBox = async (url, obj) => fs.writeFileSync(url, JSON.stringify(await encryptJson(obj, CFG.dataPassword)));
const dayFile = (date) => new URL(`${date}.enc.json`, DATA_DIR);
const sha = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);

// Returns the state plus `items` from today's and yesterday's day files (all the 24-hour
// window can touch). Older days stay on disk untouched. Returns null on the very first run.
export async function loadStore() {
  const stateUrl = new URL('state.enc.json', DATA_DIR);
  if (!fs.existsSync(stateUrl)) {
    if (!fs.existsSync(LEGACY_STORE)) return null;
    return { dayHashes: {}, ...(await readBox(LEGACY_STORE)) }; // one-time move to the per-day layout
  }
  const store = await readBox(stateUrl);
  store.items = {};
  const today = istDate(new Date().toISOString());
  const yesterday = istDate(new Date(Date.now() - 864e5).toISOString());
  for (const date of [yesterday, today]) {
    if (!fs.existsSync(dayFile(date))) continue;
    Object.assign(store.items, (await readBox(dayFile(date))).items);
  }
  return store;
}


const KEEP_DAYS = 60;

export async function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  store.updatedAt = new Date().toISOString();
  store.days ??= {};
  store.dayHashes ??= {};

  const byDay = {};
  for (const it of Object.values(store.items)) (byDay[istDate(it.row.created_at)] ??= {})[it.id] = it;
  for (const [date, items] of Object.entries(byDay)) {
    const list = Object.values(items);
    store.days[date] = {
      count: list.length,
      unlocked: list.filter((it) => it.detail?.unlocked).length,
      rewritten: list.filter((it) => it.ai).length,
      posted: list.filter((it) => it.post?.postedAt).length,
    };
    const h = sha(items);
    if (store.dayHashes[date] === h && fs.existsSync(dayFile(date))) continue; // unchanged: don't rewrite the file
    await writeBox(dayFile(date), { date, items });
    store.dayHashes[date] = h;
  }

  // Drop days older than KEEP_DAYS.
  const cutoff = istDate(new Date(Date.now() - KEEP_DAYS * 864e5).toISOString());
  for (const date of Object.keys(store.days)) {
    if (date >= cutoff) continue;
    delete store.days[date];
    delete store.dayHashes[date];
    fs.rmSync(dayFile(date), { force: true });
  }

  const { items, ...state } = store;
  await writeBox(new URL('state.enc.json', DATA_DIR), state);
  if (fs.existsSync(LEGACY_STORE)) fs.rmSync(LEGACY_STORE);
}

// If Playwright's bundled browser is blocked (some Windows setups), fall back to installed Chrome.
export async function launchBrowser() {
  return chromium.launch({ headless: CFG.headless, channel: CFG.channel }).catch((e) => {
    if (CFG.channel) throw e;
    log(`Bundled browser failed (${e.message.split('\n')[0]}); trying installed Chrome…`);
    return chromium.launch({ headless: CFG.headless, channel: 'chrome' });
  });
}

export async function newPage(browser) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  });
  return context.newPage();
}

// AI rewrite: title, description (in the next layout from prompts/formats.md, in rotation),
// duration and client location. Each post is sent to Groq ONCE: anything that already has a
// rewrite is skipped, so no tokens are spent twice.
export async function ensureAi(store, run) {
  if (!CFG.groqKey) return;
  const rules = loadRules();
  run.rewritten = 0;
  const todo = Object.values(store.items)
    .filter((it) => !it.ai?.format && !it.post?.postedAt && it.row.status === 'open' && it.detail)
    .sort((a, b) => String(a.row.created_at).localeCompare(String(b.row.created_at)));
  for (const it of todo) {
    const n = (store.formatCursor ?? 0) % rules.formats.length;
    try {
      it.ai = await rewrite(
        { title: it.row.title, description: it.row.description },
        { apiKey: CFG.groqKey, model: CFG.groqModel, rules, format: rules.formats[n] },
      );
      store.formatCursor = (store.formatCursor ?? 0) + 1;
      run.rewritten++;
    } catch (e) {
      log(`   groq error (${it.id}): ${e.message}`);
      run.notes.push(`AI rewrite failed: ${e.message}`);
    }
  }
  log(`AI rewrites: ${run.rewritten}`);
}

// Signs in on a login page and waits until it leaves `/auth`. On a slow machine the page's
// script may not be ready when the button is first clicked, so it waits for the page to
// settle and retries a few times. Errors never include page text or addresses (logs are public).
export async function signIn(page, { url, email, password, emailBox, passwordBox, submit, label }) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  for (let attempt = 1; attempt <= 3; attempt++) {
    await emailBox().fill(email);
    await passwordBox().fill(password);
    await page.waitForTimeout(500 * attempt);
    await submit().click();
    try {
      await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: attempt === 3 ? 30_000 : 12_000 });
      log(`${label}: signed in (attempt ${attempt})`);
      return;
    } catch {
      const err = await page.locator('[role=alert], [data-sonner-toast]').allInnerTexts().catch(() => []);
      if (err.some((t) => /invalid|incorrect|wrong|credentials/i.test(t))) {
        throw new Error(`${label}: sign-in rejected (wrong email or password?)`);
      }
      log(`${label}: still on the sign-in page after attempt ${attempt}, retrying…`);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    }
  }
  throw new Error(`${label}: sign-in did not complete after 3 attempts`);
}
