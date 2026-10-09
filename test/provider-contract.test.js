import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, validateProviderOptions } from '../src/providers.js';

const messages = [{ role: 'system', content: 'First instruction.' }, { role: 'user', content: 'Inspect.' }];
const tool = { name: 'read_file', description: 'Read a fixture.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } };
const schema = { name: 'probe', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } };
const compatible = (message = { role: 'assistant', content: 'Done.' }, extra = {}) => ({ choices: [{ finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop', message }], usage: { prompt_tokens: 3, completion_tokens: 2 }, ...extra });
const anthropic = (content = [{ type: 'text', text: 'Done.' }], extra = {}) => ({ type: 'message', role: 'assistant', content, stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 3, output_tokens: 2 }, ...extra });
const env = kind => ({ NEXUS_PROVIDER: kind, NEXUS_MODEL: 'fixture', NEXUS_API_KEY: 'private-fixture-key' });
const chatCall = (id = 'call-1', args = '{"path":"README.md"}') => ({ id, type: 'function', function: { name: 'read_file', arguments: args } });

test('provider limits are explicit, bounded, and reusable by configuration validation', () => {
  assert.deepEqual(validateProviderOptions(), { timeoutMs: 120000, maxOutputTokens: 4096, tokenLimitField: 'max_tokens' });
  for (const timeoutMs of [0, 99, 120001, 100.5, '100', NaN, Infinity]) assert.throws(() => createProvider(env('compatible'), { timeoutMs }), /timeoutMs/);
  for (const maxOutputTokens of [0, 32769, 2.5, '2', NaN, Infinity]) assert.throws(() => createProvider(env('compatible'), { maxOutputTokens }), /maxOutputTokens/);
  assert.throws(() => createProvider(env('compatible'), { tokenLimitField: 'unsupported' }), /tokenLimitField/);
  assert.throws(() => validateProviderOptions(null), /object/);
});

test('compatible adapter sends selected token cap and structured-output schema without mixing authentication', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer private-fixture-key');
    assert.equal(options.headers['x-api-key'], undefined);
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.max_completion_tokens, 321);
    assert.equal(body.max_tokens, undefined);
    assert.deepEqual(body.tools, [{ type: 'function', function: tool }]);
    assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { ...schema, strict: true } });
    return Response.json(compatible({ role: 'assistant', content: '{"ok":true}' }));
  });
  const provider = createProvider(env('compatible'), { maxOutputTokens: 321, tokenLimitField: 'max_completion_tokens' });
  assert.equal(provider.endpoint, 'https://api.openai.com/v1');
  const result = await provider.complete(messages, [tool], { responseSchema: schema });
  assert.deepEqual(result.usage, { input: 3, output: 2 });
  assert.equal(result.usageReported, true);
  assert.equal(result.finishReason, 'stop');
});

test('Anthropic preserves reasoning blocks, combines system messages, and groups parallel tool results', async t => {
  const raw = [{ type: 'thinking', thinking: 'Reasoning.', signature: 'signed' }, { type: 'redacted_thinking', data: 'opaque' }, { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'a' } }, { type: 'tool_use', id: 'call-2', name: 'read_file', input: { path: 'b' } }];
  let request = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(options.headers['x-api-key'], 'private-fixture-key');
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(options.body);
    assert.equal(body.system, 'First instruction.\n\nSecond instruction.');
    assert.equal(body.max_tokens, 512);
    assert.equal(body.max_completion_tokens, undefined);
    assert.deepEqual(body.tools, [{ name: tool.name, description: tool.description, input_schema: tool.parameters }]);
    if (request++ === 0) return Response.json(anthropic(raw));
    assert.deepEqual(body.messages.at(-2), { role: 'assistant', content: raw });
    assert.deepEqual(body.messages.at(-1), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'A' }, { type: 'tool_result', tool_use_id: 'call-2', content: 'B' }] });
    assert.deepEqual(body.output_config, { format: { type: 'json_schema', schema: schema.schema } });
    return Response.json(anthropic([{ type: 'text', text: '{"ok":true}' }]));
  });
  const provider = createProvider(env('anthropic'), { maxOutputTokens: 512, tokenLimitField: 'max_completion_tokens' });
  const history = [...messages, { role: 'system', content: 'Second instruction.' }];
  const first = await provider.complete(history, [tool]);
  assert.deepEqual(first.raw, raw);
  assert.equal(first.finishReason, 'tool_use');
  assert.equal(first.calls.length, 2);
  const final = await provider.complete([...history, { role: 'assistant', content: first.text, calls: first.calls, raw: first.raw }, { role: 'tool', id: 'call-1', content: 'A' }, { role: 'tool', id: 'call-2', content: 'B' }], [tool], { responseSchema: schema });
  assert.equal(final.finishReason, 'end_turn');
  assert.equal(final.usageReported, true);
});

