// Nexus subset: inline only the reviewed, dependency-free SVG kit.
import { readFileSync } from 'node:fs';

export function kitScript() {
  return readFileSync(new URL('../kit/iso-kit.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
}
