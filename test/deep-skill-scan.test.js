import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deepScanSkill, deepScanSkillFiles, deepSkillScanOptions, normalizeSkillSpectorReport, compareSkillScanners, SKILL_SCAN_FIXTURES } from '../src/deep-skill-scan.js';

const validReport = () => ({
  issues: [], metadata: { skillspector_version: '2.12.0', llm_requested: false, llm_available: false },
  risk_assessment: { score: 0, severity: 'LOW', recommendation: 'SAFE' }, execution_successful: true,
  analysis_completeness: { is_complete: true, status: 'complete', coverage_percent: 100, execution_successful: true, fully_inspected_files: 1, partially_inspected_files: 0, entirely_uninspected_files: 0, ledger_exceptions: [], limitations: [], scope_exclusions: [] },
});
const files = SKILL_SCAN_FIXTURES[0].files;
async function workspace(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-deep-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function scanner(t, body) {
  const root = await workspace(t), command = path.join(root, 'scanner');
  // A fake executable exercises the process/report contract only. It is never
  // counted as live SkillSpector validation or included in benchmark results.
  await writeFile(command, `#!${process.execPath}\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst args = process.argv.slice(2); const reportFile = args[args.indexOf('--output') + 1];\n${body}\n`, { mode: 0o700 });
  return command;
}

test('deeper review requires explicit endpoint/model and isolated offline default', () => {
  assert.deepEqual(deepSkillScanOptions(), { command: null, network: false, llm: false, timeoutMs: 120000 });
  for (const bad of [{ command: 'skillspector' }, { timeoutMs: 0 }, { network: 'false' }, { provider: 'ollama' }, { llm: true }, { llm: true, network: true, provider: 'openai' }, { llm: true, network: true, provider: 'ollama', model: 'fixture', endpoint: 'http://example.invalid/v1' }, { llm: true, network: true, provider: 'ollama', model: 'fixture', endpoint: 'https://user:password@example.invalid/v1' }, { llm: true, network: true, provider: 'openai_compatible', model: 'fixture', endpoint: 'https://example.invalid/v1' }]) assert.throws(() => deepSkillScanOptions(bad));
  assert.equal(deepSkillScanOptions({ llm: true, network: true, provider: 'ollama', model: 'fixture', endpoint: 'http://127.0.0.1:11434/v1' }).endpoint, 'http://127.0.0.1:11434/v1');
});

test('report normalization preserves findings while refusing clean incomplete outcomes', () => {
  assert.equal(normalizeSkillSpectorReport(validReport()).status, 'completed');
  for (const mutate of [r => delete r.analysis_completeness, r => r.execution_successful = false, r => r.analysis_completeness.coverage_percent = 99, r => r.analysis_completeness.entirely_uninspected_files = 1, r => r.analysis_completeness.limitations.push('timeout'), r => r.analysis_completeness.fully_inspected_files = 'unknown', r => r.metadata.llm_requested = true]) {
    const report = validReport(); mutate(report); const result = normalizeSkillSpectorReport(report);
    assert.equal(result.status, 'incomplete'); assert.equal(result.verdict, 'incomplete-review');
  }
  assert.equal(normalizeSkillSpectorReport(validReport(), { exitCode: 2 }).coverage.complete, false);
  assert.equal(normalizeSkillSpectorReport(validReport(), { llm: true }).coverage.complete, false);
  const report = validReport(); report.issues.push({ id: 'E1', severity: 'HIGH', location: { file: 'helper.py', start_line: 4 }, explanation: 'A synthetic transfer indicator.' });
  const risky = normalizeSkillSpectorReport(report, { exitCode: 1 });
  assert.equal(risky.status, 'completed'); assert.equal(risky.verdict, 'high-risk-indicators'); assert.equal(risky.findings[0].line, 4); assert.equal(risky.counts.high, 1);
  report.analysis_completeness.is_complete = false;
  assert.equal(normalizeSkillSpectorReport(report).verdict, 'high-risk-indicators');
  report.issues[0].severity = 'UNKNOWN'; assert.throws(() => normalizeSkillSpectorReport(report), /Malformed/);
});

test('finding cap never hides incomplete coverage or total severity counts', () => {
  const report = validReport(); report.issues = Array.from({ length: 501 }, () => ({ id: 'P1', severity: 'HIGH', location: { file: 'SKILL.md', start_line: 1 } }));
  const result = normalizeSkillSpectorReport(report);
  assert.equal(result.findings.length, 500); assert.equal(result.counts.high, 501); assert.equal(result.coverage.findingsTruncated, true); assert.equal(result.coverage.complete, false);
});

test('missing scanner remains unavailable alongside a real native scan', async () => {
  const result = await deepScanSkillFiles(SKILL_SCAN_FIXTURES[2].files);
  assert.equal(result.native.verdict, 'high-risk-indicators'); assert.equal(result.deeper.status, 'unavailable'); assert.match(result.digest, /^[a-f0-9]{64}$/);
  const missing = await deepScanSkillFiles(files, { command: '/nonexistent/nexus-skillspector', network: true });
  assert.equal(missing.deeper.status, 'unavailable');
});

test('unsafe stored resource paths and malformed resource data are rejected before launch', async () => {
  for (const bad of [{ ...files, '../outside.py': '' }, { ...files, '/outside.py': '' }, { ...files, 'scripts\\outside.py': '' }, { ...files, '.git/config': '' }, { ...files, 'bad.py': 'not base64' }]) await assert.rejects(deepScanSkillFiles(bad));
  await assert.rejects(deepScanSkillFiles({ 'SKILL.md': Buffer.from('No frontmatter').toString('base64') }), /frontmatter/);
});

test('directory entry point uses existing symlink and input validation', async t => {
  const root = await workspace(t); await writeFile(path.join(root, 'SKILL.md'), Buffer.from(files['SKILL.md'], 'base64'));
  assert.equal((await deepScanSkill(root)).deeper.status, 'unavailable');
  await symlink(path.join(root, 'SKILL.md'), path.join(root, 'linked.txt'));
  await assert.rejects(deepScanSkill(root), /symlinks/);
});

test('process adapter scans a private snapshot with bounded report and stripped environment', async t => {
  const command = await scanner(t, `
    if (!args.includes('--no-llm') || !args.includes('--fail-on-incomplete')) throw Error('Missing safety flags');
    if (process.env.OPENAI_API_KEY || process.env.AWS_ACCESS_KEY_ID || process.env.PYTHONPATH) throw Error('Parent environment leaked');
    if (process.env.HOME !== path.join(process.cwd(), 'home')) throw Error('HOME not private');
    if (fs.statSync(args[1]).mode & 0o077) throw Error('Input not private');
    if (fs.statSync(path.join(args[1], 'SKILL.md')).mode & 0o111) throw Error('Resource executable');
    fs.writeFileSync(reportFile, JSON.stringify(${JSON.stringify(validReport())}));
    process.exitCode = 1;
  `);
  const result = await deepScanSkillFiles(files, { command, network: true });
  assert.equal(result.deeper.status, 'completed', JSON.stringify(result.deeper)); assert.equal(result.deeper.exitCode, 1);
  assert.equal(result.deeper.networkIsolation, 'explicitly-enabled');
});

test('offline macOS worker cannot open network sockets', { skip: process.platform !== 'darwin' }, async t => {
  const command = await scanner(t, `
    const net = await import('node:net');
    const socket = net.createConnection({ host: '127.0.0.1', port: 9 });
    socket.on('connect', () => { throw Error('Network unexpectedly available'); });
    socket.on('error', error => {
      if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
      fs.writeFileSync(reportFile, JSON.stringify(${JSON.stringify(validReport())}));
    });
  `);
  const result = await deepScanSkillFiles(files, { command });
  assert.equal(result.deeper.status, 'completed', JSON.stringify(result.deeper));
  assert.equal(result.deeper.networkIsolation, 'macos-deny-network');
});

test('timeouts, malformed reports and linked report files cannot become clean scans', async t => {
  const hung = await scanner(t, 'setTimeout(() => {}, 5000);');
  const timeout = await deepScanSkillFiles(files, { command: hung, network: true, timeoutMs: 100 });
  assert.equal(timeout.deeper.stopped, 'timeout'); assert.equal(timeout.deeper.coverage.complete, false);
  const malformed = await scanner(t, 'fs.writeFileSync(reportFile, "not JSON");');
  assert.equal((await deepScanSkillFiles(files, { command: malformed, network: true })).deeper.status, 'incomplete');
  const linked = await scanner(t, `fs.writeFileSync(path.join(process.cwd(), 'other.json'), JSON.stringify(${JSON.stringify(validReport())})); fs.symlinkSync(path.join(process.cwd(), 'other.json'), reportFile);`);
  assert.equal((await deepScanSkillFiles(files, { command: linked, network: true })).deeper.status, 'incomplete');
});

test('model credentials are explicit and redacted in returned reports', async t => {
  const key = 'NEXUS_TEST_SKILL_REVIEW_KEY', value = 'tinykey';
  const previous = process.env[key]; process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const report = validReport(); Object.assign(report.metadata, { llm_requested: true, llm_available: true });
  const command = await scanner(t, `
    if (args.includes('--no-llm') || process.env.SKILLSPECTOR_PROVIDER !== 'openai_compatible' || !process.env.SKILLSPECTOR_COMPAT_API_KEY) throw Error('Explicit configuration missing');
    const report = ${JSON.stringify(report)}; report.metadata.probe = process.env.SKILLSPECTOR_COMPAT_API_KEY;
    fs.writeFileSync(reportFile, JSON.stringify(report));
  `);
  const result = await deepScanSkillFiles(files, { command, network: true, llm: true, provider: 'openai_compatible', model: 'fixture-model', endpoint: 'https://example.invalid/v1', apiKeyEnv: key });
  assert.equal(result.deeper.status, 'completed', JSON.stringify(result)); assert.equal(result.deeper.report.metadata.probe, '[REDACTED]'); assert.ok(!JSON.stringify(result).includes(value));
});

test('shared synthetic comparison honestly records optional backend unavailability and native limitations', async () => {
  const result = await compareSkillScanners();
  assert.equal(result.synthetic, true); assert.equal(result.scriptsExecuted, false); assert.equal(result.cases.length, 6);
  assert.deepEqual(result.summary.native, { truePositive: 2, falsePositive: 1, trueNegative: 1, falseNegative: 2, incomplete: 0 });
  assert.deepEqual(result.summary.deeper, { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0, incomplete: 6 });
  assert.match(result.note, /not a representative security benchmark/);
});
