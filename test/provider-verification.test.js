import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, saveConfig } from '../src/config.js';
import { listState, readState, writeState } from '../src/state.js';
import { probeProvider, verifyProvider, verifyEnvironmentProvider, providerMatrix, providerFingerprint } from '../src/provider-verification.js';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-provider-verification-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const response = (text = '', calls = [], usageReported = true) => ({ text, calls, usageReported, usage: { input: 10, output: 5 } });
const toolCalls = ['alpha', 'beta'].map(label => ({ id: `read-${label}`, name: 'lookup_probe_value', args: { label } }));
function syntheticReply(messages, tools, options = {}) {
  if (options.responseSchema) return response('{"answer":42,"ok":true}');
  if (tools.length) {
    const results = messages.filter(message => message.role === 'tool');
    return results.length ? response(results.map(result => JSON.parse(result.content).value).join(' ')) : response('', toolCalls);
  }
  const token = messages.at(-1).content.match(/exactly (nexus-[a-f0-9]+)/)?.[1];
  assert.ok(token, 'fixture only accepts the synthetic marker prompt');
  return response(token);
}

function stub(handler = syntheticReply) {
  const requests = [];
  return {
    name: 'compatible', model: 'synthetic-model', endpoint: 'http://127.0.0.1:1/v1', rates: { input: 2, output: 6 }, requests,
    async complete(messages, tools = [], options = {}) {
      requests.push({ messages: structuredClone(messages), tools: structuredClone(tools), responseSchema: options.responseSchema });
      return handler(messages, tools, options, requests.length);
    },
  };
}

