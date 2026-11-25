const router = require('express').Router();
const sequelize = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { readQrToken } = require('../services/qrToken');

function sendError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

/**
 * POST /api/v1/qr/validate - Validare bilet electronic la receptie (KAN-33)
 * Receptionerul scaneaza codul QR prezentat de student/utilizator.
 * Endpoint-ul decripteaza tokenul AES-256-GCM si apeleaza procedura SQL validate_qr().
 */
router.post('/validate', requireAuth, requireRole(['RECEPTIONIST', 'ADMIN']), async (req, res, next) => {
  const { token, payload } = req.body ?? {};
  const qrString = token || payload;

  if (!qrString || typeof qrString !== 'string' || qrString.trim() === '') {
    return sendError(res, 400, 'VALIDATION', 'Codul QR (token) este obligatoriu.');
  }

  const cleanToken = qrString.trim();

  // 1. Verificare integritate token criptat AES-256-GCM
  const tokenData = readQrToken(cleanToken);
  if (!tokenData) {
    return sendError(res, 400, 'VALIDATION', 'Codul QR este invalid, corupt sau a fost modificat neautorizat.');
  }

  // 2. Receptionerul este utilizatorul autentificat (requireRole a verificat deja ca e RECEPTIONIST sau ADMIN)
  const receptionistId = req.user.id;

  try {
    // 3. Apel procedura validate_qr din PostgreSQL
    // Valideaza starea rezervarii, fereastra de acces (cu 15 min inainte de start) si actualizeaza statusul la CHECKED_IN
    const [rows] = await sequelize.query(
      `SELECT * FROM validate_qr(:payload, :receptionistId, now())`,
      {
        replacements: {
          payload: cleanToken,
          receptionistId,
        },
      }
    );

    if (!rows || rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Biletul nu a putut fi gasit sau codul QR este invalid.');
    }

    const result = rows[0];

    return res.json({
      success: true,
      message: 'Acces permis! Biletul a fost validat cu succes la receptie.',
      data: {
        bookingId: result.o_booking_id,
        userName: result.o_user_name,
        roleType: result.o_role_type,
        facilityName: result.o_facility_name,
        startTime: result.o_start_time,
        endTime: result.o_end_time,
        seats: result.o_seats,
        checkedInAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    // Tratare erori specifice ridicate de schema SQL (validate_qr)
    const msg = err.original?.message || err.message || '';
    if (msg.includes('deja folosit') || msg.includes('deja scanat')) {
      return sendError(res, 409, 'ALREADY_SCANNED', 'Acest cod QR a fost deja scanat și utilizat anterior.');
    }
    if (msg.includes('afara intervalului')) {
      return sendError(res, 403, 'TIME_MISMATCH', 'Acces respins: Biletul este valid doar în intervalul orar rezervat (cu maxim 15 minute înainte de începere).');
    }
    if (msg.includes('anulata') || msg.includes('invalidat')) {
      return sendError(res, 403, 'CANCELLED_BOOKING', 'Bilet invalid: Rezervarea a fost anulată sau expirată.');
    }
    if (msg.includes('Doar personalul de la receptie')) {
      return sendError(res, 403, 'FORBIDDEN', 'Acces interzis: Doar personalul de recepție autorizat poate valida coduri QR.');
    }
    if (msg.includes('necunoscut') || err.original?.code === 'SB404') {
      return sendError(res, 404, 'NOT_FOUND', 'Cod QR necunoscut în sistem.');
    }

    next(err);
  }
});

module.exports = router;
