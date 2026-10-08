import { runProcess } from './process.js';

// Even read-only Git commands can invoke fsmonitor and clean/process filters.
// Inspect configuration without evaluating those programs, then neutralize them.
export async function runGit(root, args, options = {}) {
  const config = await runProcess('git', ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], { ...options, cwd: root });
  if (config.stopped || ![0, 1].includes(config.code)) throw new Error('Could not safely inspect Git filter configuration.');
  const filters = new Set(config.output.split('\0').filter(Boolean).map(key => key.slice(7, key.lastIndexOf('.'))));
  const safe = ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
  for (const name of filters) for (const [key, value] of [['clean', ''], ['smudge', ''], ['process', ''], ['required', 'false']]) safe.push('-c', `filter.${name}.${key}=${value}`);
  return runProcess('git', [...safe, ...args], { ...options, cwd: root });
}
