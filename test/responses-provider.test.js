import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../src/providers.js';
import { applyProviderSelection, isAgentModel } from '../src/provider-catalog.js';
import { defaultConfig, validateConfig } from '../src/config.js';

const provider = options => createProvider({ NEXUS_PROVIDER: 'responses', NEXUS_MODEL: 'codex-fixture', NEXUS_API_KEY: 'fixture-key', NEXUS_BASE_URL: 'https://api.openai.com/v1' }, options);
const answer = { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Verified fixture output.' }] }], usage: { input_tokens: 10, output_tokens: 3 } };
test('Responses provider sends a stateless tool cycle and replays validated encrypted reasoning', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(request.redirect, 'error');
    assert.equal(request.headers.authorization, 'Bearer fixture-key'); requests.push(JSON.parse(request.body));
    return Response.json(requests.length === 1 ? { status: 'completed', output: [
      { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'opaque-fixture', unexpected: 'dropped' },
      { type: 'function_call', call_id: 'call_fixture', name: 'read_file', arguments: '{"path":"notes.txt"}', status: 'completed' },
    ] } : answer);
  });
  const model = provider();
  const messages = [{ role: 'system', content: 'Review fixture.' }, { role: 'user', content: 'Read notes.' }];
  const tool = { name: 'read_file', description: 'Read text', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
  const first = await model.complete(messages, [tool]);
  assert.deepEqual(first.calls, [{ id: 'call_fixture', name: 'read_file', args: { path: 'notes.txt' } }]);
  messages.push({ role: 'assistant', content: first.text, calls: first.calls, raw: first.raw }, { role: 'tool', id: 'call_fixture', content: 'Synthetic notes.' });
  const final = await model.complete(messages, [tool]);
  assert.equal(final.text, 'Verified fixture output.'); assert.equal(final.usageReported, true);
  assert.equal(requests[0].store, false); assert.equal(requests[0].instructions, 'Review fixture.');
  assert.deepEqual(requests[0].input, [{ role: 'user', content: 'Read notes.' }]);
  assert.equal(requests[0].tools[0].strict, false); assert.equal(requests[0].tools[0].type, 'function');
  assert.equal(requests[1].input[1].encrypted_content, 'opaque-fixture');
  assert.equal(requests[1].input[1].unexpected, undefined);
  assert.deepEqual(requests[1].input.at(-1), { type: 'function_call_output', call_id: 'call_fixture', output: 'Synthetic notes.' });
});
test('Responses provider rejects incomplete, malformed, duplicate and unsupported tool results', async t => {
  let response;
  t.mock.method(globalThis, 'fetch', async () => Response.json(response));
  const call = { type: 'function_call', call_id: 'same', name: 'read_file', arguments: '{}' };
  const invalid = [ { ...answer, status: 'incomplete' }, { status: 'completed', output: [call, call] },
    { status: 'completed', output: [{ ...call, arguments: '[]' }] }, { status: 'completed', output: [{ ...call, status: 'in_progress' }] },
    { status: 'completed', output: [{ type: 'web_search_call' }] }, { status: 'completed', output: [] },
    { ...answer, output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }] } ];
  for (response of invalid) await assert.rejects(provider().complete([{ role: 'user', content: 'Fixture' }]), error => ['invalid_response', 'incomplete_response'].includes(error.code));
});
test('Codex API preset selects Responses and retains numbered API account isolation', () => {
  const config = applyProviderSelection(defaultConfig, { provider: 'codex:2', model: 'gpt-5-codex' }, { OPENAI_API_KEY2: 'fixture' });
  validateConfig(config); const selected = config.providers[config.routes.default];
  assert.equal(selected.kind, 'responses'); assert.equal(selected.keyEnv, 'OPENAI_API_KEY2');
  assert.equal(isAgentModel('gpt-5-codex', 'codex'), true); assert.equal(isAgentModel('gpt-5-codex', 'openai'), false);
});
test('Responses structured output and vision retain explicit capability checks', async t => {
  const images = [{ mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' }];
  let body;
  t.mock.method(globalThis, 'fetch', async (_url, request) => { body = JSON.parse(request.body); return Response.json(answer); });
  await assert.rejects(provider().complete([{ role: 'user', content: 'Inspect', images }]), /vision/);
  await provider({ vision: true }).complete([{ role: 'user', content: 'Inspect', images }], [], { responseSchema: { name: 'review', schema: { type: 'object', properties: {}, additionalProperties: false } } });
  assert.equal(body.input[0].content[1].type, 'input_image'); assert.match(body.input[0].content[1].image_url, /^data:image\/png;base64,/);
  assert.equal(body.text.format.type, 'json_schema'); assert.equal(body.text.format.strict, true);
});
