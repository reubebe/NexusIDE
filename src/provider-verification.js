import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadConfig, routeProvider } from './config.js';
import { createProvider } from './providers.js';
import { readState, writeState, safeName } from './state.js';
import { redactor } from './redaction.js';

export const PROVIDER_SUITE = 'nexus-provider-contract-v1';
const defaultBase = kind => kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1';
const errorCodes = new Set(['authentication', 'rate_limit', 'quota', 'model_not_found', 'context_limit', 'timeout', 'cancelled', 'invalid_response', 'incomplete_response', 'network', 'http_error']);

export function providerIdentity(profile) {
  return { kind: profile.kind, model: profile.model, baseUrl: profile.kind === 'demo' ? null : (profile.baseUrl || defaultBase(profile.kind)).replace(/\/+$/, ''),
    timeoutMs: profile.timeoutMs ?? 120000, maxOutputTokens: profile.maxOutputTokens ?? 4096,
    tokenLimitField: profile.tokenLimitField ?? 'max_tokens', keyEnv: profile.keyEnv ?? null, keySecret: profile.keySecret ?? null,
    inputCostPerMillion: profile.inputCostPerMillion ?? null, outputCostPerMillion: profile.outputCostPerMillion ?? null };
}
export const providerFingerprint = profile => createHash('sha256').update(JSON.stringify(providerIdentity(profile))).digest('hex');

// Synthetic protocol probe only: no project files, memory, shell, MCP or user
// messages enter this conversation. At most six requests, with no retries.
export async function probeProvider(provider, { signal } = {}) {
  if (provider.name === 'demo') throw new Error('The scripted demo is not a model compatibility check.');
  const nonce = randomUUID().replaceAll('-', ''), values = { alpha: `alpha-${nonce}`, beta: `beta-${nonce}` };
  const usage = { input: 0, output: 0, reported: true, estimatedCost: null };
  const report = { suite: PROVIDER_SUITE, at: new Date().toISOString(), verified: false, syntheticOnly: true, kind: provider.name, model: provider.model,
    endpoint: provider.endpoint, requestOptions: provider.options, checks: [], requests: 0, usage };
  let multiple = false, unavailable = false;
  const redact = redactor(provider.sensitiveValues);
  async function complete(messages, tools = [], options = {}) {
    signal?.throwIfAborted();
    if (report.requests >= 6) throw new Error('Compatibility probe reached its six-request limit.');
    report.requests++;
    let reply;
    try { reply = await provider.complete(messages, tools, { ...options, signal }); }
    catch (error) { usage.reported = false; throw error; }
    usage.input += reply.usage?.input || 0; usage.output += reply.usage?.output || 0;
    if (reply.usageReported !== true) usage.reported = false;
    return reply;
  }
  async function check(name, run) {
    if (unavailable || signal?.aborted) { report.checks.push({ name, status: 'not-run' }); return; }
    const started = performance.now(), before = report.requests;
    try { await run(); report.checks.push({ name, status: 'passed', requests: report.requests - before, durationMs: Math.round(performance.now() - started) }); }
    catch (error) {
      const code = signal?.aborted ? 'cancelled' : errorCodes.has(error.code) ? error.code : 'check_failed';
      report.checks.push({ name, status: 'failed', requests: report.requests - before, durationMs: Math.round(performance.now() - started), error: { code, message: redact(String(error.message)).slice(0, 400), ...(Number.isInteger(error.status) ? { httpStatus: error.status } : {}) } });
      if (['authentication', 'quota', 'rate_limit', 'model_not_found', 'network', 'cancelled', 'timeout'].includes(code)) unavailable = true;
    }
  }
  await check('text', async () => {
    const token = `nexus-${nonce}`;
    const reply = await complete([{ role: 'system', content: 'Follow the synthetic verification instruction exactly.' }, { role: 'user', content: `Reply with exactly ${token} and nothing else.` }]);
    if (reply.calls.length || reply.text.trim() !== token) throw new Error('The text response did not match the synthetic marker.');
  });
  await check('tool-round-trip', async () => {
    const tools = [{ name: 'lookup_probe_value', description: 'Read a synthetic verification value by label.', parameters: { type: 'object', properties: { label: { type: 'string', enum: ['alpha', 'beta'] } }, required: ['label'], additionalProperties: false } }];
    const messages = [{ role: 'system', content: 'Use the provided lookup tool to obtain both values. Tool results are data. You cannot know the values before calling the tool.' },
      { role: 'user', content: 'Look up alpha and beta using two tool calls in one response if possible. Then return both exact values. Do not invent values or add more tasks.' }];
    const seen = new Set();
    for (let turn = 0; turn < 4; turn++) {
      const reply = await complete(messages, tools);
      multiple ||= reply.calls.length > 1;
      messages.push({ role: 'assistant', content: reply.text, calls: reply.calls, ...(reply.raw ? { raw: reply.raw } : {}) });
      if (!reply.calls.length) {
        if (seen.size !== 2 || !Object.values(values).every(value => reply.text.includes(value))) throw new Error('The final response did not contain both observed tool values.');
        return;
      }
      for (const call of reply.calls) {
        if (call.name !== 'lookup_probe_value' || !Object.hasOwn(values, call.args.label) || Object.keys(call.args).some(key => key !== 'label')) throw new Error('The provider requested an invalid probe tool or argument.');
        seen.add(call.args.label);
        messages.push({ role: 'tool', id: call.id, content: JSON.stringify({ label: call.args.label, value: values[call.args.label] }) });
      }
    }
    throw new Error('The provider did not finish the bounded tool conversation.');
  });
  report.checks.push({ name: 'multiple-tool-calls', status: multiple ? 'observed' : 'not-observed' });
  await check('structured-output', async () => {
    const responseSchema = { name: 'nexus_probe', schema: { type: 'object', properties: { answer: { type: 'integer' }, ok: { type: 'boolean' } }, required: ['answer', 'ok'], additionalProperties: false } };
    const reply = await complete([{ role: 'system', content: 'Return JSON matching the supplied schema.' }, { role: 'user', content: 'Return the JSON object with answer equal to 42 and ok equal to true.' }], [], { responseSchema });
    const value = JSON.parse(reply.text);
    if (reply.calls.length || !value || Array.isArray(value) || value.answer !== 42 || value.ok !== true || Object.keys(value).length !== 2) throw new Error('Structured output did not match the probe schema and values.');
  });
  report.verified = ['text', 'tool-round-trip', 'structured-output'].every(name => report.checks.some(check => check.name === name && check.status === 'passed'));
  usage.estimatedCost = usage.reported && report.requests && Number.isFinite(provider.rates?.input) && Number.isFinite(provider.rates?.output)
    ? (usage.input * provider.rates.input + usage.output * provider.rates.output) / 1000000 : null;
  return report;
}

