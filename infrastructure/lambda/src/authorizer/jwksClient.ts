import * as https from 'https';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';

interface JwkKey { kid: string; kty: string; n: string; e: string; }
interface JwksResponse { keys: JwkKey[]; }
interface CachedJwks { keys: JwkKey[]; fetchedAt: number; }

let jwksCache: CachedJwks | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000;
const COGNITO_REGION = process.env['COGNITO_REGION'] ?? 'us-east-1';
const USER_POOL_ID = process.env['USER_POOL_ID'] ?? '';

function fetchJwks(url: string): Promise<JwksResponse> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data) as JwksResponse); } catch { reject(new Error('Failed to parse JWKS')); } });
    }).on('error', reject);
  });
}

async function getJwks(): Promise<JwkKey[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < CACHE_TTL_MS) return jwksCache.keys;
  const url = 'https://cognito-idp.' + COGNITO_REGION + '.amazonaws.com/' + USER_POOL_ID + '/.well-known/jwks.json';
  const response = await fetchJwks(url);
  jwksCache = { keys: response.keys, fetchedAt: now };
  return response.keys;
}

function jwkToPem(jwk: JwkKey): string {
  // Use type assertion to bypass incomplete Node typings for JWK format
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keyObject = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e } as any, format: 'jwk' });
  return keyObject.export({ type: 'spki', format: 'pem' }) as string;
}

export async function getPublicKey(kid: string): Promise<string> {
  const keys = await getJwks();
  const key = keys.find((k) => k.kid === kid);
  if (!key) throw new Error('Public key not found for kid: ' + kid);
  return jwkToPem(key);
}

export function decodeTokenHeader(token: string): { kid: string; alg: string } {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string' || !decoded.header) throw new Error('Invalid token structure');
  return decoded.header as { kid: string; alg: string };
}

export function invalidateJwksCache(): void { jwksCache = null; }
