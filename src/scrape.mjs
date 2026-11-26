// minuty: watches the source site: log in, find new requirements, open each one,
// expand the full text, (optionally) unlock the client chat, and save everything
// into the Supabase database that the web page reads.
import { CFG, log, requireEnv, loadStore, saveStore, launchBrowser, newPage, ensureAi, signIn, rpc } from './common.mjs';
import { lastHoursWindow, inWindow } from './window.mjs';
import { postJobs } from './poster.mjs';

const BASE = CFG.sourceUrl;

requireEnv(['sourceUrl', 'email', 'password', 'dataPassword', 'supabaseUrl', 'supabaseKey']);

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const fingerprint = (row) => `${norm(row.title)}|${norm(row.description).slice(0, 400)}`;

async function login(page) {
  log('Source: signing in…');
  await signIn(page, {
    url: `${BASE}/auth`, email: CFG.email, password: CFG.password, label: 'Source',
    emailBox: () => page.locator('#email'),
    passwordBox: () => page.locator('#pw'),
    submit: () => page.getByRole('button', { name: 'Sign in', exact: true }),
  });
}

// The dashboard loads the full requirement list as JSON; we read that response
// instead of parsing cards, so every field (full description, budget, etc.) is captured.
async function fetchFeed(page) {
  const feedP = page.waitForResponse(
    (r) => r.url().includes('/rest/v1/requirements') && r.request().method() === 'GET' && r.ok(),
    { timeout: 45_000 },
  );
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  const rows = await (await feedP).json();
  if (!Array.isArray(rows)) throw new Error('Unexpected feed response');
  log(`Feed: ${rows.length} requirements (${rows.filter((r) => r.status === 'open').length} open)`);
  return rows;
}

async function scrapeDetail(page, id, { unlock }) {
  const url = `${BASE}/requirements/${id}`;
  // Capture the contact-details JSON if the page loads it (after unlock).
  let contactJson = null;
  const onResp = async (r) => {
    if (/\/rest\/v1\/client_cont/.test(r.url()) && r.ok()) {
      try { contactJson = await r.json(); } catch {}
    }
  };
  page.on('response', onResp);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 30_000 });

    const seeFull = page.getByRole('button', { name: /See full requirement/i });
    if (await seeFull.count()) await seeFull.first().click().catch(() => {});

    const unlockedBtn = page.getByRole('button', { name: /^\s*Unlocked\s*$/i });
    let unlocked = (await unlockedBtn.count()) > 0;
    let unlockResult = unlocked ? 'already' : 'skipped';

    if (!unlocked && unlock) {
      const chat = page.getByRole('button', { name: /Chat with client/i });
      if (await chat.count()) {
        await chat.first().click();
        const confirm = page.getByRole('button', { name: /Unlock for \d+ Stars/i });
        const plans = page.getByRole('link', { name: /plans|get more|top up|buy/i });
        await Promise.race([
          confirm.first().waitFor({ timeout: 15_000 }),
          plans.first().waitFor({ timeout: 15_000 }),
        ]).catch(() => {});
        if (await confirm.count()) {
          await confirm.first().click();
          try {
            await page.getByRole('heading', { name: /Client contact details/i }).waitFor({ timeout: 20_000 });
            await page.getByText('Loading…', { exact: true }).waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
            unlocked = true;
            unlockResult = 'unlocked';
          } catch {
            const toast = await page.locator('[data-sonner-toast]').allInnerTexts().catch(() => []);
            unlockResult = /not enough/i.test(toast.join(' ')) ? 'not-enough-stars' : `failed: ${toast.join(' | ') || 'no contact section'}`;
          }
        } else {
          unlockResult = 'not-enough-stars';
          await page.keyboard.press('Escape').catch(() => {});
        }
      } else {
        unlockResult = 'no-chat-button';
      }
    }

    if (unlocked) {
      await page.getByRole('heading', { name: /Client contact details/i }).waitFor({ timeout: 10_000 }).catch(() => {});
      await page.getByText('Loading…', { exact: true }).waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
    }

    const dom = await page.evaluate(() => {
      const main = document.querySelector('main') || document.body;
      const text = main.innerText.replace(/\n{3,}/g, '\n\n').trim();
      const links = [...main.querySelectorAll('a[href]')]
        .map((a) => ({ text: a.innerText.trim(), href: a.href }))
        // Contact links only: mail, phone, WhatsApp, or any site other than the source itself.
        .filter((l) => /^(mailto:|tel:)/i.test(l.href) || /wa\.me|whatsapp/i.test(l.href) ||
          (/^https?:\/\//i.test(l.href) && new URL(l.href).host !== location.host));
      let contactText = null;
      const h = [...main.querySelectorAll('h2')].find((x) => /Client contact details/i.test(x.innerText));
      if (h) contactText = h.parentElement.innerText.replace(/^Client contact details\s*/i, '').trim();
      return { text, links, contactText };
    });

    return {
      url,
      unlocked,
      unlockResult,
      pageText: dom.text,
      contactText: dom.contactText,
      contactLinks: dom.links,
      contactData: Array.isArray(contactJson) ? contactJson[0] ?? null : contactJson,
      scrapedAt: new Date().toISOString(),
    };
  } finally {
    page.off('response', onResp);
  }
}

