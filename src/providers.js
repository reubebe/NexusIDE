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

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);

function providerError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

function invalid(message) { throw providerError('invalid_response', `Invalid provider response: ${message}`); }
function incomplete() { throw providerError('incomplete_response', 'Provider did not complete the response. No incomplete tool calls were executed.'); }

function usageResult(usage, inputKey, outputKey) {
  if (usage === undefined || usage === null) return { usage: { input: 0, output: 0 }, usageReported: false };
  if (!isObject(usage) || ![usage[inputKey], usage[outputKey]].every(n => n === undefined || (Number.isSafeInteger(n) && n >= 0))) invalid('token usage must contain nonnegative integer input and output counts.');
  return { usage: { input: usage[inputKey] ?? 0, output: usage[outputKey] ?? 0 }, usageReported: usage[inputKey] !== undefined && usage[outputKey] !== undefined };
}

function validateCalls(calls) {
  if (calls.length > 32) invalid('too many tool calls (maximum 32).');
  const ids = new Set();
  for (const call of calls) {
    if (!identifier(call.id) || ids.has(call.id) || !identifier(call.name) || !isObject(call.args)) invalid('tool calls require unique IDs, valid names and object arguments.');
    ids.add(call.id);
  }
  return calls;
}

function googleSignature(source) {
  if (source?.extra_content == null) return {};
  if (!isObject(source.extra_content)) invalid('extra content must be an object.');
  const google = source.extra_content.google;
  if (google === undefined) return {};
  if (!isObject(google)) invalid('Google extra content must be an object.');
  if (google.thought_signature === undefined) return {};
  if (typeof google.thought_signature !== 'string' || !google.thought_signature) invalid('thought signature must be a nonempty string.');
  return { extra_content: { google: { thought_signature: google.thought_signature } } };
}

function compatibleMetadata(source) {
  const metadata = googleSignature(source);
  if (source?.reasoning_content !== undefined && source.reasoning_content !== null) {
    if (typeof source.reasoning_content !== 'string') invalid('reasoning content must be text.');
    metadata.reasoning_content = source.reasoning_content;
  }
  return metadata;
}

function imageContent(message, kind) {
  if (!message.images?.length) return message.content;
  return [...message.images.map(image => kind === 'anthropic' ? { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } } : { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } }), { type: 'text', text: message.content }];
}
function compatibleMessages(messages) {
  return messages.map(message => {
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.id, content: message.content };
    return {
      role: message.role, content: imageContent(message, 'compatible') || null,
      // Replay only documented continuation metadata. Never let raw response
      // fields replace normalized roles, content, or validated tool arguments.
      ...(message.role === 'assistant' ? compatibleMetadata(message.raw) : {}),
      ...(message.calls?.length ? { tool_calls: message.calls.map(call => ({
        id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) },
        ...googleSignature(call),
      })) } : {}),
    };
  });
}

function compatibleResult(data) {
  if (!isObject(data) || data.error || !Array.isArray(data.choices) || data.choices.length !== 1 || !isObject(data.choices[0])) invalid('expected one chat completion choice.');
  const choice = data.choices[0];
  if (['length', 'content_filter'].includes(choice.finish_reason)) incomplete();
  const message = choice.message;
  if (!isObject(message) || (message.role !== undefined && message.role !== 'assistant')) invalid('expected an assistant message.');
  if (message.refusal) incomplete();
  if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') invalid('message content must be text.');
  if (message.tool_calls != null && !Array.isArray(message.tool_calls)) invalid('tool calls must be an array or null.');
  const calls = validateCalls((message.tool_calls || []).map(call => {
    if (!isObject(call) || (call.type !== undefined && call.type !== 'function') || !isObject(call.function) || typeof call.function.arguments !== 'string') invalid('malformed function call.');
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { invalid('function arguments are not valid JSON.'); }
    return { id: call.id, name: call.function.name, args, ...googleSignature(call) };
  }));
  // Some compatible servers omit this field; infer it only after validating the message.
  const finishReason = choice.finish_reason === undefined ? (calls.length ? 'tool_calls' : 'stop') : choice.finish_reason;
  if (!['stop', 'tool_calls'].includes(finishReason)) incomplete();
  if ((finishReason === 'tool_calls') !== Boolean(calls.length)) invalid('finish reason does not match the tool calls.');
  const text = message.content || '';
  if (!calls.length && !text.trim()) invalid('empty final response.');
  const raw = compatibleMetadata(message);
  return { ...usageResult(data.usage, 'prompt_tokens', 'completion_tokens'), text, calls, finishReason, ...(Object.keys(raw).length ? { raw } : {}) };
}

