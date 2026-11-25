const router = require('express').Router();
const jwt = require('jsonwebtoken');
const sequelize = require('../db');
const jwtConfig = require('../config/jwt');
const {requireAuth, requireRole} = require('../middleware/auth');

// Adaugarea si modificarea facilitatilor sunt doar pentru administrator
const adminOnly = [requireAuth, requireRole(['ADMIN'])];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Verifica daca textul este o data reala in formatul AAAA-LL-ZZ (de ex. respinge 2026-02-30).
 * @param {*} value Valoarea primita in query.
 * @return {boolean}
 */
function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Ora locala (Romania) in formatul HH:MM, oricare ar fi fusul orar al serverului.
 * @param {!Date|string} timestamp Momentul primit din baza de date.
 * @return {string}
 */
function localTimeLabel(timestamp) {
  return new Date(timestamp).toLocaleTimeString('ro-RO', {
    timeZone: 'Europe/Bucharest', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/**
 * Id-ul utilizatorului din tokenul JWT, daca cererea are unul.
 * Disponibilitatea se poate vedea si fara cont; cu token, se marcheaza si
 * intervalele suprapuse cu rezervarile proprii.
 * @param {!Object} req Cererea Express.
 * @return {{userId: ?number, invalid: boolean}}
 */
function optionalUserId(req) {
  const header = req.headers.authorization;
  if (!header) {
    return {userId: null, invalid: false};
  }
  try {
    const decoded = jwt.verify(header.replace(/^Bearer\s+/i, ''), jwtConfig.secret);
    return {userId: decoded.id, invalid: false};
  } catch {
    return {userId: null, invalid: true};
  }
}

// GET /api/v1/facilities - Listare facilitati sportive din PostgreSQL
router.get('/', async (req, res, next) => {
  try {
    const [facilities] = await sequelize.query(`
      SELECT 
        f.facility_id,
        f.location_id,
        f.name,
        f.sport_type,
        f.category,
        f.booking_mode,
        f.capacity,
        f.base_price_per_hour,
        f.slot_minutes,
        f.has_lighting,
        f.is_active,
        f.opens_at,
        f.closes_at,
        l.building_name AS location_name,
        l.zone_name AS location_zone,
        l.address AS location_address,
        l.contact_phone
      FROM sport_facilities f
      LEFT JOIN campus_locations l ON f.location_id = l.location_id
      ORDER BY f.facility_id ASC
    `);
    res.json(facilities);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/facilities/locations - Listare locatii campus
router.get('/locations', async (req, res, next) => {
  try {
    const [locations] = await sequelize.query('SELECT * FROM campus_locations ORDER BY location_id ASC');
    res.json(locations);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/facilities/:id/availability?date=AAAA-LL-ZZ - Intervalele orare ale unei zile (KAN-25)
router.get('/:id/availability', async (req, res, next) => {
  const facilityId = Number(req.params.id);
  const {date} = req.query;

  if (!Number.isInteger(facilityId) || facilityId <= 0) {
    return res.status(400).json({
      error: {code: 'VALIDATION', message: 'Id-ul facilității trebuie să fie un număr întreg pozitiv.'},
    });
  }
  if (!isValidDate(date)) {
    return res.status(400).json({
      error: {code: 'VALIDATION', message: 'Parametrul date este obligatoriu, în formatul AAAA-LL-ZZ.'},
    });
  }

  const {userId, invalid} = optionalUserId(req);
  if (invalid) {
    return res.status(401).json({
      error: {code: 'UNAUTHORIZED', message: 'Token invalid sau expirat. Autentifică-te din nou.'},
    });
  }

  try {
    const [[facility]] = await sequelize.query(
      'SELECT facility_id, slot_minutes FROM sport_facilities WHERE facility_id = :facilityId AND is_active',
      {replacements: {facilityId}});
    if (!facility) {
      return res.status(404).json({
        error: {code: 'SB404', message: 'Facilitatea nu există sau nu este activă.'},
      });
    }

    // get_available_slots (schema SQL) calculeaza sloturile, locurile ramase si suprapunerile.
    // O zi in care facilitatea e inchisa intoarce o lista goala (ecranul 05b din Figma).
    const [slots] = await sequelize.query(`
      SELECT slot_start, slot_end, capacity, seats_left, is_free, overlaps_own_booking
        FROM get_available_slots(:facilityId, CAST(:date AS date), :userId)
    `, {replacements: {facilityId, date, userId}});

    res.json({
      facilityId,
      date,
      slotMinutes: facility.slot_minutes,
      slots: slots.map((slot) => ({
        startTime: slot.slot_start,
        endTime: slot.slot_end,
        // Ora locală (Romania), de afisat direct in interfata: "16:00" - "17:00"
        startLabel: localTimeLabel(slot.slot_start),
        endLabel: localTimeLabel(slot.slot_end),
        capacity: slot.capacity,
        seatsLeft: slot.seats_left,
        isAvailable: slot.is_free && !slot.overlaps_own_booking,
        overlapsOwnBooking: slot.overlaps_own_booking,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/facilities/:id/equipment - Echipamentele de inchiriat pentru sportul facilitatii (KAN-71)
// Ex.: Bazin (Natație) -> ochelari, boneta, pluta. Pretul este pe bucata si pe ora rezervata.
router.get('/:id/equipment', async (req, res, next) => {
  const facilityId = Number(req.params.id);
  if (!Number.isInteger(facilityId) || facilityId <= 0) {
    return res.status(400).json({
      error: {code: 'VALIDATION', message: 'Id-ul facilității trebuie să fie un număr întreg pozitiv.'},
    });
  }

  try {
    const [[facility]] = await sequelize.query(
      'SELECT sport_type FROM sport_facilities WHERE facility_id = :facilityId AND is_active',
      {replacements: {facilityId}});
    if (!facility) {
      return res.status(404).json({
        error: {code: 'SB404', message: 'Facilitatea nu există sau nu este activă.'},
      });
    }

    const [equipment] = await sequelize.query(`
      SELECT equipment_id, name, hourly_fee, available_stock
        FROM equipment
       WHERE sport_category = :sportType AND available_stock > 0
       ORDER BY equipment_id
    `, {replacements: {sportType: facility.sport_type}});

    res.json(equipment.map((item) => ({
      equipmentId: item.equipment_id,
      name: item.name,
      hourlyFee: Number(item.hourly_fee),
      availableStock: item.available_stock,
    })));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/facilities - Adaugare facilitate noua (Admin)
router.post('/', adminOnly, async (req, res, next) => {
  try {
    const {
      name,
      sport_type,
      category = 'Sporturi',
      location_id = 1,
      capacity = 10,
      base_price_per_hour = 30.0,
      slot_minutes = 60,
      opens_at = '08:00:00',
      closes_at = '22:00:00',
      has_lighting = true
    } = req.body;

    const [[newFacility]] = await sequelize.query(`
      INSERT INTO sport_facilities (
        name, sport_type, category, location_id, capacity, 
        base_price_per_hour, slot_minutes, opens_at, closes_at, has_lighting, is_active
      ) VALUES (
        :name, :sport_type, :category, :location_id, :capacity,
        :base_price_per_hour, :slot_minutes, :opens_at, :closes_at, :has_lighting, true
      ) RETURNING *
    `, {
      replacements: {
        name, sport_type, category, location_id, capacity,
        base_price_per_hour, slot_minutes, opens_at, closes_at, has_lighting
      }
    });

    res.status(201).json(newFacility);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/facilities/:id - Actualizare facilitate existenta (Admin)
router.put('/:id', adminOnly, async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      name,
      sport_type,
      category,
      capacity,
      base_price_per_hour,
      slot_minutes,
      opens_at,
      closes_at,
      is_active
    } = req.body;

    const [[updated]] = await sequelize.query(`
      UPDATE sport_facilities SET
        name = COALESCE(:name, name),
        sport_type = COALESCE(:sport_type, sport_type),
        category = COALESCE(:category, category),
        capacity = COALESCE(:capacity, capacity),
        base_price_per_hour = COALESCE(:base_price_per_hour, base_price_per_hour),
        slot_minutes = COALESCE(:slot_minutes, slot_minutes),
        opens_at = COALESCE(:opens_at, opens_at),
        closes_at = COALESCE(:closes_at, closes_at),
        is_active = COALESCE(:is_active, is_active)
      WHERE facility_id = :id
      RETURNING *
    `, {
      replacements: {
        id, name, sport_type, category, capacity,
        base_price_per_hour, slot_minutes, opens_at, closes_at, is_active
      }
    });

    if (!updated) {
      return res.status(404).json({ error: 'Facilitatea nu a fost gasita' });
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
