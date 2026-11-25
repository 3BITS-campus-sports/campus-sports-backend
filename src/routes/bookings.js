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
const MAX_EQUIPMENT_QUANTITY = 10;

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

// Validare date rezervare (KAN-30)
function validateBookingBody(body) {
  const errors = [];
  const { facilityId, bookingDate, startTime, endTime, seats, equipment } = body;

  const fid = Number(facilityId);
  if (!facilityId || !Number.isInteger(fid) || fid <= 0) {
    errors.push('Id-ul facilității este obligatoriu și trebuie să fie un număr pozitiv.');
  }
  if (!bookingDate && (!startTime || typeof startTime !== 'string' || !startTime.includes('T'))) {
    errors.push('Data rezervării este obligatorie (format AAAA-LL-ZZ).');
  }
  if (!startTime || typeof startTime !== 'string') {
    errors.push('Ora de început este obligatorie.');
  }
  if (!endTime || typeof endTime !== 'string') {
    errors.push('Ora de sfârșit este obligatorie.');
  }
  if (seats !== undefined && (!Number.isInteger(Number(seats)) || Number(seats) < 1)) {
    errors.push('Numărul de locuri rezervate trebuie să fie cel puțin 1.');
  }
  // Echipament inchiriat (KAN-71): [{ equipmentId, quantity }], cantitate intre 1 si 10
  if (equipment !== undefined) {
    const validItem = (item) => item && Number.isInteger(item.equipmentId) && item.equipmentId > 0 &&
      Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= MAX_EQUIPMENT_QUANTITY;
    if (!Array.isArray(equipment) || !equipment.every(validItem)) {
      errors.push(`Echipamentul trebuie trimis ca listă de { equipmentId, quantity }, cu cantitatea între 1 și ${MAX_EQUIPMENT_QUANTITY}.`);
    } else if (new Set(equipment.map((item) => item.equipmentId)).size !== equipment.length) {
      errors.push('Fiecare echipament poate apărea o singură dată în listă.');
    }
  }
  return errors;
}

