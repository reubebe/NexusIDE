import { createHash } from 'node:crypto';

// Keys are canonical hashes, never raw paths, command arguments or credentials.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function toolOutcome(name, content, { threw = false, mcp = false, denied = false } = {}) {
  if (denied) return 'denied';
  if (threw) return 'failed';
  const declined = { write_file: 'Write declined by user.', run_command: 'Command declined by user.', run_application: 'Application declined.', save_memory: 'Memory declined.', search_memory_semantic: 'Semantic search declined.', update_board_task: 'Task update declined.', create_visualization: 'Visualization declined.' };
  if (Object.hasOwn(declined, name) && content === declined[name]) return 'denied';
  if (mcp && content === 'MCP call declined.') return 'denied';
  if (['run_command', 'run_application', 'git_diff', 'git_status'].includes(name) || mcp) {
    try {
      const result = JSON.parse(content);
      if (mcp) return result?.isError === true ? 'failed' : 'completed';
      if (result && typeof result === 'object' && Object.hasOwn(result, 'code') && (result.code !== 0 || result.stopped || result.signal)) return 'failed';
    } catch { /* Ordinary text is not a structured failure. */ }
  }
  return 'completed';
}

export function toolFailed(name, content, options) {
  return toolOutcome(name, content, options) !== 'completed';
}

export function toolCallKey(call) {
  return createHash('sha256').update(JSON.stringify([call.name, canonical(call.args)])).digest('hex');
}

export function createToolFailureGuard(limit = 3) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('Invalid repeated-tool-failure limit.');
  const failures = new Map();
  return {
    record(call, failed) {
      const key = toolCallKey(call);
      if (!failed) { failures.delete(key); return null; }
      const attempts = (failures.get(key) || 0) + 1;
      failures.set(key, attempts);
      return attempts >= limit ? { tool: call.name, attempts, limit } : null;
    },
  };
}
