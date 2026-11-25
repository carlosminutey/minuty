// Quick check of the Groq rewrite with your key, rules and layouts.
//   npm run test-groq          uses layout 1
//   npm run test-groq -- 3     uses layout 3 (see prompts/formats.md)
import { rewrite, loadRules } from './groq.mjs';

const apiKey = (process.env.GROQ_API_KEY ?? '').trim();
if (!apiKey) throw new Error('Set GROQ_API_KEY in .env first');

const sample = {
  title: 'Web Application Developer Needed to Rebuild an Existing Web App',
  description:
    'An existing web application that plays an important role in our day-to-day business workflows has recently become unavailable following the passing of its original owner. We now need an experienced developer to rebuild the platform and restore its existing functionality as closely as possible.',
};
const rules = loadRules();
const n = Math.max(1, Math.min(rules.formats.length, Number(process.argv[2]) || 1));
const out = await rewrite(sample, { apiKey, model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b', rules, format: rules.formats[n - 1] });
console.log(`Layout ${n}: ${out.format}\n\n${out.title}\n\n${out.description}\n\nduration: ${out.duration} · location: ${out.clientLocation}`);