async function main() {
  // Requests from the web page buttons: "Scrape now" (a normal run covers it) and "Retry post".
  const pending = await rpc('minuty_pending').catch((e) => { log(`Requests: ${e.message}`); return []; });
  const retryIds = pending.filter((r) => r.kind === 'retry' && r.post_id).map((r) => r.post_id);

  const prev = await loadStore({ ids: retryIds });
  const firstRun = !prev;
  const store = prev ?? { createdAt: new Date().toISOString(), items: {}, runs: [] };
  for (const id of retryIds) {
    const it = store.items[id];
    if (!it) continue;
    // Forget the earlier attempt; the title check on the job board still prevents a duplicate.
    delete it.post;
    if (store.postLedger) delete store.postLedger[id];
    it.retry = true;
  }
  if (pending.length) log(`Requests: ${pending.length} (${retryIds.length} retry)`);

  const browser = await launchBrowser();
  const page = await newPage(browser);
  const run = { at: new Date().toISOString(), new: 0, unlocked: 0, notes: [] };
  let feedOk = false;

  try {
    await login(page);
    const rows = await fetchFeed(page);
    feedOk = true;

    // Only posts created in the last WINDOW_HOURS (default 24) are captured. Older posts are
    // never opened; posts captured earlier stay in their day's file as a record.
    const win = lastHoursWindow(Date.now(), CFG);
    store.date = win.date;
    store.window = `last ${CFG.windowHours} h`;
    store.sourceUrl = CFG.sourceUrl; // the page builds "open" links from this (behind the password)
    // Content fingerprints of everything captured in the last 7 days, so a post that is
    // reposted under a new ID (same title + description) is never captured twice.
    store.fingerprints = Object.fromEntries(
      Object.entries(store.fingerprints ?? {}).filter(([, at]) => Date.now() - new Date(at) < 7 * 864e5),
    );
    for (const it of Object.values(store.items)) store.fingerprints[fingerprint(it.row)] ??= it.firstSeenAt;

    const todays = rows.filter((r) => inWindow(r.created_at, win));
    const newIds = [];
    let dupes = 0;
    for (const row of todays) {
      const existing = store.items[row.id];
      if (existing) {
        existing.row = row; // picks up status changes like open → closed
        continue;
      }
      const fp = fingerprint(row);
      if (store.fingerprints[fp]) { dupes++; continue; }
      store.fingerprints[fp] = run.at;
      store.items[row.id] = { id: row.id, firstSeenAt: run.at, row, detail: null };
      newIds.push(row.id);
    }
    run.new = newIds.length;
    log(`${store.window}: ${todays.length} posts in window, ${newIds.length} new, ${dupes} duplicates skipped.`);

    // Decide which posts get a detail visit this run.
    // A post that is already scraped and unlocked is never opened again.
    const shouldVisit = (it) =>
      it.row.status === 'open' &&
      inWindow(it.row.created_at, win) &&
      (!it.detail || (CFG.autoUnlock && !it.detail.unlocked && it.detail.unlockResult !== 'no-chat-button'));
    const queue = Object.values(store.items)
      .filter(shouldVisit)
      .sort((a, b) => String(b.row.created_at).localeCompare(String(a.row.created_at)));

    let unlocksLeft = CFG.autoUnlock ? CFG.maxUnlocksPerRun : 0;
    let outOfStars = false;
    for (const it of queue) {
      const wantUnlock = unlocksLeft > 0 && !outOfStars;
      if (it.detail && !wantUnlock) continue; // already scraped, nothing more to do now
      log(`→ post ${it.id.slice(0, 8)} unlock=${wantUnlock}`);
      try {
        const detail = await scrapeDetail(page, it.id, { unlock: wantUnlock });
        it.detail = detail;
        if (detail.unlockResult === 'unlocked') { unlocksLeft--; run.unlocked++; }
        if (detail.unlockResult === 'not-enough-stars') { outOfStars = true; run.notes.push('Out of Stars'); }
        log(`   ${detail.unlockResult}`);
      } catch (e) {
        log(`   error: ${e.message}`);
        run.notes.push(`${it.id}: ${e.message}`);
      }
      await page.waitForTimeout(1500 + Math.random() * 1500); // be gentle
    }
    if (CFG.autoUnlock && unlocksLeft === 0 && queue.some((it) => !it.detail?.unlocked)) {
      run.notes.push(`Unlock cap (${CFG.maxUnlocksPerRun}) reached; remaining posts will unlock next run.`);
    }

    await ensureAi(store, run);

    // Post new jobs to the job board (skipped when TARGET_EMAIL / TARGET_PASSWORD are not set).
    if (CFG.targetEmail && CFG.targetPassword && CFG.autoPost) {
      await saveStore(store); // keep the scrape safe even if posting crashes
      try {
        await postJobs(page, store, { limit: CFG.maxPostsPerRun, run });
      } catch (e) {
        // A posting problem must not lose the scrape; posts left over are retried next run.
        const msg = e.message.split('\n')[0];
        log('Job board step failed.');
        run.notes.push(`Posting failed: ${msg}`);
      }
    }
  } catch (e) {
    run.notes.push(`FATAL: ${e.message}`);
    await page.screenshot({ path: 'error.png', fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
    if (feedOk || !firstRun) {
      for (const id of retryIds) {
        const it = store.items[id];
        if (!it) continue;
        run.notes.push(`Retry ${id.slice(0, 8)}: ${it.post?.postedAt ? (it.post.note || 'posted') : 'not posted'}`);
        delete it.retry;
      }
      store.runs = [run, ...(store.runs ?? [])].slice(0, 200);
      await saveStore(store);
      if (pending.length) {
        await rpc('minuty_done', { p_ids: pending.map((r) => r.id), p_result: feedOk ? 'done' : 'run failed' }).catch(() => {});
      }
      log('Saved.', JSON.stringify({ ...run, notes: run.notes.length }), run.notes.length ? '(details on the web page, Runs tab)' : '');
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
