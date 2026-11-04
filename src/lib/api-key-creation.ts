export type ApiKeyCreation = 'deny' | 'allow';

export function parseApiKeyCreation(value?: string): ApiKeyCreation {
  const normalized = (value ?? '').trim() || 'allow';
  if (normalized === 'deny' || normalized === 'allow') return normalized;
  throw new Error('Unsupported api-key-creation policy; expected deny or allow.');
}

/** Guard the mutation itself, independently of orchestration and preflight. */
export function assertApiKeyCreationAllowed(value?: string): void {
  if (parseApiKeyCreation(value) !== 'allow') {
    throw new Error('API_KEY_CREATION_DENIED: supply a valid postman-api-key; automatic key creation is disabled.');
  }
}
