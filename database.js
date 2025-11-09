import Database from "better-sqlite3";
import bcrypt from "bcrypt";

const db = new Database("users.db");

// Create table
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
  return { name, email };
}

export function validateUser(email, password) {
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return null;
  const ok = bcrypt.compareSync(password, user.passwordHash);
  return ok ? user : null;
}

export function findUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email);
}

export function updatePassword(email, newPassword) {
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET passwordHash = ? WHERE email = ?").run(hash, email);
}
