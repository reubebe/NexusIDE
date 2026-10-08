export function validateEmbedding(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(k => !['model', 'url'].includes(k)) || typeof config.model !== 'string' || !config.model.trim()) throw new Error('Embedding configuration requires model and a local Ollama embed URL.');
  const url = new URL(config.url);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/api/embed' || url.username || url.password || url.search || url.hash) throw new Error('Embeddings must use a local HTTP /api/embed endpoint.');
  return config;
}