function anthropicResult(data) {
  if (!isObject(data) || data.error || (data.type !== undefined && data.type !== 'message') || (data.role !== undefined && data.role !== 'assistant')) invalid('expected an assistant message.');
  if (['max_tokens', 'pause_turn', 'refusal', 'model_context_window_exceeded'].includes(data.stop_reason)) incomplete();
  if (!Array.isArray(data.content)) invalid('message content must be an array.');
  const textParts = [], calls = [];
  for (const block of data.content) {
    if (!isObject(block)) invalid('malformed message content block.');
    if (block.type === 'text' && typeof block.text === 'string') textParts.push(block.text);
    else if (block.type === 'tool_use') calls.push({ id: block.id, name: block.name, args: block.input });
    else if (block.type === 'thinking' && typeof block.thinking === 'string' && typeof block.signature === 'string') continue;
    else if (block.type === 'redacted_thinking' && typeof block.data === 'string') continue;
    else invalid('unsupported or malformed message content block.');
  }
  validateCalls(calls);
  const finishReason = data.stop_reason === undefined ? (calls.length ? 'tool_use' : 'end_turn') : data.stop_reason;
  if (!['end_turn', 'stop_sequence', 'tool_use'].includes(finishReason)) incomplete();
  if ((finishReason === 'tool_use') !== Boolean(calls.length)) invalid('stop reason does not match the tool calls.');
  const text = textParts.join('\n');
  if (!calls.length && !text.trim()) invalid('empty final response.');
  return { ...usageResult(data.usage, 'input_tokens', 'output_tokens'), text, raw: data.content, calls, finishReason };
}

function responsesResult(data) {
  if (!isObject(data) || data.error || !Array.isArray(data.output) || data.output.length > 256) invalid('expected a bounded Responses output array.');
  if (data.status !== 'completed' || data.incomplete_details) incomplete();
  const text = [], calls = [], replay = [];
  for (const item of data.output) {
    if (!isObject(item) || (item.status !== undefined && item.status !== 'completed')) incomplete();
    if (item.type === 'function_call') {
      let args;
      try { args = JSON.parse(item.arguments); } catch { invalid('function arguments are not valid JSON.'); }
      calls.push({ id: item.call_id, name: item.name, args });
      replay.push({ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments });
    } else if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) invalid('expected an assistant output message.');
      const content = item.content.map(block => {
        if (block?.type === 'refusal') incomplete();
        if (block?.type !== 'output_text' || typeof block.text !== 'string') invalid('unsupported Responses message content.');
        text.push(block.text); return { type: 'output_text', text: block.text, annotations: [] };
      });
      replay.push({ type: 'message', role: 'assistant', content });
    } else if (item.type === 'reasoning') {
      if (!identifier(item.id) || !Array.isArray(item.summary) || item.summary.some(s => s?.type !== 'summary_text' || typeof s.text !== 'string') || (item.encrypted_content !== undefined && item.encrypted_content !== null && typeof item.encrypted_content !== 'string')) invalid('malformed reasoning continuation.');
      // Stateless continuation requires the encrypted reasoning, never a
      // reference to an output stored on the provider's servers.
      if (item.encrypted_content) replay.push({ type: 'reasoning', id: item.id, summary: item.summary.map(s => ({ type: 'summary_text', text: s.text })), encrypted_content: item.encrypted_content });
    } else invalid('unsupported Responses output item.');
  }
  validateCalls(calls);
  const output = text.join('\n');
  if (!calls.length && !output.trim()) invalid('empty final response.');
  return { ...usageResult(data.usage, 'input_tokens', 'output_tokens'), text: output, calls, raw: { responses: replay }, finishReason: calls.length ? 'tool_calls' : 'stop' };
}