test('Anthropic does not turn the initial user message into system instructions', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.system, undefined);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'Hello.' }]);
    return Response.json(anthropic());
  });
  await createProvider(env('anthropic')).complete([{ role: 'user', content: 'Hello.' }]);
});

test('adapters reject malformed, blank, refused, truncated, or unknown completions', async t => {
  const cases = [
    ['compatible', null, 'invalid_response'],
    ['compatible', { choices: [] }, 'invalid_response'],
    ['compatible', { choices: [compatible().choices[0], compatible().choices[0]] }, 'invalid_response'],
    ['compatible', compatible({ role: 'user', content: 'Wrong role.' }), 'invalid_response'],
    ['compatible', compatible({ content: '   ' }), 'invalid_response'],
    ['compatible', compatible({ content: [{ type: 'text', text: 'unsupported' }] }), 'invalid_response'],
    ['compatible', compatible({ content: 'Refused.', refusal: 'Refusal reason.' }), 'incomplete_response'],
    ['compatible', { choices: [{ finish_reason: 'length', message: { content: 'Partial' } }] }, 'incomplete_response'],
    ['compatible', { choices: [{ finish_reason: 'content_filter', message: { content: 'Partial' } }] }, 'incomplete_response'],
    ['compatible', { choices: [{ finish_reason: 'surprise', message: { content: 'Text' } }] }, 'incomplete_response'],
    ['compatible', { choices: [{ finish_reason: null, message: { content: 'Streaming fragment' } }] }, 'incomplete_response'],
    ['compatible', { choices: [{ finish_reason: 'tool_calls', message: { content: 'No calls' } }] }, 'invalid_response'],
    ['anthropic', { error: { type: 'error' } }, 'invalid_response'],
    ['anthropic', anthropic([], { role: 'user' }), 'invalid_response'],
    ['anthropic', anthropic([{ type: 'text', text: ' ' }]), 'invalid_response'],
    ['anthropic', anthropic([{ type: 'thinking', thinking: 'Missing signature' }]), 'invalid_response'],
    ['anthropic', anthropic([{ type: 'server_tool_use', id: 'call-1', name: 'unknown', input: {} }]), 'invalid_response'],
    ...['max_tokens', 'pause_turn', 'refusal', 'model_context_window_exceeded', 'surprise', null].map(stop_reason => ['anthropic', anthropic(undefined, { stop_reason }), 'incomplete_response']),
    ['anthropic', anthropic(undefined, { stop_reason: 'tool_use' }), 'invalid_response'],
  ];
  for (const [kind, payload, code] of cases) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
    await assert.rejects(createProvider(env(kind)).complete(messages), { code });
    t.mock.restoreAll();
  }
});

