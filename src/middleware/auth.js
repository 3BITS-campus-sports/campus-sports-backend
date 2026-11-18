const jwt = require('jsonwebtoken');

// Middleware autentificare pentru dezvoltare & testare:
// 1. Daca exista token Bearer in header, il valideaza cu JWT_SECRET
// 2. Daca nu exista token, foloseste utilizatorul implicit (Cosmin / user_id: 1) pentru a permite testarea facila la laborator
module.exports = function auth(req, res, next) {
  const authHeader = req.headers['authorization'];
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_usv_2026');
      req.user = decoded;
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'Token invalid sau expirat' });
    }
  }

  // Fallback utilizator test pentru laborator (Student ID 1 - Cosmin Flocea)
  req.user = {
    id: 1,
    role: 'STUDENT',
    email: 'cosmin.flocea@student.ro'
  };
  
  next();
};
