// ---------------------- Load ENV ----------------------
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import nodemailer from "nodemailer";
import path from "path";
import { fileURLToPath } from "url";
import { registerUser, validateUser, findUserByEmail, updatePassword } from "./database.js";

dotenv.config();

const app = express();
app.use(express.json());

// ---------------------- Config ----------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_123";

// ---------------------- CORS ----------------------
app.use(
  cors({
    origin: [
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "https://your-netlify-site.netlify.app" // 🔁 change this to your real Netlify domain
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ---------------------- Email Setup ----------------------
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT || 587),
  secure: Number(process.env.EMAIL_PORT) === 465,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ---------------------- ROUTES ----------------------

// Register
app.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: "Missing fields" });

    const user = registerUser(name, email, password);
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Login
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = validateUser(email, password);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: "2h" }
    );

    res.json({ success: true, token, user: { name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Request password reset
app.post("/request-password-reset", async (req, res) => {
  try {
    const { email } = req.body;
    const user = findUserByEmail(email);
    if (!user) return res.status(404).json({ error: "User not found" });

    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "15m" });

    const resetLink = `${process.env.APP_ORIGIN}/reset-password.html?token=${token}`;
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: email,
      subject: "Password Reset Request",
      html: `
        <h2>Hello ${user.name},</h2>
        <p>You requested a password reset. Click the link below to create a new password:</p>
        <a href="${resetLink}" target="_blank">${resetLink}</a>
        <p>This link will expire in 15 minutes.</p>
      `,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("request-password-reset error:", err);
    res.status(500).json({ error: "Email sending failed" });
  }
});

// Reset password
app.post("/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    const decoded = jwt.verify(token, JWT_SECRET);
    updatePassword(decoded.email, newPassword);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: "Invalid or expired token" });
  }
});

// Health check
app.get("/", (_, res) => res.send("✅ Server running"));

// Start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