test('all tool calls are validated before either adapter returns an executable batch', async t => {
  const invalidCalls = [
    [chatCall(), chatCall()],
    [chatCall(), chatCall('call-2', 'not JSON')],
    [chatCall('call-1', 'null')],
    [chatCall('call-1', '[]')],
    [chatCall('call-1', '"text"')],
    [{ ...chatCall(), id: '' }],
    [{ ...chatCall(), id: 'x'.repeat(257) }],
    [{ ...chatCall(), function: { name: 'bad name', arguments: '{}' } }],
    [{ ...chatCall(), type: 'custom' }],
    Array.from({ length: 33 }, (_, i) => chatCall(`call-${i}`)),
  ];
  for (const calls of invalidCalls) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(compatible({ content: null, tool_calls: calls })));
    await assert.rejects(createProvider(env('compatible')).complete(messages), { code: 'invalid_response' });
    t.mock.restoreAll();
  }
  for (const input of [null, [], 'text', 1]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(anthropic([{ type: 'tool_use', id: 'valid', name: 'read_file', input: {} }, { type: 'tool_use', id: 'bad', name: 'read_file', input }])));
    await assert.rejects(createProvider(env('anthropic')).complete(messages), { code: 'invalid_response' });
    t.mock.restoreAll();
  }
});

test('legacy servers may omit finish reasons but must still return valid completed content', async t => {
  for (const [kind, payload, finishReason] of [
    ['compatible', { choices: [{ message: { content: 'Legacy text.' } }] }, 'stop'],
    ['compatible', { choices: [{ message: { tool_calls: [chatCall()] } }] }, 'tool_calls'],
    ['anthropic', { content: [{ type: 'text', text: 'Legacy text.' }] }, 'end_turn'],
    ['anthropic', { content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: {} }] }, 'tool_use'],
  ]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
    const result = await createProvider(env(kind)).complete(messages);
    assert.equal(result.finishReason, finishReason);
    assert.deepEqual(result.usage, { input: 0, output: 0 });
    assert.equal(result.usageReported, false);
    t.mock.restoreAll();
  }
});

test('usage is distinguishable from zero, and malformed token counts never reach cost tracking', async t => {
  for (const kind of ['compatible', 'anthropic']) {
    const build = kind === 'compatible' ? compatible : anthropic;
    const keys = kind === 'compatible' ? ['prompt_tokens', 'completion_tokens'] : ['input_tokens', 'output_tokens'];
    for (const usage of [undefined, null, {}, { [keys[0]]: 3 }]) {
      t.mock.method(globalThis, 'fetch', async () => Response.json(build(undefined, { usage })));
      const result = await createProvider(env(kind)).complete(messages);
      assert.equal(result.usageReported, false);
      assert.deepEqual(result.usage, { input: usage?.[keys[0]] || 0, output: 0 });
      t.mock.restoreAll();
    }
    for (const count of [-1, 0.5, '3', null, 1e100]) {
      t.mock.method(globalThis, 'fetch', async () => Response.json(build(undefined, { usage: { [keys[0]]: count, [keys[1]]: 1 } })));
      await assert.rejects(createProvider(env(kind)).complete(messages), { code: 'invalid_response' });
      t.mock.restoreAll();
    }
    t.mock.method(globalThis, 'fetch', async () => Response.json(build(undefined, { usage: { [keys[0]]: 0, [keys[1]]: 0 } })));
    assert.equal((await createProvider(env(kind)).complete(messages)).usageReported, true);
    t.mock.restoreAll();
  }
});

test('provider HTTP categories are stable and never include remote bodies or credentials', async t => {
  const cases = [[401, null, 'authentication'], [403, null, 'authentication'], [429, null, 'rate_limit'], [429, 'insufficient_quota', 'quota'], [400, 'context_length_exceeded', 'context_limit'], [413, null, 'context_limit'], [404, null, 'model_not_found'], [400, 'model_not_found', 'model_not_found'], [408, null, 'timeout'], [504, null, 'timeout'], [500, null, 'http_error']];
  for (const [status, remoteCode, code] of cases) {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ error: { code: remoteCode, message: 'private-fixture-key very private content' } }, { status }); });
    await assert.rejects(createProvider(env('compatible')).complete(messages), error => {
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /private-fixture-key|very private content/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(requests, 1, 'the adapter never silently retries');
    t.mock.restoreAll();
  }
});

