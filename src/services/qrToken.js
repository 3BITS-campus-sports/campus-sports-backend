// Tokenul din codul QR al unei rezervari confirmate (KAN-32).
// Continutul ({ rezervare, momentul emiterii }) e criptat cu AES-256-GCM: nu poate fi citit
// si nu poate fi modificat fara cheie, iar un token inventat este respins inainte de baza de date.
// Imaginea QR se deseneaza in interfata (KAN-54) din acest token.
const crypto = require('crypto');
const jwtConfig = require('../config/jwt');

const PREFIX = 'CSB1.';
const IV_BYTES = 12;
const TAG_BYTES = 16;

// Cheie separata pentru QR, derivata din JWT_SECRET (HKDF): nu e nevoie de o variabila noua in .env,
// iar cheia de semnare a tokenurilor de autentificare nu este folosita direct si pentru coduri QR
const KEY = Buffer.from(crypto.hkdfSync('sha256', jwtConfig.secret, 'campus-sports', 'qr-code-v1', 32));

/**
 * Creeaza tokenul pentru codul QR al unei rezervari.
 * @param {number} bookingId Id-ul rezervarii confirmate.
 * @param {Date=} now Momentul emiterii (parametru pentru teste).
 * @return {string} Tokenul, de forma CSB1.<date criptate, base64url>.
 */
function createQrToken(bookingId, now = new Date()) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const plain = JSON.stringify({ b: bookingId, t: Math.floor(now.getTime() / 1000) });
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url');
}

/**
 * Decripteaza un token QR (de folosit la receptie, inainte de validate_qr).
 * @param {string} token Textul citit din codul QR.
 * @return {?{bookingId: number, issuedAt: Date}} Datele tokenului, sau null daca este invalid sau modificat.
 */
function readQrToken(token) {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return null;
  const raw = Buffer.from(token.slice(PREFIX.length), 'base64url');
  if (raw.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)),
      decipher.final(),   // arunca eroare daca tokenul a fost modificat
    ]).toString('utf8');
    const data = JSON.parse(plain);
    if (!Number.isSafeInteger(data.b) || data.b <= 0 || !Number.isSafeInteger(data.t)) return null;
    return { bookingId: data.b, issuedAt: new Date(data.t * 1000) };
  } catch {
    return null;
  }
}

module.exports = { createQrToken, readQrToken };
