// OpenAI-compatible SSE shape validator for the weixin gateway contract.
// Shared by the recorded-fixture tests and the daily live probe. The rules
// below encode what the REAL recordings look like (scripts/record-sse.mjs) —
// a hand-written mock never produced split tool_call arguments or a null
// prompt_tokens_details, which is exactly why this file exists.

/** Split a raw event-stream body into parsed JSON events. */
export function parseSseEvents(raw) {
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('empty SSE body: no events');
  const events = [];
  for (const [i, line] of lines.entries()) {
    if (!line.startsWith('data: ')) {
      throw new Error(`line ${i}: expected "data: " prefix, got ${JSON.stringify(line.slice(0, 20))}`);
    }
    const payload = line.slice(6);
    if (payload === '[DONE]') return { events, doneAt: i };
    try {
      events.push(JSON.parse(payload));
    } catch {
      throw new Error(`line ${i}: data payload is not JSON: ${JSON.stringify(payload.slice(0, 40))}`);
    }
  }
  throw new Error('stream did not end with data: [DONE]');
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Assert the recorded/live shape contract; throws with the violated rule. */
export function assertShape(raw) {
  const { events } = parseSseEvents(raw);
  if (events.length === 0) throw new Error('no data events before [DONE]');
  for (const [i, e] of events.entries()) {
    if (e.object !== 'chat.completion.chunk') {
      throw new Error(`event ${i}: object is ${JSON.stringify(e.object)}, expected chat.completion.chunk`);
    }
    if (!Array.isArray(e.choices)) throw new Error(`event ${i}: choices missing or not an array`);
  }
  const first = events[0];
  const role = first.choices[0]?.delta?.role;
  if (role !== 'assistant') {
    throw new Error(`first event delta.role is ${JSON.stringify(role)}, expected "assistant"`);
  }
  const withUsage = events.filter((e) => e.usage !== undefined && e.usage !== null);
  if (withUsage.length !== 1) {
    throw new Error(`expected exactly 1 usage event, got ${withUsage.length}`);
  }
  const u = withUsage[0].usage;
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (!isNum(u[field])) throw new Error(`usage.${field} is not a finite number: ${JSON.stringify(u[field])}`);
  }
  if (u.total_tokens < u.prompt_tokens) {
    throw new Error(`usage.total_tokens (${u.total_tokens}) < prompt_tokens (${u.prompt_tokens})`);
  }
  // Real gateways emit explicit "tool_calls": null on non-tool deltas —
  // only array-valued tool_calls count (found by the fixture itself).
  const toolEvents = events.filter((e) =>
    e.choices.some((c) => Array.isArray(c.delta?.tool_calls) && c.delta.tool_calls.length > 0),
  );
  if (toolEvents.length > 0) {
    const head = toolEvents[0].choices.find((c) => Array.isArray(c.delta?.tool_calls))?.delta.tool_calls[0];
    if (head === undefined) throw new Error('tool event selection lost its head delta');
    if (typeof head.index !== 'number') throw new Error('first tool_call delta lacks numeric index');
    if (typeof head.id !== 'string' || head.id.length === 0) {
      throw new Error('first tool_call delta carries no id — arguments would be unroutable');
    }
  }
  // Cache fields are OPTIONAL (short prompts never cache) but when present
  // they must be numbers — a rename to e.g. cache_tokens trips this.
  for (const f of ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']) {
    if (u[f] !== undefined && !isNum(u[f])) throw new Error(`usage.${f} present but not a number`);
  }
  if (u.prompt_tokens_details !== null && u.prompt_tokens_details !== undefined) {
    if (typeof u.prompt_tokens_details !== 'object') {
      throw new Error('usage.prompt_tokens_details is neither null nor an object');
    }
  }
  return { events, usage: u, hasToolCalls: toolEvents.length > 0 };
}
