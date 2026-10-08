export const protectedNames = new Set(['.git', '.nexus', '.research', '.ssh', '.aws', '.gnupg', '.netrc', '.npmrc', '.pypirc', 'id_rsa', 'id_ed25519', 'node_modules']);
export function protectedName(name) { return protectedNames.has(name) || name.startsWith('.env'); }
