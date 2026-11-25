// Turns a scraped item into the values typed into the job board's "Add job" form.
// Pure functions only, so `npm run post -- --dry` can show the result without a browser.

// The job board has 7 categories; almost everything we get is tech, so IT & Software is the default.
export function mapCategory(cc = '') {
  const c = cc.toLowerCase();
  if (/ui|ux|design|graphic|brand|video|animation|creative/.test(c) && !/web|app|develop/.test(c)) return 'Design & Creative';
  if (/marketing|seo|social media|ads|growth/.test(c)) return 'Marketing';
  if (/writ|content|translat|copy/.test(c)) return 'Writing & Translation';
  if (/lead|sales|customer|support/.test(c)) return 'Sales & Customer Service';
  if (/admin|virtual assist|data entry/.test(c)) return 'Admin Support';
  if (/financ|account|bookkeep/.test(c)) return 'Finance & Accounting';
  return 'IT & Software';
}

// "15-35 USD / Hour" → hourly 15–35. "25 USD / Hour" → hourly 20–30 (±5).
// "$500" / "500-1000 USD" → fixed, one number (the higher end of a range).
export function mapBudget(cc = '') {
  const nums = String(cc).replace(/,/g, '').match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
  const hourly = /hour|\/\s*hr|per\s*h/i.test(cc);
  if (!nums.length) return { type: hourly ? 'hourly' : 'fixed' };
  if (hourly) {
    let [min, max] = nums.length > 1 ? [Math.min(...nums), Math.max(...nums)] : [nums[0] - 5, nums[0] + 5];
    if (min < 1) min = 1;
    if (max <= min) max = min + 5;
    return { type: 'hourly', min, max };
  }
  return { type: 'fixed', amount: Math.max(...nums) };
}

export function mapWorkLocation(mode = '') {
  const m = mode.toLowerCase();
  if (/hybrid/.test(m)) return 'Hybrid';
  if (/on.?site|office/.test(m)) return 'On-site';
  return 'Remote (worldwide)';
}

// Under 2 years → Entry, 2 to under 5 → Intermediate, 5+ → Expert. No number → Intermediate.
export function mapExperience(text = '') {
  const t = String(text).toLowerCase();
  const n = t.match(/(\d+(\.\d+)?)\s*(?:[-–to+ ]+\s*\d*\+?\s*)?(?:years?|yrs?)/)?.[1];
  if (n === undefined) {
    if (/senior|expert|lead|principal/.test(t)) return 'Expert';
    if (/junior|entry|beginner|fresher/.test(t)) return 'Entry';
    return 'Intermediate';
  }
  const y = Number(n);
  return y < 2 ? 'Entry' : y < 5 ? 'Intermediate' : 'Expert';
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export function extractEmails(item) {
  const d = item.detail ?? {};
  const found = [
    ...String(d.contactData?.email ?? '').matchAll(EMAIL_RE),
    ...(d.contactLinks ?? []).filter((l) => /^mailto:/i.test(l.href)).flatMap((l) => [...l.href.matchAll(EMAIL_RE)]),
  ].map((m) => m[0].toLowerCase());
  return [...new Set(found)];
}

// The source site's created_at (UTC) → the IST date/time typed into the job board's publish fields.
export function toIst(iso, offsetMin = 330) {
  const d = new Date(new Date(iso).getTime() + offsetMin * 60_000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
  };
}

export function buildJob(item, { tzOffsetMin = 330 } = {}) {
  const r = item.row;
  const ai = item.ai ?? {};
  const firstName = String(r.client_name ?? '').trim();
  return {
    title: ai.title || r.title,
    description: ai.description || r.description,
    category: mapCategory(r.category),
    skills: String(r.required_skills ?? ''),
    budget: mapBudget(r.budget),
    workLocation: mapWorkLocation(r.work_mode),
    experience: mapExperience(r.required_experience),
    duration: ai.duration || null, // null = leave the form default
    aboutClient: firstName,
    clientLocation: ai.clientLocation || '',
    emails: extractEmails(item),
    publish: toIst(r.created_at, tzOffsetMin),
  };
}