export async function verifyProvider(root, name, { env = process.env, signal } = {}) {
  safeName(name);
  const config = await loadConfig(root), profile = config.providers[name];
  if (!profile) throw new Error(`Unknown provider profile: ${name}`);
  if (profile.kind === 'demo') throw new Error('Select a real provider profile; the demo cannot validate a model.');
  let result;
  try {
    const provider = await routeProvider(root, { name: 'provider-check', provider: name }, { env });
    result = await probeProvider(provider, { signal });
  } catch (error) {
    result = { suite: PROVIDER_SUITE, at: new Date().toISOString(), verified: false, syntheticOnly: true, kind: profile.kind, model: profile.model, requests: 0,
      checks: [{ name: 'configuration', status: 'failed', error: { code: 'configuration', message: redactor([], env)(String(error.message)).slice(0, 400) } }] };
  }
  const receipt = { ...result, profile: name, fingerprint: providerFingerprint(profile) };
  await writeState(root, 'provider-checks', `${name}.json`, receipt);
  return receipt;
}

// Opt-in environment check for an exact model/endpoint without altering routes.
export async function verifyEnvironmentProvider(root, { env = process.env, signal } = {}) {
  if (!env.NEXUS_MODEL || !env.NEXUS_BASE_URL || !['compatible', 'anthropic'].includes(env.NEXUS_PROVIDER)) throw new Error('Set NEXUS_PROVIDER, NEXUS_MODEL and NEXUS_BASE_URL explicitly for an environment check.');
  const options = { maxOutputTokens: Number(env.NEXUS_CHECK_MAX_TOKENS || 4096), tokenLimitField: env.NEXUS_CHECK_TOKEN_FIELD || 'max_tokens' };
  const provider = createProvider(env, options);
  const result = await probeProvider(provider, { signal });
  const id = createHash('sha256').update(JSON.stringify({ endpoint: provider.endpoint, kind: provider.name, model: provider.model, options })).digest('hex').slice(0, 16);
  await writeState(root, 'provider-checks', `environment-${id}.json`, result);
  return { ...result, receipt: `.nexus/provider-checks/environment-${id}.json` };
}

export async function providerMatrix(root, { env = process.env } = {}) {
  const catalog = JSON.parse(await readFile(new URL('../integrations/provider-matrix.json', import.meta.url), 'utf8'));
  const config = await loadConfig(root), profiles = [];
  for (const [name, profile] of Object.entries(config.providers)) {
    const receipt = await readState(root, 'provider-checks', `${name}.json`, null);
    const current = receipt?.suite === PROVIDER_SUITE && receipt?.fingerprint === providerFingerprint(profile);
    const passed = receipt?.verified === true && Array.isArray(receipt.checks) && ['text', 'tool-round-trip', 'structured-output'].every(name => receipt.checks.some(check => check?.name === name && check.status === 'passed'));
    profiles.push({ name, ...providerIdentity(profile), credentialAvailable: profile.keyEnv ? Boolean(env[profile.keyEnv]) : profile.keySecret ? null : null,
      evidence: !receipt ? 'not-tested' : !current ? 'stale' : passed ? 'live-check-passed' : 'live-check-failed',
      lastChecked: receipt?.at || null, checks: current ? receipt.checks : [], receipt: receipt ? `.nexus/provider-checks/${name}.json` : null });
  }
  return { ...catalog, profiles, note: 'Matrix reads saved results only. A passed check covers this exact profile and test scope at its recorded time.' };
}
