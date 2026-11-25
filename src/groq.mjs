// Rewrites a requirement's title + description with Groq (OpenAI-compatible API),
// and picks job board duration and a client location.
// Rules: prompts/rewrite-rules.md. Description layouts (used in rotation): prompts/formats.md.
import fs from 'node:fs';
import crypto from 'node:crypto';

const API = 'https://api.groq.com/openai/v1/chat/completions';
const RULES_FILE = new URL('../prompts/rewrite-rules.md', import.meta.url);
const FORMATS_FILE = new URL('../prompts/formats.md', import.meta.url);

// The "Estimated duration" options on the job board's form.
export const DURATIONS = ['<1 month', '1-3 months', '3-6 months', '6+ months'];

const BASE_CONTRACT = `
The "description" is pasted into a plain-text box: NO HTML, NO <br>, NO markdown like ** or #.
Use real line breaks (\\n inside the JSON string) and one blank line between paragraphs or blocks.
Keep every fact from the original; do not invent details.

Also decide:
- "duration": the most likely project length, exactly one of: ${DURATIONS.join(', ')}.
- "client_location": a plausible client location as "City, Country", guessed from the text (language, spelling, currency, company details). Always give one.

Return ONLY a JSON object, no markdown, in exactly this shape:
{"title": "...", "description": "...", "duration": "...", "client_location": "..."}`;

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

// Layouts in prompts/formats.md: each starts with "## N. Name", followed by its instructions.
export function loadFormats() {
  const list = stripComments(fs.readFileSync(FORMATS_FILE, 'utf8'))
    .split(/^## /m)
    .slice(1)
    .map((blk) => {
      const lines = blk.split('\n');
      return { name: lines[0].replace(/^\d+\.\s*/, '').trim(), text: lines.slice(1).join('\n').trim() };
    })
    .filter((f) => f.text);
  if (!list.length) throw new Error('prompts/formats.md has no "## " layouts');
  return list;
}

export function loadRules() {
  const text = stripComments(fs.readFileSync(RULES_FILE, 'utf8')).trim();
  const formats = loadFormats();
  // Rules, contract and layouts are all in the hash, so editing any of them
  // re-runs the rewrite for saved posts that are not on the job board yet.
  const hash = crypto.createHash('sha256').update(text + BASE_CONTRACT + JSON.stringify(formats)).digest('hex').slice(0, 12);
  return { text, formats, hash };
}

// Safety net: turn any HTML/markdown the model slips in into clean plain text with line breaks.
export function cleanText(t) {
  return String(t ?? '')
    .replace(/\r/g, '')
    .replace(/\\n/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*\*\s+/gm, '• ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error('Groq reply was not JSON');
}

export async function rewrite({ title, description }, { apiKey, model, rules, format }) {
  const body = {
    model,
    temperature: 0.6,
    messages: [
      { role: 'system', content: `${rules.text}\n\nLayout for the description ("${format.name}"):\n${format.text}\n${BASE_CONTRACT}` },
      { role: 'user', content: JSON.stringify({ title, description }) },
    ],
    response_format: { type: 'json_object' },
    // Short thinking keeps each call well under the free plan's 8K tokens/minute.
    reasoning_effort: 'low',
  };

  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get('retry-after')) || attempt * 10;
      await new Promise((r) => setTimeout(r, Math.min(wait, 60) * 1000));
      continue;
    }
    if (res.status === 400 && (body.response_format || body.reasoning_effort)) {
      // Model without JSON mode / reasoning control: fall back to plain text + parse
      delete body.response_format;
      delete body.reasoning_effort;
      continue;
    }
    if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const out = parseJson(data.choices?.[0]?.message?.content ?? '');
    if (!out.title || !out.description) throw new Error('Groq reply missing title/description');
    return {
      title: String(out.title).trim(),
      description: cleanText(out.description),
      duration: DURATIONS.includes(out.duration) ? out.duration : null,
      clientLocation: String(out.client_location ?? '').trim(),
      format: format.name,
      model,
      rulesHash: rules.hash,
      at: new Date().toISOString(),
    };
  }
  throw new Error('Groq: gave up after retries');
}
