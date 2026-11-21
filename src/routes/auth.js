const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sequelize = require('../db');
const jwtConfig = require('../config/jwt');

// Rolurile care isi pot face singure cont; RECEPTIONIST si ADMIN se creeaza doar din panoul Admin
const PUBLIC_ROLES = ['STUDENT', 'PROFESSOR', 'AMATEUR'];
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PHONE_LENGTH = 20;

// Acelasi mesaj pentru email inexistent si parola gresita, ca sa nu aflam cine are cont
const INVALID_CREDENTIALS = 'Email sau parolă incorectă.';

// Hash folosit doar ca verificarea sa dureze la fel de mult si cand emailul nu exista
const DUMMY_HASH = bcrypt.hashSync('cont-inexistent', 10);

/**
 * Trimite o eroare in formatul folosit de tot API-ul: { error: { code, message } }.
 * @param {!Object} res Raspunsul Express.
 * @param {number} status Codul HTTP.
 * @param {string} code Codul erorii (vezi schema Error din Swagger).
 * @param {string} message Mesajul pentru utilizator.
 */
function sendError(res, status, code, message) {
  res.status(status).json({error: {code, message}});
}

/**
 * Compara parola cu hash-ul din baza de date. Un hash invalid (de ex. cel
 * fictiv din datele de test) inseamna parola gresita, nu eroare de server.
 * @param {string} password Parola primita.
 * @param {string} hash Hash-ul bcrypt salvat.
 * @return {!Promise<boolean>}
 */
async function passwordMatches(password, hash) {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

/**
 * Transforma un rand din tabelul users in obiectul User din Swagger.
 * password_hash nu ajunge niciodata in raspuns.
 * @param {!Object} row Randul din baza de date.
 * @return {!Object}
 */
function toUser(row) {
  return {
    userId: row.user_id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone_number,
    roleType: row.role_type,
    settings: {
      preferredLanguage: row.preferred_language,
      preferredCurrency: row.preferred_currency,
      darkMode: row.dark_mode,
      reminderMinutesBefore: row.reminder_minutes_before,
    },
  };
}

const USER_COLUMNS = `user_id, full_name, email, phone_number, role_type, is_active,
  preferred_language, preferred_currency, dark_mode, reminder_minutes_before`;

/**
 * Verifica datele de inregistrare.
 * @param {!Object} body Corpul cererii.
 * @return {!Array<string>} Erorile gasite; lista goala daca datele sunt valide.
 */
function validateRegister(body) {
  const errors = [];
  const {fullName, email, password, phone, roleType, studyYear} = body;

  if (typeof fullName !== 'string' || fullName.trim() === '') {
    errors.push('Numele este obligatoriu.');
  }
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
    errors.push('Emailul nu este valid.');
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Parola trebuie să aibă minim ${MIN_PASSWORD_LENGTH} caractere.`);
  }
  if (phone !== undefined && phone !== null && phone !== '' &&
      (typeof phone !== 'string' || phone.length > MAX_PHONE_LENGTH)) {
    errors.push(`Telefonul poate avea maxim ${MAX_PHONE_LENGTH} caractere.`);
  }
  if (roleType !== undefined && !PUBLIC_ROLES.includes(roleType)) {
    errors.push(`Rolul trebuie să fie unul dintre: ${PUBLIC_ROLES.join(', ')}.`);
  }
  if (studyYear !== undefined && studyYear !== null &&
      !(Number.isInteger(studyYear) && studyYear >= 1 && studyYear <= 6)) {
    errors.push('Anul de studiu trebuie să fie între 1 și 6.');
  }
  return errors;
}

// POST /api/v1/auth/register - Creare cont public (Student, Profesor, Amator) + profilul lui
router.post('/register', async (req, res, next) => {
  const errors = validateRegister(req.body);
  if (errors.length > 0) {
    return sendError(res, 400, 'VALIDATION', errors.join(' '));
  }

  const {
    fullName, email, password, phone, roleType = 'STUDENT',
    matricolNumber, faculty, studyYear, department, academicTitle, organization,
  } = req.body;

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    // register_user (din schema SQL) creeaza utilizatorul si profilul intr-o singura operatie
    const [[{user_id: userId}]] = await sequelize.query(`
      SELECT register_user(
        :fullName, :email, :phone, :passwordHash, CAST(:roleType AS user_role_enum),
        :matricolNumber, :faculty, :studyYear, :department, :academicTitle,
        NULL, :organization
      ) AS user_id
    `, {
      replacements: {
        fullName: fullName.trim(),
        email: email.trim(),
        phone: phone ? phone.trim() : null,
        passwordHash,
        roleType,
        matricolNumber: matricolNumber || null,
        faculty: faculty || null,
        studyYear: studyYear ?? null,
        department: department || null,
        academicTitle: academicTitle || null,
        organization: organization || null,
      },
    });

    const [[user]] = await sequelize.query(
      `SELECT ${USER_COLUMNS} FROM users WHERE user_id = :userId`,
      {replacements: {userId}});
    res.status(201).json(toUser(user));
  } catch (err) {
    // Email (sau numar matricol) deja folosit: 23505 -> 409, tratat in middleware/errors.js
    next(err);
  }
});

// POST /api/v1/auth/login - Verifica emailul si parola si intoarce un token JWT
router.post('/login', async (req, res, next) => {
  const {email, password} = req.body;
  if (typeof email !== 'string' || email.trim() === '' ||
      typeof password !== 'string' || password === '') {
    return sendError(res, 400, 'VALIDATION', 'Emailul și parola sunt obligatorii.');
  }

  try {
    const [[user]] = await sequelize.query(
      `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE lower(email) = lower(:email)`,
      {replacements: {email: email.trim()}});

    const valid = await passwordMatches(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !valid) {
      return sendError(res, 401, 'UNAUTHORIZED', INVALID_CREDENTIALS);
    }
    if (!user.is_active) {
      return sendError(res, 403, 'SB403', 'Contul este dezactivat. Contactează administratorul.');
    }

    // Campurile din token sunt cele citite de middleware/auth.js (req.user.id, role, email)
    const token = jwt.sign(
      {id: user.user_id, role: user.role_type, email: user.email},
      jwtConfig.secret,
      {expiresIn: jwtConfig.expiresIn});

    res.json({token, user: toUser(user)});
  } catch (err) {
    next(err);
  }
});

module.exports = router;
