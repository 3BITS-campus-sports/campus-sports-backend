# Campus Sports Booking – Backend API & Database (v2.1)
**Echipa 3BITS** | Disciplina: Ingineria Programelor (Laborator 6)

Acest repository conține serverul backend REST API și schema bazei de date PostgreSQL pentru platforma universitară **Campus Sports Booking**.

---

## 🛠️ Stack Tehnic & Coding Style
- **Runtime:** Node.js (v20+ LTS)
- **Framework REST:** Express.js
- **SGBD:** PostgreSQL 16
- **ORM / Query Engine:** Sequelize & pg
- **Autentificare & Securitate:** JWT & bcrypt
- **Coding Style:** [Google JavaScript Style Guide](https://google.github.io/styleguide/jsguide.html)

---

## 📁 Structura Proiectului
```text
campus-sports-backend/
├── database/
│   ├── schema_campus_sports_v2.sql  # Schema DDL (13 tabele, constrangeri, seed data)
│   ├── test_scenarios.sql           # 21 teste automate (cu ROLLBACK)
│   └── roles_team_access.sql        # Roluri de acces
├── src/
│   ├── server.js                    # Punctul de pornire al serverului
│   ├── app.js                       # Configurarea middleware-urilor si rutelor
│   ├── db.js                        # Conexiunea Sequelize la PostgreSQL
│   ├── check_db.js                  # Script de verificare a starii tabelelor
│   ├── routes/                      # Rute API (bookings, auth, facilities etc.)
│   ├── middleware/                  # Autentificare si tratare erori (SB400-SB409)
│   └── jobs/scheduler.js            # Joburi automate de verificare (node-cron)
├── docker-compose.yml               # PostgreSQL 16 + Adminer Web UI
├── swagger_campus_sports.yaml       # Specificatia OpenAPI 3.0
└── package.json
```

---

## 🚀 Pornire Rapidă

### 1. Pornirea Bazei de Date (cu Docker)
1. Copiază fișierul de configurare:
   ```bash
   cp .env.example .env
   # Pe Windows PowerShell:
   copy .env.example .env
   ```
2. Pornește containerele PostgreSQL și Adminer:
   ```bash
   docker compose up -d
   ```
3. Verifică în browser interfața de administrare:  
   👉 **http://localhost:8080**  
   - **System:** PostgreSQL
   - **Server:** `db`
   - **Username / Password / Database:** valorile din fișierul tău `.env`

### 2. Instalare și Verificare Tabele
```bash
npm install
npm run db:check
```
*Comanda va afișa în consolă starea tuturor celor 13 tabele create și numărul de înregistrări din baza de date.*

### 3. Pornirea Serverului Backend
```bash
npm start
```
Serverul va rula la adresa: `http://localhost:5000/api/v1`
