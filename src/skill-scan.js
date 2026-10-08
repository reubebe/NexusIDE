// Conservative static indicators. Findings guide review; they do not prove malware.
const rules = [
  { id: 'download-and-run', severity: 'high', title: 'Downloads and immediately executes a remote script', pattern: /\b(?:curl|wget)\b[^\n]{0,240}\|\s*(?:sh|bash|zsh)\b/gi },
  { id: 'embedded-credential', severity: 'high', title: 'Contains a credential-shaped token', pattern: /\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g },
  { id: 'instruction-override', severity: 'high', title: 'Contains instructions to override higher-priority instructions', pattern: /\bignore\s+(?:all\s+)?(?:previous|prior|system|developer)\s+(?:instructions|messages)\b/gi },
  { id: 'destructive-command', severity: 'high', title: 'Contains a destructive shell command pattern', pattern: /\brm\s+(?:-[rRfF]+\s+)+(?:--\s+)?["']?(?:\/|~(?:\/|(?=\s|$)))|\b(?:mkfs(?:\.[\w-]+)?\b|dd\s+if=\S+\s+of=\/dev\/|chmod\s+-R\s+777\b)/gi },
  { id: 'credential-access', severity: 'medium', title: 'References common credential stores or files', pattern: /(?:\.ssh\/|\.aws\/credentials|\.env(?:\b|\.)|id_rsa\b|id_ed25519\b|keychain\s+(?:dump|export))/gi },
  { id: 'network-transfer', severity: 'medium', title: 'Contains code or commands that can send data over a network', pattern: /\b(?:requests\.post|httpx\.post|fetch\s*\(|axios\.(?:post|put)|curl\b[^\n]{0,240}(?:--data|-X\s*POST))/gi },
  { id: 'dynamic-code', severity: 'medium', title: 'Uses dynamic code evaluation', pattern: /\beval\s*\(|\bnew\s+Function\s*\(/g },
];

export function scanSkillFiles(files) {
  const findings = [], skipped = [];
  const entries = Object.entries(files);
  let inspectedFiles = 0, visitedFiles = 0, truncated = false;
  for (const [file, encoded] of entries) {
    visitedFiles++;
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.includes(0)) { skipped.push({ file, reason: 'binary' }); continue; }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) { skipped.push({ file, reason: 'non-UTF-8' }); continue; }
    inspectedFiles++;
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      let cursor = 0, lineNumber = 1;
      for (const match of text.matchAll(rule.pattern)) {
        lineNumber += (text.slice(cursor, match.index).match(/\n/g) || []).length;
        cursor = match.index;
        findings.push({ file, line: lineNumber, rule: rule.id, severity: rule.severity, title: rule.title });
        if (findings.length >= 500) break;
      }
      if (findings.length >= 500) break;
    }
    if (findings.length >= 500) { truncated = true; break; }
  }
  const counts = Object.fromEntries(['high', 'medium', 'low'].map(level => [level, findings.filter(item => item.severity === level).length]));
  const complete = !truncated && skipped.length === 0;
  return { engine: 'nexus-static-v2', verdict: counts.high ? 'high-risk-indicators' : counts.medium ? 'review-recommended' : complete ? 'no-known-indicators' : 'incomplete-review', counts, findings, coverage: { totalFiles: entries.length, inspectedFiles, skipped, unvisitedFiles: entries.length - visitedFiles, truncated, complete }, limits: { findings: 500 }, note: 'Static indicators only. A clean result does not establish that a skill is safe. Binary and non-UTF-8 resources require separate review.' };
}