// =========================================================================
// 1. GET /api/v1/bookings/my-bookings - Lista rezervărilor utilizatorului (KAN-59)
// =========================================================================
router.get('/my-bookings', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { scope } = req.query;

    let filterScope = '';
    if (scope === 'upcoming') {
      filterScope = 'AND is_upcoming = TRUE';
    } else if (scope === 'history') {
      filterScope = 'AND is_upcoming = FALSE';
    }

    const [bookings] = await sequelize.query(
      `SELECT * FROM v_booking_details 
       WHERE user_id = :userId ${filterScope} 
       ORDER BY start_time ${scope === 'history' ? 'DESC' : 'ASC'}`,
      { replacements: { userId } }
    );

    res.json(bookings);
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// 2. GET /api/v1/bookings/:id - Detalii rezervare cu echipamente incluse (KAN-59)
// =========================================================================
router.get('/:id', requireAuth, async (req, res, next) => {
  const bookingId = parseBookingId(req.params.id);
  if (!bookingId) {
    return sendError(res, 400, 'VALIDATION', 'Id-ul rezervării nu este valid.');
  }

  try {
    const [[booking]] = await sequelize.query(
      'SELECT * FROM v_booking_details WHERE booking_id = :id',
      { replacements: { id: bookingId } }
    );

    if (!booking) {
      return sendError(res, 404, 'NOT_FOUND', 'Rezervarea nu a fost găsită.');
    }

    if (Number(booking.user_id) !== Number(req.user.id) && req.user.role !== 'ADMIN') {
      return sendError(res, 403, 'FORBIDDEN', 'Nu ai permisiunea de a vizualiza rezervarea altui utilizator.');
    }

    // Tabelul din schema se numeste equipment (pret pe ora: hourly_fee); cost = costul calculat de trigger
    const [equipment] = await sequelize.query(
      `SELECT be.equipment_id AS "equipmentId", e.name, be.quantity,
              e.hourly_fee AS "hourlyFee", be.cost
       FROM booking_equipment be
       JOIN equipment e ON e.equipment_id = be.equipment_id
       WHERE be.booking_id = :id
       ORDER BY be.equipment_id`,
      { replacements: { id: bookingId } }
    );

    res.json({
      ...booking,
      equipment: equipment || []
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// 3. POST /api/v1/bookings - Creare rezervare nouă cu salvare în PostgreSQL (KAN-30)
// =========================================================================
router.post('/', requireAuth, async (req, res, next) => {
  const validationErrors = validateBookingBody(req.body ?? {});
  if (validationErrors.length > 0) {
    return sendError(res, 400, 'VALIDATION', validationErrors.join(' '));
  }

  try {
    const { facilityId, bookingDate, startTime, endTime, seats, reminderEnabled, equipment } = req.body;
    const userId = req.user?.id || 1;

    const bookingId = await sequelize.transaction(async (t) => {
      const isIso = typeof startTime === 'string' && startTime.includes('T');
      const startExpr = isIso 
        ? 'CAST(:start AS timestamptz)' 
        : "(CAST(:d AS date) + CAST(:s AS time)) AT TIME ZONE 'Europe/Bucharest'";
      const endExpr = isIso 
        ? 'CAST(:end AS timestamptz)' 
        : "(CAST(:d AS date) + CAST(:e AS time)) AT TIME ZONE 'Europe/Bucharest'";

      const [[{ booking_id }]] = await sequelize.query(
        `SELECT create_booking(:u, :f, ${startExpr}, ${endExpr}, :seats, :rem) AS booking_id`,
        {
          transaction: t,
          replacements: {
            u: userId,
            f: Number(facilityId),
            d: bookingDate || null,
            s: isIso ? null : startTime,
            e: isIso ? null : endTime,
            start: isIso ? startTime : null,
            end: isIso ? endTime : null,
            seats: seats ? Number(seats) : 1,
            rem: reminderEnabled ?? true,
          },
        }
      );

      // Echipamentul trebuie sa fie pentru sportul facilitatii (ex. ochelari de inot doar la bazin).
      // Triggerul trg_booking_equipment_bi verifica stocul si adauga costul la totalul rezervarii.
      for (const eq of equipment ?? []) {
        const [[match]] = await sequelize.query(
          `SELECT e.equipment_id FROM equipment e
             JOIN sport_facilities f ON f.sport_type = e.sport_category
            WHERE e.equipment_id = :e AND f.facility_id = :f`,
          { transaction: t, replacements: { e: eq.equipmentId, f: Number(facilityId) } }
        );
        if (!match) {
          throw Object.assign(new Error('Echipament nepotrivit'), { equipmentMismatch: eq.equipmentId });
        }
        await sequelize.query(
          'INSERT INTO booking_equipment (booking_id, equipment_id, quantity) VALUES (:b, :e, :q)',
          {
            transaction: t,
            replacements: { b: booking_id, e: eq.equipmentId, q: eq.quantity },
          }
        );
      }
      return booking_id;
    });

    const [[booking]] = await sequelize.query(
      'SELECT * FROM v_booking_details WHERE booking_id = :id',
      { replacements: { id: bookingId } }
    );

    res.status(201).json(booking);
  } catch (e) {
    if (e.equipmentMismatch) {
      return sendError(res, 400, 'VALIDATION',
        `Echipamentul ${e.equipmentMismatch} nu există sau nu este pentru această facilitate.`);
    }
    next(e);
  }
});

// =========================================================================
// 4. POST /api/v1/bookings/:id/pay - Plată simulată și confirmare cod QR (KAN-53)
// =========================================================================
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
      const [[booking]] = await sequelize.query(
        'SELECT user_id, total_amount FROM bookings WHERE booking_id = :id FOR UPDATE',
        { transaction: t, replacements: { id: bookingId } });
      if (!booking) return { status: 404 };
      if (Number(booking.user_id) !== Number(req.user.id)) return { status: 403 };

      const amount = Number(booking.total_amount);
      if (amount === 0) {
        await sequelize.query('SELECT confirm_free_booking(:id)',
          { transaction: t, replacements: { id: bookingId } });
        await setEncryptedQrToken(bookingId, t);
        return { status: 200, paymentRequired: false, transactionRef: null, amount };
      }

      const transactionRef = `SIM-${crypto.randomUUID()}`;
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
      clientSecret: null,
      amount: outcome.amount,
      currency: CURRENCY,
      booking,
    };

    if (outcome.status === 402) {
      return res.status(402).json({
        error: { code: 'PAYMENT_FAILED', message: 'Plata a fost refuzată. Poți reîncerca până expiră rezervarea.' },
        ...session,
      });
    }
    res.json(session);
  } catch (e) { next(e); }
});

// =========================================================================
// 5. POST /api/v1/bookings/:id/cancel - Anulare rezervare (KAN-60, KAN-61)
// =========================================================================
router.post('/:id/cancel', requireAuth, async (req, res, next) => {
  const bookingId = parseBookingId(req.params.id);
  if (!bookingId) {
    return sendError(res, 400, 'VALIDATION', 'Id-ul rezervării nu este valid.');
  }

  const userId = req.user.id;
  const { reason } = req.body ?? {};

  try {
    await sequelize.query(
      'SELECT cancel_booking(:bookingId, :userId)',
      { replacements: { bookingId, userId } }
    );

    const [[updatedBooking]] = await sequelize.query(
      'SELECT * FROM v_booking_details WHERE booking_id = :id',
      { replacements: { id: bookingId } }
    );

    res.json({
      message: 'Rezervarea a fost anulată cu succes. Intervalul orar a fost eliberat.',
      reason: reason || 'Anulare la cererea utilizatorului',
      booking: updatedBooking
    });
  } catch (err) {
    const msg = err.original?.message || err.message || '';
    const code = err.original?.code || '';

    // Gestionare erori specifice procedurii PostgreSQL (KAN-61)
    if (code === 'SB404' || msg.includes('nu exista')) {
      return sendError(res, 404, 'NOT_FOUND', 'Rezervarea specificată nu există.');
    }
    if (code === 'SB403' || msg.includes('altui utilizator')) {
      return sendError(res, 403, 'FORBIDDEN', 'Nu poți anula rezervarea altui utilizator.');
    }
    // Ambele erori de mai jos au codul SB400 in cancel_booking, deci le deosebim dupa text (KAN-72)
    if (msg.includes('nu mai poate fi anulata')) {
      return sendError(res, 400, 'CANCEL_NOT_ALLOWED', 'Rezervarea nu mai poate fi anulată (deja finalizată sau anulată).');
    }
    if (msg.includes('minimum 24 de ore')) {
      return sendError(res, 400, 'CANCEL_TOO_LATE', 'Anularea este posibilă doar cu minimum 24 de ore înainte de oră.');
    }

    next(err);
  }
});

module.exports = router;
