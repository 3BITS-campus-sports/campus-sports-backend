const express = require('express');
const cors = require('cors');
const { dbErrorHandler } = require('./middleware/errors');

const app = express();

// Permite apelurile din Frontend (Vite ruleaza pe http://localhost:3000 sau 5173)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Rute API
app.use('/api/v1/auth', require('./routes/auth'));
app.use('/api/v1/facilities', require('./routes/facilities'));
app.use('/api/v1/users', require('./routes/users'));
app.use('/api/v1/bookings', require('./routes/bookings'));
app.use('/api/v1/qr', require('./routes/qr'));

// Endpoint de stare/healthcheck
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Campus Sports API este operational', timestamp: new Date() });
});

// Middleware centralizat pentru erori de baza de date
app.use(dbErrorHandler);

module.exports = app;
