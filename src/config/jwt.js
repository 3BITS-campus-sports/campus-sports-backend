// Setarile pentru tokenurile JWT, folosite si la semnare (/auth/login),
// si la verificare (middleware/auth.js). Secretul vine din .env, nu din cod.
const secret = process.env.JWT_SECRET;

if (!secret) {
  throw new Error('Lipseste JWT_SECRET din fisierul .env (vezi .env.example).');
}

module.exports = {
  secret,
  // Cat timp ramane valid un token dupa autentificare
  expiresIn: process.env.JWT_EXPIRES_IN || '8h',
};
