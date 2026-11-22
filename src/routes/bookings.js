const crypto = require('crypto');
const router = require('express').Router();
const sequelize = require('../db');
const { auth, requireAuth } = require('../middleware/auth');
const { createQrToken } = require('../services/qrToken');

// Plata este simulata (MVP demonstrativ, ecranul 06): nu exista procesator real,
// rezultatul platii vine din campul simulateResult trimis de interfata.
const PAYMENT_METHODS = ['CARD_ONLINE', 'APPLE_PAY', 'GOOGLE_PAY'];
const SIMULATED_RESULTS = ['SUCCESS', 'FAILED'];
const CURRENCY = 'RON';

function sendError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// fn_confirm_booking genereaza un cod QR provizoriu; il inlocuim cu tokenul criptat (KAN-32),
// in aceeasi tranzactie cu plata, ca rezervarea sa nu ramana niciodata confirmata cu codul provizoriu
async function setEncryptedQrToken(bookingId, transaction) {
  await sequelize.query('UPDATE qr_codes SET encrypted_payload = :token WHERE booking_id = :id', {
    transaction, replacements: { id: bookingId, token: createQrToken(bookingId) },
  });
}

function parseBookingId(value) {
  if (!/^\d+$/.test(String(value))) return null;
  const id = Number(value);
  return id > 0 && Number.isSafeInteger(id) ? id : null;
}

function validatePayBody(body) {
  const method = body.method ?? 'CARD_ONLINE';
  const simulateResult = body.simulateResult ?? 'SUCCESS';
  const errors = [];
  if (!PAYMENT_METHODS.includes(method)) {
    errors.push(`Metoda de plată trebuie să fie una dintre: ${PAYMENT_METHODS.join(', ')}.`);
  }
  if (!SIMULATED_RESULTS.includes(simulateResult)) {
    errors.push(`simulateResult trebuie să fie ${SIMULATED_RESULTS.join(' sau ')}.`);
  }
  return { errors, method, simulateResult };
}

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { facilityId, bookingDate, startTime, endTime, seats, reminderEnabled, equipment } = req.body;

    const bookingId = await sequelize.transaction(async (t) => {
      const [[{ booking_id }]] = await sequelize.query(
        `SELECT create_booking(:u, :f,
           (CAST(:d AS date) + CAST(:s AS time)) AT TIME ZONE 'Europe/Bucharest',
           (CAST(:d AS date) + CAST(:e AS time)) AT TIME ZONE 'Europe/Bucharest',
           :seats, :rem) AS booking_id`,
        { transaction: t,
          replacements: { u: req.user.id, f: facilityId, d: bookingDate, s: startTime, e: endTime,
                          seats: seats ?? 1, rem: reminderEnabled ?? true } });

      for (const eq of equipment ?? []) {
        await sequelize.query(
          'INSERT INTO booking_equipment (booking_id, equipment_id, quantity) VALUES (:b, :e, :q)',
          { transaction: t, replacements: { b: booking_id, e: eq.equipmentId, q: eq.quantity } });
      }
      return booking_id;
    });

    const [[booking]] = await sequelize.query(
      'SELECT * FROM v_booking_details WHERE booking_id = :id', { replacements: { id: bookingId } });
    res.status(201).json(booking);   // fără QR: qr_payload e NULL până la plată
  } catch (e) { next(e); }
});

// POST /bookings/:id/pay - plata simulata; la succes rezervarea devine CONFIRMED si primeste cod QR
router.post('/:id/pay', requireAuth, async (req, res, next) => {
  const bookingId = parseBookingId(req.params.id);
  if (!bookingId) {
    return sendError(res, 400, 'VALIDATION', 'Id-ul rezervării nu este valid.');
  }
  const { errors, method, simulateResult } = validatePayBody(req.body ?? {});
  if (errors.length > 0) {
    return sendError(res, 400, 'VALIDATION', errors.join(' '));
  }

  try {
    const outcome = await sequelize.transaction(async (t) => {
      // FOR UPDATE: doua cereri de plata pentru aceeasi rezervare se executa una dupa alta
      const [[booking]] = await sequelize.query(
        'SELECT user_id, total_amount FROM bookings WHERE booking_id = :id FOR UPDATE',
        { transaction: t, replacements: { id: bookingId } });
      if (!booking) return { status: 404 };
      if (Number(booking.user_id) !== Number(req.user.id)) return { status: 403 };

      const amount = Number(booking.total_amount);
      if (amount === 0) {
        // Acces gratuit: nu exista tranzactie, rezervarea se confirma direct (cu cod QR)
        await sequelize.query('SELECT confirm_free_booking(:id)',
          { transaction: t, replacements: { id: bookingId } });
        await setEncryptedQrToken(bookingId, t);
        return { status: 200, paymentRequired: false, transactionRef: null, amount };
      }

      const transactionRef = `SIM-${crypto.randomUUID()}`;
      // register_payment: tranzactie PENDING + rezultat; la succes apeleaza fn_confirm_booking (cod QR)
      await sequelize.query('SELECT register_payment(:id, :method, :ref, :success)', {
        transaction: t,
        replacements: { id: bookingId, method, ref: transactionRef, success: simulateResult === 'SUCCESS' },
      });
      if (simulateResult === 'FAILED') {
        return { status: 402, paymentRequired: true, transactionRef, amount };
      }
      await setEncryptedQrToken(bookingId, t);
      return { status: 200, paymentRequired: true, transactionRef, amount };
    });

    if (outcome.status === 404) {
      return sendError(res, 404, 'NOT_FOUND', 'Rezervarea nu există.');
    }
    if (outcome.status === 403) {
      return sendError(res, 403, 'FORBIDDEN', 'Poți plăti doar rezervările tale.');
    }

    const [[booking]] = await sequelize.query(
      'SELECT * FROM v_booking_details WHERE booking_id = :id', { replacements: { id: bookingId } });
    const session = {
      bookingId,
      paymentRequired: outcome.paymentRequired,
      transactionRef: outcome.transactionRef,
      clientSecret: null,   // exista doar la un procesator real (ex. Stripe)
      amount: outcome.amount,
      currency: CURRENCY,
      booking,
    };

    if (outcome.status === 402) {
      // Rezervarea ramane PENDING_PAYMENT: utilizatorul poate reincerca pana expira cele 5 minute
      return res.status(402).json({
        error: { code: 'PAYMENT_FAILED', message: 'Plata a fost refuzată. Poți reîncerca până expiră rezervarea.' },
        ...session,
      });
    }
    res.json(session);
  } catch (e) { next(e); }
});

module.exports = router;
