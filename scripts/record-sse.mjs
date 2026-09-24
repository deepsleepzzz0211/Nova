// Record real SSE bytes from the weixin gateway into fixtures (manual run,
// key via env). Output is the raw event-stream body — no credentials inside.
// Usage: WEIXIN_API_KEY=... node scripts/record-sse.mjs
import * as fs from 'node:fs';
import * as path from 'node:path';

const KEY = process.env.WEIXIN_API_KEY;
if (!KEY) { console.error('WEIXIN_API_KEY not set'); process.exit(1); }
const BASE = 'https://chatapi.weixin.qq.com/openai/v1';
const MODEL = 'Deepseek-v4-flash';
const OUT_DIR = path.resolve('tests/e2e/fixtures/recorded');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function record(name, body) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, stream: true, stream_usage: true, ...body }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) { console.error(`${name}: http ${res.status}`); process.exit(1); }
  const chunks = [];
  for await (const c of res.body) chunks.push(Buffer.from(c));
  const raw = Buffer.concat(chunks).toString('utf-8');
  const lines = raw.split('\n').filter((l) => l.startsWith('data: '));
  if (lines.at(-1) !== 'data: [DONE]') {
    console.error(`${name}: stream did not end with [DONE] — refusing to record`);
    process.exit(1);
  }
  const file = path.join(OUT_DIR, `${name}.sse`);
  fs.writeFileSync(file, raw.replace(/\r\n/g, '\n'));
  console.log(`recorded ${name}: ${lines.length} events -> ${path.relative(process.cwd(), file)}`);
}

await record('weixin-text', {
  messages: [{ role: 'user', content: 'Reply with exactly: RECORDED-TEXT-OK' }],
  max_tokens: 64,
});

await record('weixin-toolcall', {
  messages: [{ role: 'user', content: 'Use the run_bash tool to execute exactly: echo recorded-fixture. Then say DONE.' }],
  tools: [{
    type: 'function',
    function: {
      name: 'run_bash',
      description: 'Run a shell command and return stdout.',
      parameters: { type: 'object', properties: { command: { type: 'string', description: 'shell command' } }, required: ['command'] },
    },
  }],
  max_tokens: 256,
});
