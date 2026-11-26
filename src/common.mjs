// Shared bits for scrape.mjs and post.mjs: config, database, browser, AI step.
import { chromium } from 'playwright';
import { rewrite, loadRules } from './groq.mjs';


export const env = (k, d) => (process.env[k] ?? '').trim() || d;
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export const CFG = {
  // Site addresses live in env / GitHub Secrets, not in the code.
  sourceUrl: env('SOURCE_URL', '').replace(/\/+$/, ''),
  targetUrl: env('TARGET_URL', '').replace(/\/+$/, ''),
  // Database (Supabase). The publishable key is public by design; data access needs DATA_PASSWORD.
  supabaseUrl: env('SUPABASE_URL', '').replace(/\/+$/, ''),
  supabaseKey: env('SUPABASE_PUBLISHABLE_KEY', ''),
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
  const names = { supabaseUrl: 'SUPABASE_URL', supabaseKey: 'SUPABASE_PUBLISHABLE_KEY', email: 'SOURCE_EMAIL', password: 'SOURCE_PASSWORD', dataPassword: 'DATA_PASSWORD', targetEmail: 'TARGET_EMAIL', targetPassword: 'TARGET_PASSWORD', sourceUrl: 'SOURCE_URL', targetUrl: 'TARGET_URL' };
  for (const k of keys) if (!CFG[k]) throw new Error(`Missing env: ${names[k] ?? k}`);
}

// IST calendar date (YYYY-MM-DD) of an ISO time.
export function istDate(iso, offsetMin = CFG.tzOffsetMin) {
  return new Date(new Date(iso).getTime() + offsetMin * 60_000).toISOString().slice(0, 10);
}

// Calls a database function (Supabase). Every function checks DATA_PASSWORD itself.
export async function rpc(name, args = {}) {
  if (!CFG.supabaseUrl || !CFG.supabaseKey) throw new Error('Missing env: SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY');
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: CFG.supabaseKey, 'content-type': 'application/json' },
      body: JSON.stringify({ p_pass: CFG.dataPassword, ...args }),
    });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    if (res.status >= 500 && attempt < 3) { await new Promise((r) => setTimeout(r, attempt * 3000)); continue; }
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).message || msg; } catch {}
    throw new Error(`Database ${name}: ${msg}`);
  }
}

// State (records, run log, rotation) plus the posts of today and yesterday (IST), which is
// all the 24-hour window can touch, plus any extra ids asked for. Null on the very first run.
export async function loadStore({ ids = [] } = {}) {
  const res = await rpc('minuty_load', { p_days: 2, p_ids: ids });
  if (!res.state && !Object.keys(res.items ?? {}).length) return null;
  return { ...(res.state ?? {}), items: res.items ?? {} };
}

export async function saveStore(store) {
  store.updatedAt = new Date().toISOString();
  const { items, days, dayHashes, ...state } = store;
  const list = Object.values(items ?? {}).map((it) => ({
    id: it.id, day: istDate(it.row.created_at), created_at: it.row.created_at, data: it,
  }));
  await rpc('minuty_save', { p_items: list, p_state: state });
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
    .filter((it) => !it.ai?.format && !it.post?.postedAt && (it.row.status === 'open' || it.retry) && it.detail)
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
