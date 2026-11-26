// Posts scraped jobs to the job board through its admin "Add job" form (there is no API),
// then sets each job's "Publish date & time (IST)" to the source site's posting time.
import { CFG, log, signIn } from './common.mjs';
import { buildJob } from './job-map.mjs';

const boardUrl = () => CFG.targetUrl;

// Permanent record of everything posted to job board, by source ID and by content
// fingerprint, kept 30 days. It lives outside store.items, so it survives the 24-hour cleanup.
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const fp = (row) => `${norm(row.title)}|${norm(row.description).slice(0, 400)}`;

function ledger(store) {
  store.postLedger ??= {};
  for (const it of Object.values(store.items)) {
    if (it.post?.postedAt) store.postLedger[it.id] ??= { title: it.post.title, fp: fp(it.row), postedAt: it.post.postedAt };
  }
  for (const [id, v] of Object.entries(store.postLedger)) {
    if (Date.now() - new Date(v.postedAt) > 30 * 864e5) delete store.postLedger[id];
  }
  return store.postLedger;
}

export function alreadyPosted(store, it) {
  const posted = ledger(store);
  if (it.post?.postedAt || posted[it.id]) return true;
  const f = fp(it.row);
  return Object.values(posted).some((v) => v.fp === f);
}

function markPosted(store, it, rec) {
  it.post = rec;
  ledger(store)[it.id] = { title: rec.title, fp: fp(it.row), postedAt: rec.postedAt };
}

// Ready to post: open, scraped, AI done in the current format (when Groq is on), never posted before.
export function postable(store, { needAi = true } = {}) {
  return Object.values(store.items)
    .filter((it) => it.row.status === 'open' && it.detail && !alreadyPosted(store, it))
    .filter((it) => !needAi || !CFG.groqKey || it.ai?.format)
    .sort((a, b) => String(b.row.created_at).localeCompare(String(a.row.created_at)));
}

async function login(page) {
  log('Job board: signing in…');
  await signIn(page, {
    url: `${boardUrl()}/auth`, email: CFG.targetEmail, password: CFG.targetPassword, label: 'Job board',
    emailBox: () => page.locator('input[type=email]').first(),
    passwordBox: () => page.locator('input[type=password]').first(),
    // The real submit button: the page also has a "Log in" tab button that only switches tabs.
    // (It has no type attribute, so match by text and take the last one, after the tab button.)
    submit: () => page.locator('button', { hasText: /^\s*(log in|sign in|login)\s*$/i }).last(),
  });
}

