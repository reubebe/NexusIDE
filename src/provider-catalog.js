import { readProviderJson } from './providers.js';
import { createHash } from 'node:crypto';

// Fixed endpoints prevent a browser request from forwarding an environment key
// to an arbitrary host. Regional accounts must be selected explicitly.
const catalog = [
  ['openai', 'OpenAI', 'OPENAI_API_KEY', 'https://api.openai.com/v1'],
  ['anthropic', 'Anthropic · Claude', 'ANTHROPIC_API_KEY', 'https://api.anthropic.com/v1'],
  ['gemini', 'Google · Gemini', 'GEMINI_API_KEY', 'https://generativelanguage.googleapis.com/v1beta/openai'],
  ['xai', 'xAI · Grok', 'XAI_API_KEY', 'https://api.x.ai/v1'],
  ['deepseek', 'DeepSeek', 'DEEPSEEK_API_KEY', 'https://api.deepseek.com/v1'],
  ['moonshot', 'Moonshot · Kimi (international)', 'MOONSHOT_API_KEY', 'https://api.moonshot.ai/v1'],
  ['moonshot-cn', 'Moonshot · Kimi (China)', 'MOONSHOT_API_KEY', 'https://api.moonshot.cn/v1'],
  ['zhipu', 'Zhipu · GLM (BigModel)', 'ZHIPUAI_API_KEY', 'https://open.bigmodel.cn/api/paas/v4'],
  ['zai', 'Z.ai · GLM (international)', 'ZHIPUAI_API_KEY', 'https://api.z.ai/api/paas/v4'],
  ['qwen', 'Alibaba · Qwen (Singapore)', 'DASHSCOPE_API_KEY', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'],
  ['qwen-cn', 'Alibaba · Qwen (China)', 'DASHSCOPE_API_KEY', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
].map(([id, label, keyEnv, baseUrl]) => ({ id, label, keyEnv, baseUrl, kind: id === 'anthropic' ? 'anthropic' : 'compatible',
  ...(id === 'qwen' ? { modelsUrl: 'https://dashscope-intl.aliyuncs.com/api/v1/models' } : {}),
  ...(id.startsWith('qwen') ? { note: 'For accounts requiring a workspace-specific endpoint, use Advanced connections. Streaming-only models are not supported by the current agent runtime.' } : {}) }));

function preset(id) {
  const found = catalog.find(p => p.id === id);
  if (!found) throw new Error('Unknown provider.');
  return found;
}

export function credentialStatus(value) {
  if (typeof value !== 'string' || !value.trim()) return 'missing';
  if (/^(your[-_ ]|paste[-_ ]|replace[-_ ]|<)|^(changeme|sk-\.\.\.)$/i.test(value.trim())) return 'placeholder';
  return 'available';
}

export function discoverProviders(env = process.env) {
  return catalog.map(p => ({ ...p, credential: credentialStatus(env[p.keyEnv]) }));
}

export function isAgentModel(id, provider = '') {
  // Model catalogues also contain media/embedding and Responses-only models.
  // This removes known mismatches, not a guarantee of tool-call compatibility.
  return !/(embedding|moderation|image|audio|tts|whisper|transcrib|realtime|live|video|sora|dall-e|deep-research|search|rerank)/i.test(id)
    && !/^(babbage|davinci)/i.test(id)
    && !/^gpt-.*-(?:codex|instruct)(?:-|$)/i.test(id)
    && !/^(gpt-5(?:\.\d+)?|o1|o3)-pro(?:-|$)/i.test(id)
    && !(provider.startsWith('qwen') && /^qwen3\.5-(?:122b-a10b|27b)(?:-|$)/i.test(id));
}

export async function discoverModels(id, { env = process.env, fetchImpl = fetch } = {}) {
  const p = preset(id);
  if (credentialStatus(env[p.keyEnv]) !== 'available') throw new Error(`Set a real ${p.keyEnv} before loading models.`);
  const headers = p.kind === 'anthropic'
    ? { 'x-api-key': env[p.keyEnv], 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${env[p.keyEnv]}` };
  try {
    const models = [], signal = AbortSignal.timeout(15000);
    let after, listed = 0, hasMore = false;
    for (let page = 0; page < 10; page++) {
      const url = new URL(p.modelsUrl || `${p.baseUrl}/models`);
      if (p.kind === 'anthropic') { url.searchParams.set('limit', '100'); if (after) url.searchParams.set('after_id', after); }
      if (p.modelsUrl) { url.searchParams.set('page_no', String(page + 1)); url.searchParams.set('page_size', '100'); url.searchParams.set('capabilities', 'TG'); url.searchParams.set('features', 'function-calling'); }
      const response = await fetchImpl(url, { headers, signal, redirect: 'error' });
      if (!response.ok) throw new Error(`Model list unavailable (HTTP ${response.status}). Check your key, account region, and access, or enter a model ID below.`);
      const data = await readProviderJson(response);
      const entries = p.modelsUrl ? data.output?.models : data.data;
      if (!Array.isArray(entries)) throw new Error('This provider does not expose a compatible model list. Enter a model ID below.');
      listed += entries.length;
      for (const item of entries) {
        const id = p.modelsUrl ? item?.model : item?.id;
        if (typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(id) && isAgentModel(id, p.id)) models.push(id);
      }
      hasMore = p.modelsUrl ? Number.isSafeInteger(data.output?.total) && listed < data.output.total && entries.length > 0
        : p.kind === 'anthropic' && data.has_more === true && typeof data.last_id === 'string' && data.last_id !== after;
      if (!hasMore) break;
      after = data.last_id;
    }
    return { models: [...new Set(models)].sort(), note: `Provider model list. Choose a text model with tool calling; listing does not verify account access or agent compatibility.${hasMore ? ' The list was limited to ten pages; enter an omitted model ID manually.' : ''}` };
  } catch (error) {
    // Never relay provider response bodies or transport errors containing keys.
    if (error.message.startsWith('Model list unavailable') || error.message.startsWith('This provider does not')) throw error;
    throw new Error('Could not load models. Check your connection or enter a model ID below.');
  }
}

export function applyProviderSelection(config, { provider, model, route = 'default' }, env = process.env) {
  const p = preset(provider);
  if (credentialStatus(env[p.keyEnv]) !== 'available') throw new Error(`Set a real ${p.keyEnv} before connecting.`);
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model)) throw new Error('Enter a valid model ID.');
  if (typeof route !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(route)) throw new Error('Invalid agent route.');
  const next = structuredClone(config);
  // Reuse identical selections without growing configuration on every click.
  // Profiles are immutable here: changing a route never changes another route.
  const profile = { kind: p.kind, model, baseUrl: p.baseUrl, keyEnv: p.keyEnv, ...(provider === 'openai' ? { tokenLimitField: 'max_completion_tokens' } : {}), maxOutputTokens: 4096 };
  const fingerprint = createHash('sha256').update(JSON.stringify(profile)).digest('hex').slice(0, 16);
  const stem = `picker-${provider}-${fingerprint}`;
  let name = stem, suffix = 1;
  while (Object.hasOwn(next.providers, name) && JSON.stringify(next.providers[name]) !== JSON.stringify(profile)) name = `${stem}-${suffix++}`;
  next.providers[name] = profile;
  next.routes[route] = name;
  return next;
}