test('invalid JSON, oversized responses, and network failures are sanitized', async t => {
  for (const [reply, code] of [
    [() => new Response('private-fixture-key invalid JSON'), 'invalid_response'],
    [() => new Response(null), 'invalid_response'],
    [() => new Response('x'.repeat(4 * 1024 * 1024 + 1)), 'invalid_response'],
    [() => { throw new TypeError('private-fixture-key connection failed'); }, 'network'],
  ]) {
    t.mock.method(globalThis, 'fetch', async () => reply());
    await assert.rejects(createProvider(env('compatible')).complete(messages), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /private-fixture-key/);
      return true;
    });
    t.mock.restoreAll();
  }
});

test('pre-cancellation prevents sending and never exposes caller abort reasons', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Cancelled call must not send.'));
  await assert.rejects(createProvider(env('compatible')).complete(messages, [], { signal: AbortSignal.abort(new Error('private-fixture-key')) }), error => error.code === 'cancelled' && !error.message.includes('private-fixture-key'));
});

test('timeout and caller cancellation abort a pending request with distinct categories', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('Fixture did not abort.')), 2000);
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
  }));
  await assert.rejects(createProvider(env('compatible'), { timeoutMs: 100 }).complete(messages), { code: 'timeout' });
  const controller = new AbortController();
  const response = createProvider(env('anthropic')).complete(messages, [], { signal: controller.signal });
  controller.abort(new Error('private-fixture-key'));
  await assert.rejects(response, error => error.code === 'cancelled' && !error.message.includes('private-fixture-key'));
});

test('structured-output options must be valid before sending', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Invalid schema must not send.'));
  for (const responseSchema of [null, [], {}, { name: 'bad name', schema: {} }, { name: 'x', schema: [] }, { name: 'x'.repeat(65), schema: {} }]) await assert.rejects(createProvider(env('compatible')).complete(messages, [], { responseSchema }), /responseSchema/);
});

test('ambient cloud credentials are only used for their own official provider origin', async t => {
  for (const kind of ['compatible', 'anthropic']) {
    const ambient = { NEXUS_PROVIDER: kind, NEXUS_MODEL: 'fixture', OPENAI_API_KEY: 'ambient-openai', ANTHROPIC_API_KEY: 'ambient-anthropic' };
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      assert.equal(options.headers.authorization, undefined);
      assert.equal(options.headers['x-api-key'], undefined);
      return Response.json(kind === 'compatible' ? compatible() : anthropic());
    });
    await createProvider({ ...ambient, NEXUS_BASE_URL: 'http://127.0.0.1:11434/v1' }).complete(messages);
    assert.throws(() => createProvider({ ...ambient, NEXUS_BASE_URL: 'https://custom.example/v1' }), /NEXUS_API_KEY/);
    const misleading = kind === 'compatible' ? 'https://api.openai.com.evil.example/v1' : 'https://api.anthropic.com.evil.example/v1';
    assert.throws(() => createProvider({ ...ambient, NEXUS_BASE_URL: misleading }), /NEXUS_API_KEY/);
    t.mock.restoreAll();
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      assert.equal(options.headers.authorization, kind === 'compatible' ? 'Bearer ambient-openai' : undefined);
      assert.equal(options.headers['x-api-key'], kind === 'anthropic' ? 'ambient-anthropic' : undefined);
      return Response.json(kind === 'compatible' ? compatible() : anthropic());
    });
    await createProvider(ambient).complete(messages);
    t.mock.restoreAll();
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      assert.equal(options.headers.authorization, kind === 'compatible' ? 'Bearer explicit-key' : undefined);
      assert.equal(options.headers['x-api-key'], kind === 'anthropic' ? 'explicit-key' : undefined);
      return Response.json(kind === 'compatible' ? compatible() : anthropic());
    });
    await createProvider({ ...ambient, NEXUS_API_KEY: 'explicit-key', NEXUS_BASE_URL: 'https://custom.example/v1' }).complete(messages);
    t.mock.restoreAll();
  }
});
