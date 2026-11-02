require('dotenv').config();
const { Client } = require('pg');

async function checkDatabase() {
  console.log('====================================================');
  console.log('  CAMPUS SPORTS BOOKING - VERIFICARE BAZA DE DATE   ');
  console.log('====================================================');
  console.log('Conectare la:', process.env.DATABASE_URL.replace(/:[^:@]+@/, ':****@'));

  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  try {
    await client.connect();
    console.log('Conexiune reusita la PostgreSQL!\n');

    const res = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);

    if (res.rows.length === 0) {
      console.log('Baza de date este goala (nu exista tabele create inca).');
      console.log('Ruleaza scriptul schema_campus_sports_v2.sql pentru a crea tabelele.');
    } else {
      console.log(`S-au gasit ${res.rows.length} tabele in schema 'public':\n`);
      console.log('----------------------------------------------------');
      console.log('| #  | Nume Tabel               | Nr. Inregistrari |');
      console.log('----------------------------------------------------');
      
      let index = 1;
      for (const row of res.rows) {
        const tbl = row.table_name;
        try {
          const countRes = await client.query(`SELECT count(*)::int as count FROM "${tbl}"`);
          const count = countRes.rows[0].count;
          console.log(`| ${String(index).padEnd(2)} | ${tbl.padEnd(24)} | ${String(count).padStart(16)} |`);
        } catch {
          console.log(`| ${String(index).padEnd(2)} | ${tbl.padEnd(24)} |        (eroare)  |`);
        }
        index++;
      }
      console.log('----------------------------------------------------\n');
    }
  } catch (err) {
    console.error('Eroare la conectarea la baza de date:');
    console.error(err.message);
    console.log('\nSfat: Asigura-te ca Docker Desktop este pornit si ruleaza:');
    console.log('cd campus-db && docker compose up -d');
  } finally {
    await client.end();
  }
}

checkDatabase();
