const router = require('express').Router();
const sequelize = require('../db');
const bcrypt = require('bcrypt');

// Valorile permise de enum-ul user_role_enum din baza de date.
const ROLES = ['STUDENT', 'PROFESSOR', 'AMATEUR', 'RECEPTIONIST', 'ADMIN'];
// Aceeasi regula ca ck_users_email_format din schema SQL.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PHONE_LENGTH = 20;

// Coloanele returnate clientului. password_hash nu apare niciodata aici.
const PUBLIC_COLUMNS =
  'user_id, full_name, email, phone_number, role_type, is_active, created_at';

/**
 * Verifica datele primite pentru un utilizator.
 * La adaugare (isCreate = true) numele, emailul si parola sunt obligatorii.
 * La actualizare se verifica doar campurile trimise.
 * @param {!Object} body Corpul cererii.
 * @param {boolean} isCreate true pentru POST, false pentru PUT.
 * @return {!Array<string>} Erorile gasite; lista goala daca datele sunt valide.
 */
function validateUser(body, isCreate) {
  const errors = [];
  const {full_name, email, phone_number, password, role_type, is_active} = body;

  if (isCreate || full_name !== undefined) {
    if (typeof full_name !== 'string' || full_name.trim() === '') {
      errors.push('Numele este obligatoriu.');
    }
  }
  if (isCreate || email !== undefined) {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      errors.push('Emailul nu este valid.');
    }
  }
  if (isCreate) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      errors.push(`Parola trebuie sa aiba minim ${MIN_PASSWORD_LENGTH} caractere.`);
    }
  }
  if (phone_number !== undefined && phone_number !== null && phone_number !== '') {
    if (typeof phone_number !== 'string' || phone_number.length > MAX_PHONE_LENGTH) {
      errors.push(`Telefonul poate avea maxim ${MAX_PHONE_LENGTH} caractere.`);
    }
  }
  if (role_type !== undefined && !ROLES.includes(role_type)) {
    errors.push(`Rolul trebuie sa fie unul dintre: ${ROLES.join(', ')}.`);
  }
  if (is_active !== undefined && typeof is_active !== 'boolean') {
    errors.push('Campul is_active trebuie sa fie true sau false.');
  }
  return errors;
}

/**
 * Trimite un raspuns 400 in formatul de eroare folosit de tot API-ul.
 * @param {!Object} res Raspunsul Express.
 * @param {string} message Mesajul afisat utilizatorului.
 */
function sendBadRequest(res, message) {
  res.status(400).json({error: {code: 'VALIDATION', message}});
}

/**
 * Transforma un telefon gol in null, ca sa nu salvam siruri goale.
 * @param {string|undefined|null} phone Telefonul primit.
 * @return {string|null}
 */
function normalizePhone(phone) {
  return phone ? phone.trim() : null;
}

// GET /api/v1/users - Listare utilizatori din PostgreSQL (Admin)
router.get('/', async (req, res, next) => {
  try {
    const [users] = await sequelize.query(`
      SELECT
        u.user_id,
        u.full_name,
        u.email,
        u.phone_number,
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
  const errors = validateUser(req.body, true);
  if (errors.length > 0) {
    return sendBadRequest(res, errors.join(' '));
  }

  try {
    const {full_name, email, phone_number, password, role_type = 'STUDENT'} = req.body;
    const passwordHash = await bcrypt.hash(password, 10);

    // Utilizatorul si profilul se salveaza impreuna: daca profilul esueaza,
    // nu ramane in baza de date un utilizator fara profil.
    const newUser = await sequelize.transaction(async (transaction) => {
      const [[user]] = await sequelize.query(`
        INSERT INTO users (full_name, email, phone_number, password_hash, role_type)
        VALUES (:fullName, :email, :phone, :passwordHash, :roleType)
        RETURNING ${PUBLIC_COLUMNS}
      `, {
        transaction,
        replacements: {
          fullName: full_name.trim(),
          email: email.trim(),
          phone: normalizePhone(phone_number),
          passwordHash,
          roleType: role_type,
        },
      });

      if (role_type === 'STUDENT') {
        await sequelize.query(`
          INSERT INTO student_profiles (user_id, faculty, study_year, matricol_number)
          VALUES (:id, 'FIESC', 3, 'MATR-' || :id)
        `, {transaction, replacements: {id: user.user_id}});
      } else if (role_type === 'PROFESSOR') {
        await sequelize.query(`
          INSERT INTO professor_profiles (user_id, department, academic_title)
          VALUES (:id, 'Calculatoare', 'Lector dr.')
        `, {transaction, replacements: {id: user.user_id}});
      } else if (role_type === 'AMATEUR') {
        await sequelize.query(
          'INSERT INTO amateur_profiles (user_id) VALUES (:id)',
          {transaction, replacements: {id: user.user_id}});
      }
      return user;
    });

    res.status(201).json(newUser);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/users/:id - Actualizare utilizator (Admin)
// Se actualizeaza doar campurile trimise; parola nu se schimba de aici.
router.put('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return sendBadRequest(res, 'Id-ul utilizatorului trebuie sa fie un numar intreg pozitiv.');
  }

  const {full_name, email, phone_number, role_type, is_active} = req.body;
  if ([full_name, email, phone_number, role_type, is_active].every((v) => v === undefined)) {
    return sendBadRequest(res, 'Nu a fost trimis niciun camp de actualizat.');
  }
  const errors = validateUser(req.body, false);
  if (errors.length > 0) {
    return sendBadRequest(res, errors.join(' '));
  }

  try {
    // Valorile netrimise devin null, iar COALESCE pastreaza valoarea existenta.
    const [[updated]] = await sequelize.query(`
      UPDATE users SET
        full_name    = COALESCE(:fullName, full_name),
        email        = COALESCE(:email, email),
        phone_number = CASE WHEN :phoneSent THEN :phone ELSE phone_number END,
        role_type    = COALESCE(:roleType, role_type),
        is_active    = COALESCE(:isActive, is_active)
      WHERE user_id = :id
      RETURNING ${PUBLIC_COLUMNS}
    `, {
      replacements: {
        id,
        fullName: full_name === undefined ? null : full_name.trim(),
        email: email === undefined ? null : email.trim(),
        phoneSent: phone_number !== undefined,
        phone: normalizePhone(phone_number),
        roleType: role_type ?? null,
        isActive: is_active ?? null,
      },
    });

    if (!updated) {
      return res.status(404).json({
        error: {code: 'SB404', message: 'Utilizatorul nu a fost gasit.'},
      });
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
