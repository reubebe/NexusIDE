export function validateBudget(limits = {}) {
  for (const [key, min, max] of [['maxRequests',1,1000],['maxTokens',1,100000000],['maxDurationMs',1000,3600000]]) {
    if (limits[key] !== undefined && (!Number.isSafeInteger(limits[key]) || limits[key] < min || limits[key] > max)) throw new Error(`Invalid ${key} budget.`);
  }
}
export function createRunBudget(limits = {}) {
  validateBudget(limits);
  let requests = 0, tokens = 0, known = true;
  const started = Date.now();
  const signal = limits.maxDurationMs ? AbortSignal.timeout(limits.maxDurationMs) : undefined;
  const check = () => {
    if (limits.maxDurationMs && Date.now() - started >= limits.maxDurationMs) throw new Error('Run time budget reached.');
    if (limits.maxTokens && (!known || tokens >= limits.maxTokens)) throw new Error(known ? 'Token budget reached; no further requests or tools will run.' : 'Token usage is unknown; stopping because a token budget is enabled.');
  };
  return {
    signal,
    reserve() { check(); if (requests >= (limits.maxRequests || 1000)) throw new Error('Model request budget reached.'); requests++; },
    record(usage, reported) { known = known && reported !== false && !!usage && Number.isSafeInteger(usage.input) && Number.isSafeInteger(usage.output) && usage.input >= 0 && usage.output >= 0; if (known) tokens += usage.input + usage.output; },
    check,
    snapshot: () => ({ requests, tokens, reported: known, limits })
  };
}

export async function withAbort(operation, signal) {
  signal?.throwIfAborted();
  if (!signal) return operation();
  let abort;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
