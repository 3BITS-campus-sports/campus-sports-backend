const router = require('express').Router();
const sequelize = require('../db');

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

// POST /api/v1/facilities - Adaugare facilitate noua (Admin)
router.post('/', async (req, res, next) => {
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
router.put('/:id', async (req, res, next) => {
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
