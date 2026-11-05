import { createInterface } from 'node:readline/promises';
export const terminalSafe = value => String(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
export const print = value => console.log(terminalSafe(value));
export function terminalApproval(signal) {
  let queue = Promise.resolve();
  return (request, { signal: requestSignal } = {}) => {
    const approvalSignal = requestSignal ? AbortSignal.any([requestSignal, ...(signal ? [signal] : [])]) : signal;
    const next = queue.then(async () => {
      approvalSignal?.throwIfAborted();
      if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
      print('\nApproval requested:\n' + JSON.stringify(request, null, 2));
      if (['command', 'mcp-connect', 'application'].includes(request.type)) print(request.mode === 'docker' ? 'Runs in the configured Docker container with workspace access.' : 'Runs on your machine with host privileges.');
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      try { return (await reader.question('Allow? [y/N] ', { signal: approvalSignal })).trim().toLowerCase() === 'y'; }
      finally { reader.close(); }
    });
    queue = next.catch(() => {});
    return next;
  };
}
