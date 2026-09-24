// Daily live contract probe: one real request to the weixin gateway, the
// response validated against the recorded-contract rules (scripts/lib).
// Fails loudly on drift (renamed fields, broken stream, missing [DONE]).
// Needs WEIXIN_API_KEY; exits 9 with a clear message when the secret is absent.
import { assertShape } from './lib/sse-shape.mjs';

const KEY = process.env.WEIXIN_API_KEY;
if (!KEY) {
  console.error('live-probe: WEIXIN_API_KEY not set — add the repo secret (Settings → Secrets → Actions)');
  process.exit(9);
}
let res;
try {
  res = await fetch('https://chatapi.weixin.qq.com/openai/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({
    model: 'Deepseek-v4-flash',
    messages: [{ role: 'user', content: 'Reply with exactly: PROBE-OK' }],
    stream: true,
    stream_usage: true,
    max_tokens: 16,
  }),
    signal: AbortSignal.timeout(90_000),
  });
} catch (err) {
  console.error(`live-probe: NETWORK failure (not a contract verdict): ${String(err)}`);
  process.exit(2);
}
if (!res.ok) { console.error(`live-probe: gateway http ${res.status}`); process.exit(2); }
const buf = [];
try {
  for await (const c of res.body) buf.push(Buffer.from(c));
} catch (err) {
  console.error(`live-probe: NETWORK stream failure (not a contract verdict): ${String(err)}`);
  process.exit(2);
}
const raw = Buffer.concat(buf).toString('utf-8');
try {
  const { usage } = assertShape(raw);
  const cache = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  console.log(`live-probe OK: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} cache_hit=${cache}`);
} catch (err) {
  console.error(`live-probe CONTRACT DRIFT: ${String(err)}`);
  console.error('first 300 chars of the live body:', raw.slice(0, 300));
  process.exit(1);
}
