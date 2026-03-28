import { X509Certificate, createPrivateKey } from 'node:crypto';

function decodeBase64Pem(value: string, label: string): Buffer {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }

  const sanitized = normalized.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(sanitized) || sanitized.length % 4 !== 0) {
    throw new Error(`${label} must be valid base64`);
  }

  const decoded = Buffer.from(sanitized, 'base64');
  if (decoded.length === 0) {
    throw new Error(`${label} must decode to non-empty PEM content`);
  }

  const normalizedInput = sanitized.replace(/=+$/u, '');
  const normalizedDecoded = decoded.toString('base64').replace(/=+$/u, '');
  if (normalizedInput !== normalizedDecoded) {
    throw new Error(`${label} must be valid base64`);
  }

  return decoded;
}

export function validateCertMaterial(
  certBase64: string,
  keyBase64: string,
  passphrase?: string
): void {
  const certBuffer = decodeBase64Pem(certBase64, 'ssl-client-cert');
  const keyBuffer = decodeBase64Pem(keyBase64, 'ssl-client-key');

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certBuffer);
  } catch (error) {
    throw new Error(
      `Invalid client certificate: ${error instanceof Error ? error.message : String(error)}`
      , { cause: error }
    );
  }

  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey({
      key: keyBuffer,
      passphrase,
      format: 'pem'
    });
  } catch (error) {
    throw new Error(
      `Invalid client key (wrong passphrase?): ${error instanceof Error ? error.message : String(error)}`
      , { cause: error }
    );
  }

  if (!certificate.checkPrivateKey(privateKey)) {
    throw new Error('Client certificate and private key do not match');
  }
}