function responsesInput(messages) {
  return messages.filter(m => m.role !== 'system').flatMap(message => {
    if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.id, output: message.content }];
    if (message.role === 'assistant') {
      if (Array.isArray(message.raw?.responses)) return message.raw.responses;
      return [...(message.content ? [{ role: 'assistant', content: message.content }] : []), ...(message.calls || []).map(c => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) }))];
    }
    return [{ role: message.role, content: message.images?.length
      ? [{ type: 'input_text', text: message.content }, ...message.images.map(i => ({ type: 'input_image', image_url: `data:${i.mimeType};base64,${i.data}` }))]
      : message.content }];
  });
}

function anthropicMessages(messages) {
  const converted = [];
  let previousWasTool = false;
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const result = { type: 'tool_result', tool_use_id: message.id, content: message.content };
      if (previousWasTool) converted.at(-1).content.push(result);
      else converted.push({ role: 'user', content: [result] });
      previousWasTool = true;
      continue;
    }
    previousWasTool = false;
    if (message.role === 'assistant') converted.push({ role: 'assistant', content: message.raw || [...(message.content ? [{ type: 'text', text: message.content }] : []), ...(message.calls || []).map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args }))] });
    else converted.push({ role: message.role, content: imageContent(message, 'anthropic') });
  }
  return converted;
}

async function httpError(response) {
  // Read only a bounded error envelope for classification. Never echo remote text or codes.
  let codes = [];
  try {
    const data = await readProviderJson(response, 64 * 1024);
    codes = [data?.error?.code, data?.error?.type].filter(value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value)).map(value => value.toLowerCase());
  } catch { /* Status still provides useful classification for non-JSON error bodies. */ }
  const status = response.status;
  let code = 'http_error';
  if (status === 401 || status === 403) code = 'authentication';
  else if (codes.some(value => ['insufficient_quota', 'quota_exceeded', 'billing_hard_limit_reached', 'credit_balance_too_low'].includes(value))) code = 'quota';
  else if (codes.some(value => ['context_length_exceeded', 'context_window_exceeded', 'prompt_too_long', 'request_too_large'].includes(value)) || status === 413) code = 'context_limit';
  else if (codes.some(value => ['model_not_found', 'model_not_exist', 'unknown_model'].includes(value)) || status === 404) code = 'model_not_found';
  else if (status === 429) code = 'rate_limit';
  else if (status === 408 || status === 504) code = 'timeout';
  return providerError(code, `Provider returned HTTP ${status} (${code}). Check your model, endpoint, credentials, and quota.`, status);
}

export function validateProviderOptions(options = {}) {
  if (!isObject(options)) throw new Error('Provider options must be an object.');
  const { timeoutMs = 120000, maxOutputTokens = 4096, tokenLimitField = 'max_tokens', vision = false } = options;
  if (typeof vision !== 'boolean') throw new Error('Provider vision must be boolean. Enable it only for a model that accepts images.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error('Provider timeoutMs must be an integer from 100 to 120000.');
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32768) throw new Error('Provider maxOutputTokens must be an integer from 1 to 32768.');
  if (!['max_tokens', 'max_completion_tokens'].includes(tokenLimitField)) throw new Error('Provider tokenLimitField must be max_tokens or max_completion_tokens.');
  return { timeoutMs, maxOutputTokens, tokenLimitField, ...(vision ? { vision } : {}) };
}

