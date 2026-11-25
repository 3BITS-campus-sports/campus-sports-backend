// Seteaza parola unui cont existent (de ex. administratorul sau receptia din datele de test,
// care au doar un hash fictiv si nu se pot autentifica). Parola nu se scrie in niciun fisier.
// Utilizare: npm run set-password -- admin@campussports.ro ParolaMea123
require('dotenv').config();
const bcrypt = require('bcrypt');
const { Client } = require('pg');

const MIN_PASSWORD_LENGTH = 8;

async function setPassword() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Utilizare: npm run set-password -- <email> <parola>');
    process.exit(1);
  }
  if (password.length < MIN_PASSWORD_LENGTH || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    console.error(`Parola trebuie să aibă minim ${MIN_PASSWORD_LENGTH} caractere, cel puțin o literă și o cifră.`);
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const hash = await bcrypt.hash(password, 10);
    const result = await client.query(
      'UPDATE users SET password_hash = $1 WHERE lower(email) = lower($2) RETURNING full_name, role_type',
      [hash, email.trim()]
    );
    if (result.rowCount === 0) {
      console.error(`Nu există niciun cont cu emailul ${email}.`);
      process.exitCode = 1;
      return;
    }
    const { full_name: name, role_type: role } = result.rows[0];
    console.log(`Parola a fost setată pentru ${name} (${role}). Te poți autentifica cu ${email}.`);
  } catch (err) {
    console.error('Eroare:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

setPassword();