async function endpoint(t, { status = 200 } = {}) {
  const requests = [], errors = [];
  const server = createServer((request, res) => {
    (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ body, authorization: request.headers.authorization });
      res.writeHead(status, { 'content-type': 'application/json' });
      if (status !== 200) { res.end(JSON.stringify({ error: { message: 'Untrusted response body', code: 'invalid_api_key' } })); return; }
      const reply = syntheticReply(body.messages, body.tools || [], { responseSchema: body.response_format });
      res.end(JSON.stringify({
        choices: [{ finish_reason: reply.calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: reply.text || null,
          ...(reply.calls.length ? { tool_calls: reply.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    })().catch(error => { errors.push(error); res.writeHead(500).end('{}'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.deepEqual(errors, []);
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

async function configure(root, baseUrl, overrides = {}) {
  const profile = { kind: 'compatible', model: 'synthetic-model', baseUrl, inputCostPerMillion: 2, outputCostPerMillion: 6, ...overrides };
  const config = { ...structuredClone(defaultConfig), providers: { fixture: profile }, routes: { default: 'fixture' } };
  await saveConfig(root, config);
  return { config, profile };
}

test('provider verification sends only synthetic prompts and tool values and saves scoped evidence', async t => {
  const root = await workspace(t), http = await endpoint(t);
  const privateText = 'PRIVATE_WORKSPACE_DATA_DO_NOT_SEND_928413';
  const key = 'synthetic-test-credential-348574';
  await writeFile(path.join(root, 'README.md'), privateText);
  await writeState(root, 'memory', 'private-note.json', { scope: 'project', text: privateText });
  const { profile } = await configure(root, http.baseUrl, { keyEnv: 'NEXUS_TEST_API_KEY' });
  const result = await verifyProvider(root, 'fixture', { env: { NEXUS_TEST_API_KEY: key } });
  assert.equal(result.verified, true);
  assert.equal(result.syntheticOnly, true);
  assert.equal(result.fingerprint, providerFingerprint(profile));
  assert.equal(http.requests.length, 4);
  assert.equal(result.requests, 4);
  assert.equal(result.checks.find(check => check.name === 'multiple-tool-calls').status, 'observed');
  assert.equal(result.usage.estimatedCost, (40 * 2 + 20 * 6) / 1_000_000);
  const bodies = JSON.stringify(http.requests.map(request => request.body));
  assert.ok(!bodies.includes(privateText));
  assert.ok(!bodies.includes(root));
  assert.ok(!bodies.includes(key));
  assert.ok(http.requests.every(request => request.authorization === `Bearer ${key}`));
  const firstToolRequest = http.requests.find(request => request.body.tools?.length).body;
  assert.deepEqual(firstToolRequest.tools.map(tool => tool.function.name), ['lookup_probe_value']);
  assert.ok(!JSON.stringify(firstToolRequest).includes('alpha-'), 'lookup values must not be provided before the tool result');
  const receipt = await readState(root, 'provider-checks', 'fixture.json');
  assert.deepEqual(receipt, result);
  assert.ok(!JSON.stringify(receipt).includes(key));
  assert.ok(!JSON.stringify(receipt).includes(privateText));
});

test('tool verification rejects guessed values even if they match the marker-derived values', async () => {
  let nonce;
  const provider = stub((messages, tools, options) => {
    if (!tools.length && !options.responseSchema) nonce = messages.at(-1).content.match(/nexus-([a-f0-9]+)/)[1];
    return tools.length ? response(`alpha-${nonce} beta-${nonce}`) : syntheticReply(messages, tools, options);
  });
  const result = await probeProvider(provider);
  assert.equal(result.verified, false);
  assert.equal(result.checks.find(check => check.name === 'tool-round-trip').status, 'failed');
  assert.match(result.checks.find(check => check.name === 'tool-round-trip').error.message, /observed tool values/);
});

test('tool verification rejects invented results after reading the actual tool values', async () => {
  const result = await probeProvider(stub((messages, tools, options) => tools.length && messages.some(message => message.role === 'tool')
    ? response('alpha-invented beta-invented') : syntheticReply(messages, tools, options)));
  assert.equal(result.verified, false);
  assert.equal(result.checks.find(check => check.name === 'tool-round-trip').status, 'failed');
});

for (const malformed of ['not JSON', '{"answer":"42","ok":true}', '{"answer":42,"ok":false}', '{"answer":42,"ok":true,"extra":1}']) {
  test(`structured verification rejects ${malformed}`, async () => {
    const result = await probeProvider(stub((messages, tools, options) => options.responseSchema ? response(malformed) : syntheticReply(messages, tools, options)));
    assert.equal(result.verified, false);
    assert.equal(result.checks.find(check => check.name === 'structured-output').status, 'failed');
  });
}

test('tool conversations stop at six requests without retrying an endless tool response', async () => {
  const provider = stub((messages, tools, options) => tools.length ? response('', toolCalls) : syntheticReply(messages, tools, options));
  const result = await probeProvider(provider);
  assert.equal(result.verified, false);
  assert.equal(result.requests, 6);
  assert.equal(provider.requests.length, 6);
  assert.equal(result.checks.find(check => check.name === 'tool-round-trip').requests, 4);
  assert.equal(result.checks.find(check => check.name === 'structured-output').status, 'passed');
});

test('authentication failure stops the real HTTP probe and persists the failure without retries', async t => {
  const root = await workspace(t), http = await endpoint(t, { status: 401 });
  await configure(root, http.baseUrl);
  const result = await verifyProvider(root, 'fixture', { env: {} });
  assert.equal(result.verified, false);
  assert.equal(http.requests.length, 1);
  assert.equal(result.requests, 1);
  assert.equal(result.checks[0].error.code, 'authentication');
  assert.equal(result.checks[0].error.httpStatus, 401);
  assert.equal(result.checks.find(check => check.name === 'tool-round-trip').status, 'not-run');
  assert.equal(result.checks.find(check => check.name === 'structured-output').status, 'not-run');
  assert.equal(result.usage.estimatedCost, null);
  assert.deepEqual(await readState(root, 'provider-checks', 'fixture.json'), result);
});

test('unreported token usage never yields a partial or zero estimated cost', async () => {
  const result = await probeProvider(stub((messages, tools, options, count) => ({ ...syntheticReply(messages, tools, options), usageReported: count !== 2 })));
  assert.equal(result.verified, true);
  assert.equal(result.usage.reported, false);
  assert.equal(result.usage.estimatedCost, null);
});

test('missing configured credentials are recorded as a configuration failure without HTTP calls', async t => {
  const root = await workspace(t), http = await endpoint(t);
  await configure(root, http.baseUrl, { keyEnv: 'NEXUS_TEST_API_KEY' });
  const result = await verifyProvider(root, 'fixture', { env: {} });
  assert.equal(result.verified, false);
  assert.equal(result.requests, 0);
  assert.equal(result.checks[0].name, 'configuration');
  assert.equal(result.checks[0].error.code, 'configuration');
  assert.equal(http.requests.length, 0);
  assert.deepEqual(await readState(root, 'provider-checks', 'fixture.json'), result);
});

test('matrix reads evidence without network calls and marks model, endpoint and settings edits stale', async t => {
  const root = await workspace(t), http = await endpoint(t);
  const { config } = await configure(root, http.baseUrl);
  await verifyProvider(root, 'fixture', { env: {} });
  const fetchMock = t.mock.method(globalThis, 'fetch', () => { throw new Error('The matrix must not use the network.'); });
  assert.equal((await providerMatrix(root, { env: {} })).profiles[0].evidence, 'live-check-passed');
  for (const change of [
    { model: 'another-model' }, { baseUrl: `${http.baseUrl}/changed` }, { timeoutMs: 1000 },
    { maxOutputTokens: 2048 }, { tokenLimitField: 'max_completion_tokens' }, { inputCostPerMillion: 3 },
  ]) {
    const updated = structuredClone(config);
    Object.assign(updated.providers.fixture, change);
    await saveConfig(root, updated);
    const matrix = await providerMatrix(root, { env: {} });
    assert.equal(matrix.profiles[0].evidence, 'stale', JSON.stringify(change));
    assert.deepEqual(matrix.profiles[0].checks, []);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(http.requests.length, 4);
});

test('matrix distinguishes failed, absent and outdated evidence and reports credential availability without its value', async t => {
  const root = await workspace(t);
  const { config, profile } = await configure(root, 'http://127.0.0.1:1/v1', { keyEnv: 'NEXUS_TEST_API_KEY' });
  config.providers.unchecked = { ...profile };
  config.providers.old = { ...profile };
  config.providers.incomplete = { ...profile };
  await saveConfig(root, config);
  const failed = await verifyProvider(root, 'fixture', { env: {} });
  await writeState(root, 'provider-checks', 'old.json', { suite: 'outdated-suite', fingerprint: providerFingerprint(profile), verified: true });
  await writeState(root, 'provider-checks', 'incomplete.json', { suite: failed.suite, fingerprint: providerFingerprint(profile), verified: true, checks: [{ name: 'text', status: 'passed' }] });
  const key = 'synthetic-matrix-key-028534';
  const matrix = await providerMatrix(root, { env: { NEXUS_TEST_API_KEY: key } });
  assert.deepEqual(matrix.profiles.map(item => [item.name, item.evidence]), [['fixture', 'live-check-failed'], ['unchecked', 'not-tested'], ['old', 'stale'], ['incomplete', 'live-check-failed']]);
  assert.ok(matrix.profiles.every(item => item.credentialAvailable === true));
  assert.ok(!JSON.stringify(matrix).includes(key));
});

test('environment verification requires an explicit adapter, model and endpoint', async t => {
  const root = await workspace(t);
  const selected = { NEXUS_PROVIDER: 'compatible', NEXUS_MODEL: 'synthetic-model', NEXUS_BASE_URL: 'http://127.0.0.1:1/v1' };
  const fetchMock = t.mock.method(globalThis, 'fetch', () => { throw new Error('Incomplete environment must not use the network.'); });
  for (const field of Object.keys(selected)) {
    const env = { ...selected };
    delete env[field];
    await assert.rejects(verifyEnvironmentProvider(root, { env }), /explicitly/);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(await listState(root, 'provider-checks'), []);
});

test('environment verification saves only its result and does not change configured routing', async t => {
  const root = await workspace(t), http = await endpoint(t);
  await configure(root, 'http://127.0.0.1:1/v1');
  const before = await readFile(path.join(root, '.nexus', 'config', 'project.json'), 'utf8');
  const key = 'synthetic-environment-key-54298', privateValue = 'private-unrelated-env-secret-57248';
  const result = await verifyEnvironmentProvider(root, { env: {
    NEXUS_PROVIDER: 'compatible', NEXUS_MODEL: 'environment-model', NEXUS_BASE_URL: http.baseUrl,
    NEXUS_API_KEY: key, NEXUS_CHECK_MAX_TOKENS: '128', NEXUS_CHECK_TOKEN_FIELD: 'max_completion_tokens',
    NEXUS_UNRELATED_SECRET: privateValue,
  } });
  assert.equal(result.verified, true);
  assert.equal(result.model, 'environment-model');
  assert.equal(result.endpoint, http.baseUrl);
  assert.ok(http.requests.every(request => request.body.max_completion_tokens === 128 && request.body.model === 'environment-model'));
  assert.ok(http.requests.every(request => request.authorization === `Bearer ${key}`));
  const receipts = await listState(root, 'provider-checks');
  assert.equal(receipts.length, 1);
  assert.match(receipts[0], /^environment-[a-f0-9]{16}\.json$/);
  assert.equal(result.receipt, `.nexus/provider-checks/${receipts[0]}`);
  const saved = JSON.stringify(await readState(root, 'provider-checks', receipts[0]));
  assert.ok(!saved.includes(key));
  assert.ok(!saved.includes(privateValue));
  assert.ok(!JSON.stringify(http.requests).includes(privateValue));
  assert.equal(await readFile(path.join(root, '.nexus', 'config', 'project.json'), 'utf8'), before);
});

test('probe errors redact provider credentials before they reach receipts', async () => {
  const key = 'synthetic-sensitive-provider-key-51924';
  const provider = stub(() => { throw Object.assign(new Error(`Credential rejected: ${key}`), { code: 'authentication' }); });
  provider.sensitiveValues = [key];
  const result = await probeProvider(provider);
  assert.equal(result.verified, false);
  assert.ok(!JSON.stringify(result).includes(key));
  assert.match(result.checks[0].error.message, /\[REDACTED\]/);
});

test('scripted demo cannot produce model compatibility evidence', async () => {
  await assert.rejects(probeProvider({ name: 'demo' }), /not a model compatibility check/);
});
