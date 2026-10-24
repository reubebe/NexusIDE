import test from 'node:test';
import assert from 'node:assert/strict';
import { localModelGuidance } from '../src/local-model-fit.js';
import { createProviderPicker } from '../ui/provider-picker.js';
const GiB = 1024 ** 3;
const hardware = { platform: 'darwin', arch: 'arm64', logicalCpus: 8, totalBytes: 16 * GiB, freeBytes: 2 * GiB };

test('size advisory distinguishes unknown, smaller, constrained and oversized downloads', () => {
  const result = localModelGuidance([{ name: 'small', size: 4 * GiB }, { name: 'near', size: 12 * GiB }, { name: 'large', size: 20 * GiB }, { name: 'unknown' }], hardware);
  assert.deepEqual(result.models.map(m => m.status), ['below-system-ram', 'limited-headroom', 'exceeds-system-ram', 'unknown']);
  assert.equal(result.hardware.totalGiB, 16); assert.equal(result.hardware.freeGiB, 2);
  assert.match(result.note, /tool calling are unverified/);
  assert.match(result.models[0].guidance, /does not establish/);
});

test('invalid memory/size inputs never become verified capacity claims', () => {
  const result = localModelGuidance([{ name: 'bad', size: -1 }, { name: 'bad2', size: Infinity }], { ...hardware, totalBytes: NaN });
  assert.equal(result.hardware.totalGiB, null);
  assert.ok(result.models.every(m => m.status === 'unknown'));
});

test('picker displays selected local guidance and clears it when switching providers', async () => {
  const guidance = localModelGuidance([{ name: 'small', size: 4 * GiB }], hardware);
  const picker = createProviderPicker(async () => ({ models: ['small'], guidance }));
  picker.catalog = [{ id: 'ollama', local: true }, { id: 'other', credential: 'missing', keyEnv: 'OTHER_KEY' }];
  await picker.selectProvider('ollama'); picker.model = 'small';
  assert.match(picker.localGuidance, /16 GiB system RAM/);
  assert.match(picker.localGuidance, /4 GiB model download/);
  await picker.selectProvider('other'); assert.equal(picker.localGuidance, '');
});