export function createProvider(env = process.env, options = {}) {
  const validatedOptions = validateProviderOptions(options);
  const { timeoutMs, maxOutputTokens, tokenLimitField } = validatedOptions;
  const kind = env.NEXUS_PROVIDER || 'compatible';
  if (!['compatible', 'anthropic', 'responses', 'demo'].includes(kind)) throw new Error('NEXUS_PROVIDER must be compatible, anthropic, responses, or demo.');
  if (kind === 'demo') return {
    name: 'demo', model: 'offline-script', options: validatedOptions,
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
  const officialOrigin = kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com';
  const key = env.NEXUS_API_KEY || (url.origin === officialOrigin ? (kind === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY) : undefined);
  if (!key && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Set NEXUS_API_KEY for the provider.');
  return {
    name: kind, model, endpoint: url.href.replace(/\/$/, ''), options: validatedOptions, sensitiveValues: key ? [key] : [],
    async complete(messages, tools = [], { signal, responseSchema } = {}) {
      const withImages = messages.filter(m => m.images !== undefined);
      if (withImages.length) {
        if (validatedOptions.vision !== true) throw new Error('This provider profile has not enabled vision.');
        const { validateImage } = await import('./artifacts.js');
        let imageBytes = 0;
        for (const message of withImages) {
          if (message.role !== 'user' || typeof message.content !== 'string' || !Array.isArray(message.images) || message.images.length > 4) throw new Error('Images require a user message with at most four images.');
          for (const image of message.images) imageBytes += validateImage(image.mimeType, image.data).bytes.length;
        }
        if (imageBytes > 5_000_000) throw new Error('Image request exceeds 5 MB.');
      }
      if (responseSchema !== undefined && (!isObject(responseSchema) || !identifier(responseSchema.name) || responseSchema.name.length > 64 || !isObject(responseSchema.schema))) throw new Error('responseSchema requires a name (maximum 64 characters) and a JSON schema object.');
      let body, headers = { 'content-type': 'application/json' };
      if (kind === 'anthropic') {
        headers = { ...headers, ...(key ? { 'x-api-key': key } : {}), 'anthropic-version': '2023-06-01' };
        const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
        body = { model, max_tokens: maxOutputTokens, ...(system ? { system } : {}), messages: anthropicMessages(messages), ...(tools.length ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}), ...(responseSchema ? { output_config: { format: { type: 'json_schema', schema: responseSchema.schema } } } : {}) };
      } else if (kind === 'responses') {
        if (key) headers.authorization = `Bearer ${key}`;
        body = { model, store: false, max_output_tokens: maxOutputTokens,
          instructions: messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n'),
          input: responsesInput(messages), include: ['reasoning.encrypted_content'],
          ...(tools.length ? { tools: tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })) } : {}),
          ...(responseSchema ? { text: { format: { type: 'json_schema', name: responseSchema.name, schema: responseSchema.schema, strict: true } } } : {}) };
      } else {
        if (key) headers.authorization = `Bearer ${key}`;
        body = { model, [tokenLimitField]: maxOutputTokens, messages: compatibleMessages(messages), ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: t })) } : {}), ...(responseSchema ? { response_format: { type: 'json_schema', json_schema: { name: responseSchema.name, strict: true, schema: responseSchema.schema } } } : {}) };
      }
      const timeout = AbortSignal.timeout(timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        requestSignal.throwIfAborted();
        const response = await fetch(`${base.replace(/\/$/, '')}/${kind === 'anthropic' ? 'messages' : kind === 'responses' ? 'responses' : 'chat/completions'}`, { method: 'POST', headers, body: JSON.stringify(body), signal: requestSignal, redirect: 'error' });
        if (!response.ok) throw await httpError(response);
        let data;
        try { data = await readProviderJson(response); } catch { throw providerError('invalid_response', 'Invalid provider response: expected bounded JSON.'); }
        requestSignal.throwIfAborted();
        return kind === 'anthropic' ? anthropicResult(data) : kind === 'responses' ? responsesResult(data) : compatibleResult(data);
      } catch (error) {
        if (signal?.aborted) throw providerError('cancelled', 'Provider request cancelled.');
        if (timeout.aborted) throw providerError('timeout', 'Provider request timed out.');
        if (error.code && ['authentication', 'rate_limit', 'quota', 'model_not_found', 'context_limit', 'timeout', 'invalid_response', 'incomplete_response', 'http_error'].includes(error.code)) throw error;
        throw providerError('network', 'Provider connection failed. Check your endpoint and network.');
      }
    },
  };
}
