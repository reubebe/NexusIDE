export function redactor(extra = [], env = process.env) {
  const secrets = [...new Set([...extra, ...Object.entries(env).filter(([key]) => /(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(key)).map(([, value]) => value)].filter(v => typeof v === 'string' && v.length >= 8))].sort((a, b) => b.length - a.length);
  const text = value => secrets.reduce((out, secret) => out.split(secret).join('[REDACTED]'), value);
  function redact(value) {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
    return value;
  }
  return redact;
}
