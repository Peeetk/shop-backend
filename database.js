import Database from "better-sqlite3";
import bcrypt from "bcrypt";

const db = new Database("users.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

export function registerUser(name, email, password) {
  const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (existing) throw new Error("Email already registered");

  const passwordHash = bcrypt.hashSync(password, 10);
  db.prepare("INSERT INTO users (name, email, passwordHash) VALUES (?, ?, ?)").run(name, email, passwordHash);

  console.log(`✅ Registered: ${email}`);
  return { name, email };
}

export function findUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email);
}

export function validateUser(email, password) {
  const user = findUserByEmail(email);
  if (!user) return null;

  const ok = bcrypt.compareSync(password, user.passwordHash);
  if (!ok) {
    console.warn(`❌ Wrong password for ${email}`);
    return null;
  }

  console.log(`✅ Login OK for ${email}`);
  return user;
}
