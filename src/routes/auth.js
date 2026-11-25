const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sequelize = require('../db');
const jwtConfig = require('../config/jwt');

// Rolurile care isi pot face singure cont; RECEPTIONIST si ADMIN se creeaza doar din panoul Admin
const PUBLIC_ROLES = ['STUDENT', 'PROFESSOR', 'AMATEUR'];
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD_LENGTH = 8;
// Parola trebuie sa contina cel putin o litera si o cifra (comentariu code review PR #4)
const PASSWORD_LETTER = /[A-Za-zĂÂÎȘȚăâîșț]/;
const PASSWORD_DIGIT = /\d/;
const MAX_PHONE_LENGTH = 20;
// Telefon: cifre, spatii, +, -, ., paranteze; intre 10 si 15 cifre (ex. 0722 123 456 sau +40 722 123 456)
const PHONE_CHARS = /^\+?[\d\s().-]+$/;
const MIN_PHONE_DIGITS = 10;
const MAX_PHONE_DIGITS = 15;
// Numar matricol: litere, cifre, /, - si . (ex. 3BITS-001, 1234/2023)
const MATRICOL_PATTERN = /^[A-Za-z0-9/.-]{2,40}$/;
const MAX_FACULTY_LENGTH = 150;

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
    // Datele de profil (null daca rolul nu le are): student -> matricol, facultate; profesor -> departament
    matricolNumber: row.matricol_number ?? null,
    faculty: row.faculty ?? null,
    studyYear: row.study_year ?? null,
    department: row.department ?? null,
    settings: {
      preferredLanguage: row.preferred_language,
      preferredCurrency: row.preferred_currency,
      darkMode: row.dark_mode,
      reminderMinutesBefore: row.reminder_minutes_before,
    },
  };
}

const USER_COLUMNS = `u.user_id, u.full_name, u.email, u.phone_number, u.role_type, u.is_active,
  u.preferred_language, u.preferred_currency, u.dark_mode, u.reminder_minutes_before,
  sp.matricol_number, sp.faculty, sp.study_year, pp.department`;

// Utilizatorul impreuna cu profilul lui de student sau profesor (daca exista)
const USER_FROM = `users u
  LEFT JOIN student_profiles sp ON sp.user_id = u.user_id
  LEFT JOIN professor_profiles pp ON pp.user_id = u.user_id`;

/**
 * Verifica numarul de telefon (obligatoriu pentru toate rolurile).
 * @param {*} phone Valoarea primita.
 * @return {?string} Mesajul de eroare sau null daca telefonul este valid.
 */
function phoneError(phone) {
  if (typeof phone !== 'string' || phone.trim() === '') {
    return 'Numărul de telefon este obligatoriu.';
  }
  const digits = phone.replace(/\D/g, '').length;
  if (phone.length > MAX_PHONE_LENGTH || !PHONE_CHARS.test(phone.trim()) ||
      digits < MIN_PHONE_DIGITS || digits > MAX_PHONE_DIGITS) {
    return `Telefonul trebuie să aibă între ${MIN_PHONE_DIGITS} și ${MAX_PHONE_DIGITS} cifre (ex. 0722 123 456).`;
  }
  return null;
}

/**
 * Verifica datele de inregistrare.
 * @param {!Object} body Corpul cererii.
 * @return {!Array<string>} Erorile gasite; lista goala daca datele sunt valide.
 */
function validateRegister(body) {
  const errors = [];
  const {fullName, email, password, phone, roleType, matricolNumber, faculty, studyYear} = body;

  if (typeof fullName !== 'string' || fullName.trim() === '') {
    errors.push('Numele este obligatoriu.');
  }
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
    errors.push('Emailul nu este valid.');
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Parola trebuie să aibă minim ${MIN_PASSWORD_LENGTH} caractere.`);
  } else if (!PASSWORD_LETTER.test(password) || !PASSWORD_DIGIT.test(password)) {
    errors.push('Parola trebuie să conțină cel puțin o literă și o cifră.');
  }
  const phoneMessage = phoneError(phone);
  if (phoneMessage) {
    errors.push(phoneMessage);
  }
  if (!PUBLIC_ROLES.includes(roleType)) {
    errors.push(`Rolul trebuie să fie unul dintre: ${PUBLIC_ROLES.join(', ')}.`);
  }
  // Studentii trebuie sa-si completeze numarul matricol si facultatea (KAN-69)
  if (roleType === 'STUDENT') {
    if (typeof matricolNumber !== 'string' || !MATRICOL_PATTERN.test(matricolNumber.trim())) {
      errors.push('Numărul matricol este obligatoriu (2–40 de caractere: litere, cifre, „/”, „-”, „.”).');
    }
    if (typeof faculty !== 'string' || faculty.trim().length < 3 ||
        faculty.trim().length > MAX_FACULTY_LENGTH) {
      errors.push('Facultatea este obligatorie.');
    }
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
    fullName, email, password, phone, roleType,
    matricolNumber, faculty, studyYear, department, academicTitle, organization,
  } = req.body;
  const isStudent = roleType === 'STUDENT';

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
        // Emailul se salveaza mereu cu litere mici (comentariu code review PR #4)
        email: email.trim().toLowerCase(),
        phone: phone.trim(),
        passwordHash,
        roleType,
        // Matricolul si facultatea se salveaza doar pentru studenti
        matricolNumber: isStudent ? matricolNumber.trim().toUpperCase() : null,
        faculty: isStudent ? faculty.trim() : null,
        studyYear: isStudent ? (studyYear ?? null) : null,
        department: department || null,
        academicTitle: academicTitle || null,
        organization: organization || null,
      },
    });

    const [[user]] = await sequelize.query(
      `SELECT ${USER_COLUMNS} FROM ${USER_FROM} WHERE u.user_id = :userId`,
      {replacements: {userId}});
    res.status(201).json(toUser(user));
  } catch (err) {
    // Email sau numar matricol deja folosit (23505): mesaj clar in loc de textul din PostgreSQL
    if (err.original?.code === '23505') {
      const constraint = err.original.constraint || '';
      const message = constraint.includes('matricol') ?
        'Există deja un cont cu acest număr matricol.' :
        'Există deja un cont cu acest email.';
      return sendError(res, 409, 'SB409', message);
    }
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
      `SELECT ${USER_COLUMNS}, u.password_hash FROM ${USER_FROM} WHERE lower(u.email) = lower(:email)`,
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
