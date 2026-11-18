const router = require('express').Router();
const sequelize = require('../db');
const bcrypt = require('bcrypt');

// GET /api/v1/users - Listare utilizatori din PostgreSQL (Admin)
router.get('/', async (req, res, next) => {
  try {
    const [users] = await sequelize.query(`
      SELECT 
        u.user_id,
        u.full_name,
        u.email,
        u.role_type,
        u.is_active,
        u.created_at,
        sp.faculty AS student_faculty,
        sp.study_year AS student_year,
        sp.matricol_number,
        pp.department AS professor_department,
        pp.academic_title AS professor_title
      FROM users u
      LEFT JOIN student_profiles sp ON u.user_id = sp.user_id
      LEFT JOIN professor_profiles pp ON u.user_id = pp.user_id
      ORDER BY u.user_id ASC
    `);
    res.json(users);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/users - Adaugare utilizator nou (Admin)
router.post('/', async (req, res, next) => {
  try {
    const { full_name, email, role_type = 'STUDENT', password = 'ParolaInitiala2026!' } = req.body;

    const password_hash = await bcrypt.hash(password, 10);

    const [[newUser]] = await sequelize.query(`
      INSERT INTO users (full_name, email, password_hash, role_type, is_active)
      VALUES (:full_name, :email, :password_hash, :role_type, true)
      RETURNING user_id, full_name, email, role_type, is_active, created_at
    `, {
      replacements: { full_name, email, password_hash, role_type }
    });

    // Creeaza si profilul asociat daca este student
    if (role_type === 'STUDENT') {
      await sequelize.query(`
        INSERT INTO student_profiles (user_id, faculty, study_year, matricol_number)
        VALUES (:id, 'FIESC', 3, 'MATR-' || :id)
      `, { replacements: { id: newUser.user_id } });
    } else if (role_type === 'PROFESSOR') {
      await sequelize.query(`
        INSERT INTO professor_profiles (user_id, department, academic_title)
        VALUES (:id, 'Calculatoare', 'Lector dr.')
      `, { replacements: { id: newUser.user_id } });
    }

    res.status(201).json(newUser);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/users/:id - Actualizare utilizator (Admin)
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { full_name, role_type, is_active } = req.body;

    const [[updated]] = await sequelize.query(`
      UPDATE users SET
        full_name = COALESCE(:full_name, full_name),
        role_type = COALESCE(:role_type, role_type),
        is_active = COALESCE(:is_active, is_active)
      WHERE user_id = :id
      RETURNING user_id, full_name, email, role_type, is_active, created_at
    `, {
      replacements: { id, full_name, role_type, is_active }
    });

    if (!updated) {
      return res.status(404).json({ error: 'Utilizatorul nu a fost gasit' });
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
