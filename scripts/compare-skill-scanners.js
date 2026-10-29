import { parseArgs } from 'node:util';
import { compareSkillScanners } from '../src/deep-skill-scan.js';
import { writeState } from '../src/state.js';

const { values } = parseArgs({ options: {
  command: { type: 'string' }, network: { type: 'boolean', default: false }, llm: { type: 'boolean', default: false },
  provider: { type: 'string' }, model: { type: 'string' }, endpoint: { type: 'string' }, 'api-key-env': { type: 'string' },
  'timeout-ms': { type: 'string' }, save: { type: 'boolean', default: false },
}, allowPositionals: false });
const options = { command: values.command, network: values.network, llm: values.llm, provider: values.provider, model: values.model, endpoint: values.endpoint, apiKeyEnv: values['api-key-env'], timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']) };
const result = await compareSkillScanners(options);
if (values.save) await writeState(process.cwd(), 'verification', 'skill-scanner-comparison.json', result);
console.log(JSON.stringify(result, null, 2));
// An unavailable optional backend is an explicit incomplete comparison, not a
// successful live verification. Native-only exploratory use still prints it.
if (values.command && result.summary.deeper.incomplete) process.exitCode = 1;
