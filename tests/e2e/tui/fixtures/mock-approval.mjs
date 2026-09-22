// Approval-flow fixture: OpenAI-compatible SSE mock whose turn 1 requests a
// bash tool call (needs approval) and whose turn 2 answers only after a long
// delay — so "dialog closed" is only provable when the decision itself closes
// it, not when the turn happens to end. Safe to delete with the fixture dir.
import * as http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 8793);
const TURN2_DELAY_MS = Number(process.env.MOCK_TURN2_DELAY ?? 4000);

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
function baseChunk(model) {
  return { id: 'chatcmpl-approval', object: 'chat.completion.chunk', created: 0, model };
}
function streamTurn(res, model, chunks, finishReason, usage) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  for (const c of chunks) sse(res, { ...baseChunk(model), choices: [{ index: 0, delta: c, finish_reason: null }] });
  sse(res, { ...baseChunk(model), choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
  if (usage) sse(res, { ...baseChunk(model), choices: [], usage });
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    const hasToolResult = parsed.messages.some((m) => m.role === 'tool');
    if (!hasToolResult) {
      streamTurn(res, parsed.model, [
        { content: 'Running echo now.' },
        { tool_calls: [{ index: 0, id: 'call_ap1', type: 'function', function: { name: 'bash', arguments: '{"command":"echo approval-fixture-ok"}' } }] },
      ], 'tool_calls', { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 });
      return;
    }
    setTimeout(() => {
      streamTurn(res, parsed.model, [{ content: 'APPROVAL-DONE' }], 'stop', {
        prompt_tokens: 60, completion_tokens: 3, total_tokens: 63,
      });
    }, TURN2_DELAY_MS);
  });
});

server.listen(PORT, '127.0.0.1', () => console.error(`[mock-approval] on ${PORT}`));
