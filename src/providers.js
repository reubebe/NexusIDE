export async function readProviderJson(response, maxBytes = 4 * 1024 * 1024) {
  if (!response.body) throw new Error('Provider returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Provider response exceeds the 4 MB limit.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export function createProvider(env = process.env) {
  const kind = env.NEXUS_PROVIDER || 'compatible';
  if (!['compatible', 'anthropic', 'demo'].includes(kind)) throw new Error('NEXUS_PROVIDER must be compatible, anthropic, or demo.');
  if (kind === 'demo') return {
    name: 'demo', model: 'offline-script',
    async complete(messages) {
      if (!messages.some(m => m.role === 'tool')) return { text: '', calls: [{ id: 'demo-list', name: 'list_files', args: { path: '.' } }] };
      return { text: `Offline demo completed. Project entries:\n${messages.find(m => m.role === 'tool').content}\n\nThis scripted demo exercises the runtime; it does not use an AI model.`, calls: [] };
    },
  };
  const model = env.NEXUS_MODEL;
  if (!model) throw new Error('Set NEXUS_MODEL to a model available from your provider, or use --demo.');
  const base = env.NEXUS_BASE_URL || (kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1');
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash) throw new Error('Provider URL must not contain credentials, query parameters, or a fragment.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Provider endpoint must use HTTPS (HTTP allowed for localhost).');
  const key = env.NEXUS_API_KEY || (kind === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);
  if (!key && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Set NEXUS_API_KEY for the provider.');
  return {
    name: kind, model, sensitiveValues: key ? [key] : [],
    async complete(messages, tools, { signal } = {}) {
      let body, headers = { 'content-type': 'application/json' };
      if (kind === 'anthropic') {
        headers = { ...headers, 'x-api-key': key, 'anthropic-version': '2023-06-01' };
        const converted = messages.filter(m => m.role !== 'system').map(m => {
          if (m.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.id, content: m.content }] };
          if (m.role === 'assistant') return { role: 'assistant', content: m.raw || [...(m.content ? [{ type: 'text', text: m.content }] : []), ...(m.calls || []).map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args }))] };
          return { role: m.role, content: m.content };
        });
        body = { model, max_tokens: 4096, system: messages[0].content, messages: converted, ...(tools.length ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}) };
      } else {
        if (key) headers.authorization = `Bearer ${key}`;
        body = { model, messages: messages.map(m => m.role === 'tool' ? { role: 'tool', tool_call_id: m.id, content: m.content } : { role: m.role, content: m.content || null, ...(m.calls?.length ? { tool_calls: m.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) }), ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: t })) } : {}) };
      }
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
      const response = await fetch(`${base.replace(/\/$/, '')}/${kind === 'anthropic' ? 'messages' : 'chat/completions'}`, { method: 'POST', headers, body: JSON.stringify(body), signal: requestSignal, redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Provider returned HTTP ${response.status}. Check your model, endpoint, credentials, and quota.`);
      }
      const data = await readProviderJson(response);
      if (kind === 'anthropic') return { usage: { input: data.usage?.input_tokens || 0, output: data.usage?.output_tokens || 0 }, text: data.content.filter(b => b.type === 'text').map(b => b.text).join('\n'), raw: data.content, calls: data.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input })) };
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error('Provider returned no message.');
      return { usage: { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 }, text: message.content || '', calls: (message.tool_calls || []).map(c => ({ id: c.id, name: c.function.name, args: JSON.parse(c.function.arguments) })) };
    },
  };
}
