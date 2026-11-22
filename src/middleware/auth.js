const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwt');

// Middleware autentificare:
// 1. Daca exista token Bearer in header, il valideaza cu JWT_SECRET
// 2. Daca nu exista token si este cerere protejata de requireAuth -> 401 UNAUTHORIZED
// 3. Fallback doar in modul dev cand este activata explicit variabila ALLOW_DEV_FALLBACK
function auth(req, res, next) {
  const authHeader = req.headers['authorization'];
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, jwtConfig.secret);
      req.user = decoded;
      return next();
    } catch (err) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Token invalid sau expirat. Autentifică-te din nou.' }
      });
    }
  }

  // Permite fallback doar in dezvoltare cand este cerut explicit
  if (process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_FALLBACK === 'true') {
    req.user = {
      id: 1,
      role: 'STUDENT',
      email: 'cosmin.flocea@student.usv.ro'
    };
    return next();
  }

  // Fara token, utilizatorul este null (rutele protejate cu requireAuth vor respinge cererea)
  req.user = null;
  next();
}

// Cerere stricta de token (blocheaza cererile fara token valid)
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Autentificare necesară. Token-ul JWT lipsește.' }
    });
  }
  return auth(req, res, () => {
    if (!req.user) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Autentificare necesară. Token-ul JWT lipsește sau este invalid.' }
      });
    }
    next();
  });
}

// Verificare roluri permise (de ex. ['RECEPTIONIST', 'ADMIN'])
function requireRole(roles = []) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Autentificare necesară.' }
      });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Nu ai permisiunea necesară pentru această operațiune.' }
      });
    }
    next();
  };
}

module.exports = auth;
module.exports.auth = auth;
module.exports.requireAuth = requireAuth;
module.exports.requireRole = requireRole;
