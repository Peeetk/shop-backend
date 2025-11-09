import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import { registerUser, validateUser, findUserByEmail } from "./database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || "secret_key";
const FRONTEND_ORIGIN = process.env.APP_ORIGIN || "http://localhost:10000";

// Basic middleware
app.use(express.json());
app.use(cors({ origin: ["http://localhost:5500", "http://127.0.0.1:5500", "http://localhost:10000"], credentials: true }));
app.use(express.static(path.join(__dirname, "public")));

// --- Nodemailer setup ---
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT || 587),
  secure: Number(process.env.EMAIL_PORT) === 465,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// --- Register user ---
app.post("/register", (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });
    const user = registerUser(name, email, password);
    res.json({ success: true, user });
  } catch (err) {
    console.error("Register error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// --- Login user ---
app.post("/login", (req, res) => {
  try {
    const { email, password } = req.body;
    const user = validateUser(email, password);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "2h" });
    console.log(`✅ Login OK for ${email}`);

    res.json({ success: true, token, user: { name: user.name, email } });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// --- Password reset request ---
app.post("/request-password-reset", async (req, res) => {
  try {
    const { email } = req.body;
    const user = findUserByEmail(email);
    if (!user) return res.status(404).json({ error: "Email not found" });

    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "30m" });
    const resetUrl = `${FRONTEND_ORIGIN}/register.html?token=${encodeURIComponent(token)}`;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: email,
      subject: "Jelszó visszaállítás",
      html: `<p>Kattints az alábbi linkre a jelszó visszaállításához:</p>
             <p><a href="${resetUrl}">${resetUrl}</a></p>
             <p>Ez a link 30 percig érvényes.</p>`,
    });

    console.log(`📧 Password reset email sent to ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error("request-password-reset error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