async function openJobsPage(page) {
  await page.goto(`${boardUrl()}/admin/jobs`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Search jobs').first().waitFor({ timeout: 30_000 });
  await page.waitForLoadState('networkidle').catch(() => {});
}

// Form inputs sit next to their label text; find the first input/textarea/select after it.
function field(scope, label) {
  return scope
    .locator(
      `xpath=.//label[starts-with(normalize-space(.), "${label}")]/following::*[self::input or self::textarea or self::select][1]`,
    )
    .first();
}

async function toasts(page) {
  return (await page.locator('[data-sonner-toast], [role=status], [role=alert]').allInnerTexts().catch(() => []))
    .map((t) => t.trim())
    .filter(Boolean)
    .join(' | ');
}

async function fillForm(page, job) {
  await page.getByRole('button', { name: /add job/i }).first().click();
  const create = page.getByRole('button', { name: /^create job$/i });
  await create.waitFor({ timeout: 15_000 });
  const forms = page.locator('form').filter({ has: create });
  const form = (await forms.count()) ? forms.first() : page;

  await field(form, 'Job title').fill(job.title);
  await field(form, 'Description').fill(job.description);
  await field(form, 'Category').selectOption({ label: job.category });
  await field(form, 'Required skills').fill(job.skills);

  const b = job.budget;
  await field(form, 'Budget type').selectOption(b.type);
  await page.waitForTimeout(400);
  if (b.type === 'hourly' && b.min != null) {
    // Choosing "hourly" swaps the amount box for min + max boxes.
    const minBox = form.locator('xpath=.//label[contains(translate(., "MIN", "min"), "min")]/following::input[1]').first();
    const maxBox = form.locator('xpath=.//label[contains(translate(., "MAX", "max"), "max")]/following::input[1]').first();
    if ((await minBox.count()) && (await maxBox.count())) {
      await minBox.fill(String(b.min));
      await maxBox.fill(String(b.max));
    } else {
      const nums = form.locator('input[type=number]');
      if ((await nums.count()) < 2) throw new Error('Hourly min/max boxes not found');
      await nums.nth(0).fill(String(b.min));
      await nums.nth(1).fill(String(b.max));
    }
  } else if (b.type === 'fixed' && b.amount != null) {
    await field(form, 'Budget amount').fill(String(b.amount));
  }

  if (job.duration) await field(form, 'Estimated duration').selectOption({ label: job.duration });
  await field(form, 'Work location').selectOption({ label: job.workLocation });
  await field(form, 'Experience level').selectOption({ label: job.experience });
  if (job.aboutClient) await field(form, 'About the client').fill(job.aboutClient);
  if (job.clientLocation) await field(form, 'Client location').fill(job.clientLocation);

  // Only emails are filled in the private contact section (one box per email).
  const emailBoxes = form.locator('input[type=email]');
  for (let i = 0; i < job.emails.length; i++) {
    if (i > 0) {
      await form.getByRole('button', { name: /add another email/i }).click();
      await page.waitForTimeout(200);
    }
    await emailBoxes.nth(i).fill(job.emails[i]);
  }

  await create.click();
}

// The admin list may cut long titles, so match on the first 60 characters.
const titleKey = (t) => t.slice(0, 60);

// The job's card in the admin list: innermost block holding its title and the publish inputs.
function jobCard(page, title) {
  return page
    .locator('div')
    .filter({ has: page.getByText(titleKey(title)) })
    .filter({ has: page.locator('input[type=time]') })
    .last();
}

// Card fields are a label, an input and a Save button next to it.
const cardInput = (card, label) =>
  card.locator(`xpath=.//*[normalize-space(text())="${label}"]/following::input[1]`).first();

// Sets "Publish date & time (IST)" and "Bid cost" on the job's card, then reloads and reads
// both back to make sure they were saved.
async function setCardValues(page, title, { date, time }, bid) {
  const card = jobCard(page, title);
  await card.waitFor({ timeout: 30_000 });
  await card.locator('input[type=date]').first().fill(date);
  await card.locator('input[type=time]').first().fill(time);
  await card.locator('input[type=time]').first().locator('xpath=following::button[1]').click();
  await page.waitForTimeout(1500);

  const bidBox = cardInput(card, 'Bid cost');
  await bidBox.fill(String(bid));
  await bidBox.locator('xpath=following::button[1]').click();
  await page.waitForTimeout(1500);

  await openJobsPage(page);
  const again = jobCard(page, title);
  await again.waitFor({ timeout: 30_000 });
  const got = {
    date: await again.locator('input[type=date]').first().inputValue(),
    time: (await again.locator('input[type=time]').first().inputValue()).slice(0, 5),
    bid: Number(await cardInput(again, 'Bid cost').inputValue()),
  };
  return { publishOk: got.date === date && got.time === time, bidOk: got.bid === bid, got };
}

// Bid cost: random whole number from 2 to 5.
const randomBid = () => 2 + Math.floor(Math.random() * 4);

export async function postJobs(page, store, { limit = Infinity, run, needAi = true }) {
  const queue = postable(store, { needAi }).slice(0, limit);
  if (!queue.length) return log('Job board: nothing new to post.');
  run.posted = 0;
  await login(page);

  for (const it of queue) {
    const job = buildJob(it, CFG);
    log(`Job board → post ${it.id.slice(0, 8)}`);
    try {
      await openJobsPage(page);
      // Safety net against double posting if a previous run crashed before saving its ledger.
      if (await page.getByText(titleKey(job.title)).count()) {
        markPosted(store, it, { postedAt: new Date().toISOString(), title: job.title, note: 'already on the job board' });
        log('   already on the job board, skipped');
        continue;
      }
      await fillForm(page, job);
      try {
        await page.getByText(titleKey(job.title)).first().waitFor({ timeout: 30_000 });
      } catch {
        throw new Error(`Create job did not show up. ${await toasts(page)}`.trim());
      }
      markPosted(store, it, { postedAt: new Date().toISOString(), title: job.title, publish: job.publish });
      run.posted++;
      log('   created');

      const bid = randomBid();
      const set = await setCardValues(page, job.title, job.publish, bid);
      Object.assign(it.post, { publishSet: set.publishOk, bid, bidSet: set.bidOk });
      log(set.publishOk ? `   publish time set ${job.publish.date} ${job.publish.time} IST` : `   publish time NOT confirmed (page shows ${set.got.date} ${set.got.time})`);
      log(set.bidOk ? `   bid cost set to ${bid}` : `   bid cost NOT confirmed (page shows ${set.got.bid})`);
      if (!set.publishOk) run.notes.push(`Job board publish time not confirmed: ${job.title}`);
      if (!set.bidOk) run.notes.push(`Job board bid cost not confirmed: ${job.title}`);
    } catch (e) {
      log(`   board error: ${e.message}`);
      run.notes.push(`Job board ${it.id}: ${e.message}`);
      await page.screenshot({ path: 'error-post.png', fullPage: true }).catch(() => {});
    }
    await page.waitForTimeout(1500);
  }
}
