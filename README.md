# minuty

A small personal automation. Every 3 hours it:

1. Logs in to a **source site** and reads its list of new requirements.
2. Opens each new post, expands the full text, unlocks the client contact, and saves it all.
3. Sends each post once to **Groq AI** for a rewrite, in one of 10 rotating layouts.
4. Posts the rewritten job to a **job board** through its admin form, then sets its publish time and bid cost.
5. Saves everything encrypted in `docs/data/` and shows it on a phone-friendly web page.

It all runs free on GitHub: Actions does the runs and Pages hosts the page.
The site addresses and logins are never in the code. They live in GitHub Secrets (and in `.env` locally).

## Schedule and window
- Runs **every 3 hours, all day**: 02:30, 05:30, 08:30, 11:30, 14:30, 17:30, 20:30 and 23:30 IST.
- Captures posts **created in the last 24 hours** (`WINDOW_HOURS`). Older posts are never opened.
- To change how often it runs, edit the cron line in `.github/workflows/scrape.yml` (cron is in UTC, which is IST minus 5:30).

## Nothing is done twice
- **Scraping:** a post that is already captured is never opened or unlocked again. A repost with a new ID but the same title and description (checked over 7 days) is skipped.
- **AI:** each post is sent to Groq **once**. A post that already has a rewrite is never sent again, so no tokens are wasted.
- **Posting:** a permanent record of posted jobs (by ID and by content, kept 30 days) stops reposting. As a backup, a job whose title is already on the job board is skipped.

## AI rewrite (Groq)
- Rules go in `prompts/rewrite-rules.md`. Groq returns a new title, a new description, a duration and a client location.
- **10 description layouts** are in `prompts/formats.md`: paragraphs only, casual, dashes with no titles, headings with bullets, numbered steps, short and direct, story first, Q&A, paragraph plus skills line, and mixed. Each new post gets the next layout, and post 11 loops back to layout 1. Edit or add layouts freely.
- Run `npm run test-groq -- 3` to try layout 3 on a sample post.
- Uses the free `openai/gpt-oss-120b` model. With no `GROQ_API_KEY` set, this step is skipped.

## Posting
In the same run, as soon as a post is rewritten, it's posted and published immediately.
- **Title and description:** the AI versions, as plain text (never HTML).
- **Category:** mapped from the source; almost everything becomes IT & Software.
- **Budget:** hourly jobs get min and max (a single rate becomes ±$5). Fixed jobs get one number (the top of a range).
- **Duration and client location:** chosen by Groq for each job. **About the client:** the client name only. **Work location:** from the source, otherwise Remote (worldwide).
- **Experience:** under 2 years → Entry, 2–5 → Intermediate, 5+ → Expert, otherwise Intermediate.
- **Private contacts:** only the client's emails, one box per email.
- **On the job's card:** the publish date and time (IST) is set to the source's posting time, and the **bid cost** is a random 2–5. Both are saved, then read back after a reload.
- `npm run post -- --dry` shows what would be filled in. `npm run post -- --limit=1` posts just the newest job. `--no-ai` posts with the saved AI text and makes no Groq calls.

## The web page
- **Today:** today's posts (IST), with counts for captured, unlocked, rewritten and posted. Filters: All, Not posted, Posted, Locked.
- **Each post** shows a 4-step strip (Scraped → Unlocked → Rewritten → Posted, each with its time), the contacts with copy buttons, the AI version (with its layout name), the posting details (posted time, publish time, bid cost) and the original. There are buttons to copy everything, the email, the title or the description.
- **Past days:** every earlier day, kept 60 days. **Runs:** a log of every check (new, unlocked, rewritten, posted, plus any problems).

## One-time setup on GitHub
1. Push this folder to a GitHub repo.
2. In the repo, go to **Settings → Secrets and variables → Actions → Secrets** and add:
   - `SOURCE_URL`, `SOURCE_EMAIL`, `SOURCE_PASSWORD`: the source site's address and login
   - `TARGET_URL`, `TARGET_EMAIL`, `TARGET_PASSWORD`: the job board's address and admin login
   - `DATA_PASSWORD`: the passphrase that encrypts the data (the same one as in your `.env`; you type it on the web page)
   - `GROQ_API_KEY`: your Groq key
3. Optional: on the **Variables** tab, set `AUTO_UNLOCK`, `MAX_UNLOCKS_PER_RUN`, `WINDOW_HOURS`, `GROQ_MODEL`, `AUTO_POST` and `MAX_POSTS_PER_RUN`.
4. Go to **Settings → Pages**, set Source to *Deploy from a branch*, choose branch `main` and folder `/docs`, then save.
5. Go to **Actions → minuty → Run workflow** to test a run now.
6. On your phone, open the Pages address, enter the `DATA_PASSWORD`, and add the page to your home screen.

## Run locally
```powershell
copy .env.example .env
```
Fill in `.env`, then:
```powershell
npm install; npx playwright install chromium; npm run scrape
```
- Set `HEADLESS=false` in `.env` to watch the browser.
- `npm run view` opens the page at http://localhost:5174.
- `npm run export` writes the data to `today.decrypted.json`, which git ignores.
- Changed `DATA_PASSWORD`? Add the old one as `OLD_DATA_PASSWORD` in `.env`, run `npm run rekey`, then remove that line.

## Notes
- If a run fails, the Actions log says why. Logs never show site addresses or page text, because the repo is public.
- GitHub may delay scheduled runs by a few minutes when it's busy. That's normal.

## Code map
- `src/scrape.mjs`: the main run (scrape, then AI, then posting).
- `src/poster.mjs`: the posting browser steps. `src/job-map.mjs`: the field mapping.
- `src/groq.mjs`: the AI rewrite. `src/common.mjs`: config, encrypted storage, browser.
