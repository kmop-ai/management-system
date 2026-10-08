// Passwords: PBKDF2-SHA256 via WebCrypto (no dependencies). 100 000
// iterations is the most the Workers runtime allows; the count is stored
// with each hash so it can change later.

const ITER = 100000;
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: b64(await derive(password, salt, ITER)), salt: b64(salt), iterations: ITER };
}

export async function verifyPassword(password, row) {
  const got = new Uint8Array(await derive(password, unb64(row.salt), row.iterations));
  const want = unb64(row.hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i]; // constant time
  return diff === 0;
}

// Easy to read aloud or type from a note: no 0/O, 1/l/I.
export function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const a = crypto.getRandomValues(new Uint8Array(10));
  const s = [...a].map(x => alphabet[x % alphabet.length]).join('');
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export const passwordLoginEnabled = (env) => env.LOCAL_MODE === '1' || env.PASSWORD_LOGIN === '1';

export function passwordProblem(p) {
  if (typeof p !== 'string' || p.length < 8) return 'must be at least 8 characters';
  if (p.length > 200) return 'is too long';
  return null;
}
