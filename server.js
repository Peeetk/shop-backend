// ✅ Load environment variables FIRST
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import Stripe from "stripe";
import cors from "cors";
import nodemailer from "nodemailer";
import crypto from "crypto";
import pkg from "pg";

const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();

// ---------- POSTGRES SETUP ----------

let dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.error("❌ No DATABASE_URL set!");
}

if (dbUrl && dbUrl.startsWith("postgresql://")) {
  dbUrl = "postgres://" + dbUrl.slice("postgresql://".length);
}

const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl ? { rejectUnauthorized: false } : false,
});

// ---------- TABLE INIT ----------

async function initCustomersTable() {
  try {
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE table_name = 'customers'
            AND constraint_type = 'UNIQUE'
            AND constraint_name = 'customers_email_key'
        ) THEN
          ALTER TABLE customers DROP CONSTRAINT customers_email_key;
        END IF;
      END
      $$;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        subtotal NUMERIC(10, 2),
        total NUMERIC(10, 2),
        note TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    console.log("✅ Customers table ensured");
  } catch (err) {
    console.error("❌ Error initialising customers table:", err);
  }
}

async function initUsersTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log("✅ Users table ensured");
  } catch (err) {
    console.error("❌ Error initialising users table:", err);
  }
}

async function initSiteSettingsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS site_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(
      `
      INSERT INTO site_settings (key, value)
      VALUES ($1, $2)
      ON CONFLICT (key) DO NOTHING
      `,
      [
        "welcome_popup_message",
        'Facebook Megszűnik hamarosan!!! Ezen a linken Telegrammon tudtok elérni: <a href="https://t.me/SondaC" target="_blank" rel="noopener noreferrer">t.me/SondaC</a>',
      ]
    );

    await pool.query(
      `
      INSERT INTO site_settings (key, value)
      VALUES ($1, $2)
      ON CONFLICT (key) DO NOTHING
      `,
      ["welcome_popup_enabled", "true"]
    );

    console.log("✅ Site settings table ensured");
  } catch (err) {
    console.error("❌ Error initialising site settings table:", err);
  }
}

initCustomersTable();
initUsersTable();
initSiteSettingsTable();

// ---------- ADMIN + CUSTOMER HELPERS ----------

const ADMIN_KEY = process.env.ADMIN_KEY || "";

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(403).json({ success: false, error: "Nem jogosult." });
  }
  next();
}

async function readCustomerEmails() {
  const result = await pool.query(
    "SELECT DISTINCT LOWER(email) AS email FROM customers WHERE active = TRUE"
  );
  return result.rows.map((r) => r.email);
}

// ---------- USER HELPERS ----------

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(password, salt, 10000, 64, "sha512")
    .toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, storedHash] = stored.split(":");
  const hash = crypto
    .pbkdf2Sync(password, salt, 10000, 64, "sha512")
    .toString("hex");

  return crypto.timingSafeEqual(
    Buffer.from(storedHash, "hex"),
    Buffer.from(hash, "hex")
  );
}

async function findUserByEmail(email) {
  const result = await pool.query(
    "SELECT id, email, password_hash FROM users WHERE LOWER(email) = LOWER($1)",
    [email]
  );
  return result.rows[0] || null;
}

async function createUser(email, passwordHash) {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     RETURNING id, email, password_hash, created_at`,
    [email, passwordHash]
  );
  return result.rows[0];
}

async function updateUserPassword(email, newPasswordHash) {
  await pool.query(
    "UPDATE users SET password_hash = $1 WHERE LOWER(email) = LOWER($2)",
    [newPasswordHash, email]
  );
}

async function deleteUser(email) {
  await pool.query("DELETE FROM users WHERE LOWER(email) = LOWER($1)", [email]);
}

// ---------- MIDDLEWARE / STRIPE / EMAIL ----------

app.use(
  cors({
    origin: [
      "https://sondyshop.it.com",
      "https://www.sondyshop.it.com",
      "http://127.0.0.1:5500",
      "http://localhost:5500",
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

console.log(
  "Stripe key detected:",
  process.env.STRIPE_SECRET_KEY ? "✅ Loaded" : "❌ Not found"
);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

transporter.verify((err) => {
  if (err) {
    console.error("❌ Email transporter error:", err);
  } else {
    console.log("✅ Email transporter ready");
  }
});

// ---------- AUTH ROUTES ----------

app.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email és jelszó kötelező." });
    }
    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "A jelszónak legalább 6 karakter hosszúnak kell lennie." });
    }

    const emailLower = email.trim().toLowerCase();

    const allowedEmails = await readCustomerEmails();
    if (!allowedEmails.includes(emailLower)) {
      return res.status(400).json({
        error:
          "Ezzel az email címmel nem lehet regisztrálni. " +
          "Használd azt az email címet, amellyel az előfizetés készült, vagy vedd fel velünk a kapcsolatot.",
      });
    }

    const existing = await findUserByEmail(emailLower);
    if (existing) {
      return res
        .status(400)
        .json({ error: "Ezzel az email címmel már van fiók." });
    }

    const passwordHash = hashPassword(password);
    await createUser(emailLower, passwordHash);

    res.json({ success: true, message: "Sikeres regisztráció!" });
  } catch (err) {
    console.error("❌ Register error:", err);
    res.status(500).json({
      error: "Szerver hiba regisztráció közben: " + String(err?.message || err),
    });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email és jelszó kötelező." });
    }

    const user = await findUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "Hibás email vagy jelszó." });
    }

    res.json({ success: true, email: user.email });
  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).json({ error: "Szerver hiba bejelentkezés közben." });
  }
});

app.post("/change-password", async (req, res) => {
  try {
    const { email, oldPassword, newPassword } = req.body;

    if (!email || !oldPassword || !newPassword) {
      return res
        .status(400)
        .json({ error: "Email, régi és új jelszó kötelező." });
    }
    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ error: "Az új jelszónak legalább 6 karakter hosszúnak kell lennie." });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(404).json({ error: "Felhasználó nem található." });
    }

    if (!verifyPassword(oldPassword, user.password_hash)) {
      return res.status(401).json({ error: "Hibás régi jelszó." });
    }

    const newHash = hashPassword(newPassword);
    await updateUserPassword(email, newHash);

    res.json({ success: true, message: "Jelszó sikeresen megváltoztatva." });
  } catch (err) {
    console.error("❌ Change password error:", err);
    res.status(500).json({ error: "Szerver hiba jelszóváltás közben." });
  }
});

app.post("/delete-account", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email és jelszó kötelező." });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(404).json({ error: "Felhasználó nem található." });
    }

    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "Hibás jelszó." });
    }

    await deleteUser(email);

    res.json({ success: true, message: "Fiók törölve." });
  } catch (err) {
    console.error("❌ Delete account error:", err);
    res.status(500).json({ error: "Szerver hiba fiók törlése közben." });
  }
});

app.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email kötelező." });
    }

    const user = await findUserByEmail(email);

    if (!user) {
      return res.json({
        success: true,
        message:
          "Ha létezik ilyen email cím, új ideiglenes jelszót hoztunk létre.",
        tempPassword: null,
      });
    }

    const tempPassword = crypto.randomBytes(4).toString("hex");
    const newHash = hashPassword(tempPassword);
    await updateUserPassword(email, newHash);

    console.log("🔐 New temporary password generated for:", email);

    res.json({
      success: true,
      message:
        "Ha létezik ilyen email cím, új ideiglenes jelszót hoztunk létre.",
      tempPassword,
    });
  } catch (err) {
    console.error("❌ Forgot password error:", err);
    res.status(500).json({
      error: "Szerver hiba jelszó visszaállítás közben.",
    });
  }
});

// ---------- STRIPE CHECKOUT ----------

app.post("/create-checkout-session", async (req, res) => {
  try {
    const cart = req.body.cart || [];
    console.log("📩 Received cart:", cart);

    if (!cart.length) return res.status(400).json({ error: "Cart is empty" });

    const line_items = cart.map((i) => {
      let amount = parseFloat(i.price ?? i.amount);
      if (isNaN(amount))
        amount = Number(String(i.price ?? i.amount).replace(",", "."));
      let unit_amount = Math.round(amount * 100);
      if (unit_amount < 30) unit_amount = 30;

      return {
        price_data: {
          currency: "gbp",
          product_data: { name: i.name },
          unit_amount,
        },
        quantity: i.quantity,
      };
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items,
      metadata: {
        customer_name: req.body.customerName || "Unknown Customer",
      },
      success_url:
        "https://sondyshop.it.com/success.html?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://sondyshop.it.com/cancel.html",
    });

    res.json({ id: session.id });
  } catch (err) {
    console.error("❌ Error creating checkout session:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

app.get("/checkout-session", async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) {
      return res.status(400).json({ error: "Missing session_id" });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["customer_details"],
    });

    res.json({
      id: session.id,
      customer_name:
        session.metadata?.customer_name ||
        session.customer_details?.name ||
        "Unknown",
      amount_total: (session.amount_total / 100).toFixed(2),
      currency: session.currency.toUpperCase(),
      date: new Date(session.created * 1000).toLocaleDateString("en-GB"),
    });
  } catch (err) {
    console.error("❌ Error fetching session:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- PAYMENT NOTIFICATION EMAIL (optional) ----------

app.post("/notify-payment", async (req, res) => {
  try {
    const { date, customer_name, amount_total } = req.body;

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: "your.email@example.com",
      subject: "💰 New Payment Completed",
      text: `A payment of £${amount_total} was made by ${customer_name} on ${date}.`,
    });

    console.log("📧 Payment notification email sent!");
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Email sending failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- ROOT + DEBUG ----------

app.get("/", (req, res) => {
  res.send("✅ Stripe backend is running successfully!");
});

app.get("/debug-env", (req, res) => {
  res.json({
    stripeKeyLoaded: !!process.env.STRIPE_SECRET_KEY,
    stripeKeyPrefix: process.env.STRIPE_SECRET_KEY
      ? process.env.STRIPE_SECRET_KEY.slice(0, 10)
      : null,
  });
});

// ---------- ADMIN API + UI ----------

app.get("/admin/settings/welcome-popup", requireAdmin, async (req, res) => {
  try {
    const messageResult = await pool.query(
      "SELECT value FROM site_settings WHERE key = $1",
      ["welcome_popup_message"]
    );

    const enabledResult = await pool.query(
      "SELECT value FROM site_settings WHERE key = $1",
      ["welcome_popup_enabled"]
    );

    const enabled = enabledResult.rows[0]?.value !== "false";

    res.json({
      success: true,
      message: messageResult.rows[0]?.value || "",
      enabled,
    });
  } catch (err) {
    console.error("❌ Admin get welcome popup error:", err);
    res.status(500).json({
      success: false,
      error: "Szerver hiba popup betöltés közben.",
    });
  }
});

app.post("/admin/settings/welcome-popup", requireAdmin, async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        success: false,
        error: "Popup üzenet kötelező.",
      });
    }

    await pool.query(
      `
      INSERT INTO site_settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `,
      ["welcome_popup_message", message.trim()]
    );

    res.json({
      success: true,
      message: "Popup üzenet elmentve.",
    });
  } catch (err) {
    console.error("❌ Save welcome popup error:", err);
    res.status(500).json({
      success: false,
      error: "Szerver hiba popup mentés közben.",
    });
  }
});

app.post("/admin/settings/welcome-popup-enabled", requireAdmin, async (req, res) => {
  try {
    const { enabled } = req.body;
    const value = enabled ? "true" : "false";

    await pool.query(
      `
      INSERT INTO site_settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `,
      ["welcome_popup_enabled", value]
    );

    res.json({
      success: true,
      message: enabled
        ? "Popup üzenet bekapcsolva."
        : "Popup üzenet kikapcsolva.",
      enabled,
    });
  } catch (err) {
    console.error("❌ Save popup enabled error:", err);
    res.status(500).json({
      success: false,
      error: "Szerver hiba popup kapcsoló mentés közben.",
    });
  }
});

app.get("/admin/customers", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, subtotal, total, note, active
       FROM customers
       ORDER BY active DESC, email ASC`
    );
    res.json({ success: true, customers: result.rows });
  } catch (err) {
    console.error("❌ List customers error:", err);
    res.status(500).json({ success: false, error: "Szerver hiba." });
  }
});

app.post("/admin/customers/save", requireAdmin, async (req, res) => {
  try {
    const { id, email, subtotal, total, note } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: "Email kötelező.",
      });
    }

    const emailTrim = email.trim().toLowerCase();
    const noteText = (note || "").trim();

    const subVal =
      subtotal === undefined || subtotal === null || subtotal === ""
        ? null
        : Number(subtotal);

    const totVal =
      total === undefined || total === null || total === ""
        ? null
        : Number(total);

    if (id) {
      const oldResult = await pool.query(
        "SELECT email FROM customers WHERE id = $1",
        [id]
      );

      if (oldResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "Ügyfél nem található.",
        });
      }

      const oldEmail = oldResult.rows[0].email;

      await pool.query(
        `UPDATE customers
         SET email = $1,
             subtotal = $2,
             total = $3,
             note = $4,
             active = TRUE
         WHERE id = $5`,
        [emailTrim, subVal, totVal, noteText, id]
      );

      if (oldEmail.toLowerCase() !== emailTrim.toLowerCase()) {
        await pool.query(
          "UPDATE users SET email = $1 WHERE LOWER(email) = LOWER($2)",
          [emailTrim, oldEmail]
        );
      }

      return res.json({
        success: true,
        message: "Ügyfél frissítve.",
      });
    }

    const existing = await pool.query(
      `SELECT id
       FROM customers
       WHERE LOWER(email) = LOWER($1) AND note = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [emailTrim, noteText]
    );

    if (existing.rows.length > 0) {
      const existingId = existing.rows[0].id;

      await pool.query(
        `UPDATE customers
         SET subtotal = $1,
             total = $2,
             note = $3,
             active = TRUE
         WHERE id = $4`,
        [subVal, totVal, noteText, existingId]
      );

      return res.json({
        success: true,
        message: "Ügyfél frissítve.",
      });
    }

    await pool.query(
      `INSERT INTO customers (email, subtotal, total, note, active)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [emailTrim, subVal, totVal, noteText]
    );

    return res.json({
      success: true,
      message: "Ügyfél elmentve.",
    });
  } catch (err) {
    console.error("❌ Save customer error:", err);

    if (err.code === "23505") {
      return res.status(400).json({
        success: false,
        error: "Ez az email már létezik a felhasználók között.",
      });
    }

    res.status(500).json({
      success: false,
      error: "Szerver hiba.",
    });
  }
});

app.post("/admin/customers/deactivate", requireAdmin, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: "Email kötelező." });
    }

    await pool.query(
      "UPDATE customers SET active = FALSE WHERE LOWER(email) = LOWER($1)",
      [email]
    );

    await deleteUser(email);

    res.json({
      success: true,
      message: "Ügyfél inaktiválva, bejelentkezés letiltva.",
    });
  } catch (err) {
    console.error("❌ Deactivate customer error:", err);
    res.status(500).json({ success: false, error: "Szerver hiba." });
  }
});

app.get("/admin", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="hu">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sonda SHOP – Admin</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: url("https://sondyshop.it.com/dog.jpg") center/cover no-repeat fixed;
      }
      .admin-page {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        background: rgba(0, 0, 0, 0.35);
      }
      .admin-card {
        width: 100%;
        max-width: 1000px;
        background: rgba(255, 255, 255, 0.96);
        border-radius: 24px;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
        padding: 24px 24px 28px;
      }
      .admin-header { text-align: center; margin-bottom: 10px; }
      .admin-header h1 { margin: 0 0 8px; font-size: 28px; }
      .admin-header p { margin: 0; font-size: 14px; color: #444; }
      #status-msg { margin-top: 10px; margin-bottom: 10px; font-size: 14px; min-height: 18px; }
      #status-msg.success { color: #2e7d32; }
      #status-msg.error { color: #c62828; }
      .section-title { margin: 18px 0 6px; font-size: 16px; font-weight: 600; }
      .admin-key-row, .form-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; }
      input[type="text"], input[type="email"], input[type="password"], input[type="number"] {
        flex: 1;
        min-width: 140px;
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid #ccc;
        font-size: 14px;
      }
      .btn-primary {
        padding: 10px 18px;
        border-radius: 8px;
        border: none;
        cursor: pointer;
        background: #007bff;
        color: #fff;
        font-size: 14px;
        font-weight: 600;
        white-space: nowrap;
      }
      .btn-primary:hover { background: #005fcc; }
      .btn-edit {
        padding: 6px 12px;
        border-radius: 6px;
        border: none;
        cursor: pointer;
        background: #1976d2;
        color: #fff;
        font-size: 13px;
      }
      .btn-edit:hover { background: #125aa0; }
      .btn-deactivate {
        padding: 6px 12px;
        border-radius: 6px;
        border: none;
        cursor: pointer;
        background: #c62828;
        color: #fff;
        font-size: 13px;
      }
      .btn-deactivate:hover { background: #a51e1e; }
      .popup-toggle-row {
        display: flex;
        align-items: center;
        gap: 10px;
        font-weight: 600;
        cursor: pointer;
      }
      .popup-toggle-row input {
        width: 20px;
        height: 20px;
        cursor: pointer;
      }
      hr { margin: 16px 0; border: none; border-top: 1px solid #ddd; }
      .table-wrapper { margin-top: 10px; overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; }
      thead { background: #f2f2f2; }
      th, td {
        padding: 8px 10px;
        border-bottom: 1px solid #eee;
        text-align: left;
        white-space: nowrap;
      }
      @media (max-width: 700px) {
        .admin-card { padding: 18px 16px 22px; border-radius: 18px; }
        .admin-header h1 { font-size: 22px; }
        .admin-key-row, .form-row { flex-direction: column; }
        input[type="text"], input[type="email"], input[type="password"], input[type="number"] { min-width: 100%; }
        .btn-primary { width: 100%; text-align: center; }
      }
    </style>
  </head>
  <body>
    <div class="admin-page">
      <div class="admin-card">
        <div class="admin-header">
          <h1>Sonda SHOP – Admin</h1>
          <p>Csak saját használatra. Itt tudod az engedélyezett email címeket kezelni.</p>
        </div>
        <div id="status-msg"></div>

        <div class="admin-key-row">
          <input id="admin-key-input" type="password" placeholder="ADMIN_KEY" />
          <button id="connect-btn" class="btn-primary">Csatlakozás</button>
        </div>

        <hr />

        <div class="section-title">Új / meglévő ügyfél mentése</div>
        <div class="form-row">
          <input id="email-input" type="email" placeholder="Email cím" />
          <input id="subtotal-input" type="number" step="0.01" placeholder="Subtotal (£)" />
          <input id="total-input" type="number" step="0.01" placeholder="Total (£)" />
        </div>
        <div class="form-row">
          <input id="note-input" type="text" placeholder="Megjegyzés (név stb.)" />
          <button id="save-btn" class="btn-primary">Mentés / frissítés</button>
        </div>

        <div class="form-row">
          <input id="search-input" type="text" placeholder="Keresés email vagy megjegyzés alapján" />
        </div>

        <hr />

        <div class="section-title">Főoldali popup üzenet</div>
        <div class="form-row">
          <textarea id="popup-message-input" placeholder="Írd ide a főoldali popup üzenetet..." rows="5" style="width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #ccc; font-size: 14px; font-family: inherit;"></textarea>
        </div>
        <div class="form-row">
          <button id="save-popup-btn" class="btn-primary">Popup üzenet mentése</button>
        </div>
        <div class="form-row" style="align-items: center; margin-top: 12px;">
          <label class="popup-toggle-row">
            <input id="popup-enabled-toggle" type="checkbox" />
            <span>Popup üzenet bekapcsolva</span>
          </label>
        </div>

        <div class="section-title">Ügyfelek</div>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Subtotal</th>
                <th>Total</th>
                <th>Aktív</th>
                <th>Művelet</th>
              </tr>
            </thead>
            <tbody id="customers-tbody"></tbody>
          </table>
        </div>
      </div>
    </div>

    <script>
      (function () {
        var adminKey = "";
        var statusBox = document.getElementById("status-msg");
        var adminKeyInput = document.getElementById("admin-key-input");
        var connectBtn = document.getElementById("connect-btn");
        var emailInput = document.getElementById("email-input");
        var subtotalInput = document.getElementById("subtotal-input");
        var totalInput = document.getElementById("total-input");
        var noteInput = document.getElementById("note-input");
        var saveBtn = document.getElementById("save-btn");
        var searchInput = document.getElementById("search-input");
        var tbody = document.getElementById("customers-tbody");
        var popupMessageInput = document.getElementById("popup-message-input");
        var savePopupBtn = document.getElementById("save-popup-btn");
        var popupEnabledToggle = document.getElementById("popup-enabled-toggle");

        var allCustomers = [];
        var editingCustomerId = null;

        function setMsg(msg, isError) {
          statusBox.textContent = msg || "";
          statusBox.className = "";
          if (!msg) return;
          statusBox.classList.add(isError ? "error" : "success");
        }

        async function loadPopupMessage() {
          if (!adminKey) return;

          try {
            var res = await fetch("/admin/settings/welcome-popup", {
              headers: { "x-admin-key": adminKey },
            });

            var data = await res.json();

            if (!res.ok || !data.success) {
              throw new Error(data.error || "Hiba popup betöltés közben.");
            }

            popupMessageInput.value = data.message || "";
            popupEnabledToggle.checked = data.enabled !== false;
          } catch (err) {
            console.error(err);
            setMsg(err.message, true);
          }
        }

        savePopupBtn.addEventListener("click", async function () {
          if (!adminKey) {
            setMsg("Először csatlakozz admin kulccsal!", true);
            return;
          }

          var popupMessage = popupMessageInput.value.trim();

          if (!popupMessage) {
            setMsg("A popup üzenet nem lehet üres.", true);
            return;
          }

          try {
            var res = await fetch("/admin/settings/welcome-popup", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-admin-key": adminKey,
              },
              body: JSON.stringify({ message: popupMessage }),
            });

            var data = await res.json();

            if (!res.ok || !data.success) {
              throw new Error(data.error || "Hiba popup mentés közben.");
            }

            setMsg(data.message || "Popup üzenet elmentve.", false);
          } catch (err) {
            console.error(err);
            setMsg(err.message, true);
          }
        });

        popupEnabledToggle.addEventListener("change", async function () {
          if (!adminKey) {
            setMsg("Először csatlakozz admin kulccsal!", true);
            popupEnabledToggle.checked = !popupEnabledToggle.checked;
            return;
          }

          try {
            var res = await fetch("/admin/settings/welcome-popup-enabled", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-admin-key": adminKey,
              },
              body: JSON.stringify({ enabled: popupEnabledToggle.checked }),
            });

            var data = await res.json();

            if (!res.ok || !data.success) {
              throw new Error(data.error || "Hiba popup kapcsoló mentés közben.");
            }

            setMsg(data.message || "Popup kapcsoló mentve.", false);
          } catch (err) {
            console.error(err);
            setMsg(err.message, true);
          }
        });

        async function fetchCustomers() {
          try {
            setMsg("Ügyfelek betöltése...", false);
            var res = await fetch("/admin/customers", {
              headers: { "x-admin-key": adminKey }
            });
            var data = await res.json();
            if (!res.ok || !data.success) {
              throw new Error(data.error || "Hiba az ügyfelek betöltése közben.");
            }
            allCustomers = data.customers || [];
            applyFilter();
            setMsg("Ügyfelek betöltve.", false);
          } catch (err) {
            console.error(err);
            setMsg(err.message, true);
          }
        }

        function renderTable(list) {
          tbody.innerHTML = "";
          list.forEach(function (c) {
            var tr = document.createElement("tr");
            tr.innerHTML =
              "<td>" + (c.email || "") + "</td>" +
              "<td>" + (c.subtotal != null ? c.subtotal : "") + "</td>" +
              "<td>" + (c.total != null ? c.total : "") + "</td>" +
              "<td>" + (c.active ? "✔" : "✖") + "</td>" +
              "<td>" +
                '<button class="btn-edit" data-id="' + c.id + '">Edit</button> ' +
                (c.active
                  ? '<button class="btn-deactivate" data-email="' + c.email + '">Törlés</button>'
                  : ""
                ) +
              "</td>";
            tbody.appendChild(tr);
          });
        }

        function applyFilter() {
          var q = (searchInput.value || "").toLowerCase();
          if (!q) {
            renderTable(allCustomers);
            return;
          }
          var filtered = allCustomers.filter(function (c) {
            var email = (c.email || "").toLowerCase();
            var note = (c.note || "").toLowerCase();
            return email.includes(q) || note.includes(q);
          });
          renderTable(filtered);
        }

        searchInput.addEventListener("input", applyFilter);

        connectBtn.addEventListener("click", function () {
          var key = adminKeyInput.value.trim();
          if (!key) {
            setMsg("Add meg az admin kulcsot!", true);
            return;
          }

          adminKey = key;
          fetchCustomers();
          loadPopupMessage();
        });

        saveBtn.addEventListener("click", async function () {
          if (!adminKey) {
            setMsg("Először csatlakozz admin kulccsal!", true);
            return;
          }
          var email = emailInput.value.trim();
          var subtotal = subtotalInput.value.trim();
          var total = totalInput.value.trim();
          var note = noteInput.value.trim();
          if (!email) {
            setMsg("Email kötelező.", true);
            return;
          }

          var payload = { email: email, note: note };

          if (editingCustomerId) {
            payload.id = editingCustomerId;
          }

          if (subtotal) payload.subtotal = parseFloat(subtotal);
          if (total) payload.total = parseFloat(total);

          try {
            var res = await fetch("/admin/customers/save", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-admin-key": adminKey
              },
              body: JSON.stringify(payload)
            });
            var data = await res.json();
            if (!res.ok || !data.success) {
              throw new Error(data.error || "Hiba mentés közben.");
            }
            setMsg(data.message || "Ügyfél elmentve / frissítve.", false);

            emailInput.value = "";
            subtotalInput.value = "";
            totalInput.value = "";
            noteInput.value = "";
            editingCustomerId = null;
            saveBtn.textContent = "Mentés / frissítés";
            fetchCustomers();
          } catch (err) {
            console.error(err);
            setMsg(err.message, true);
          }
        });

        tbody.addEventListener("click", async function (e) {
          var editBtn = e.target.closest(".btn-edit");
          if (editBtn) {
            var id = editBtn.getAttribute("data-id");

            var customer = allCustomers.find(function (c) {
              return String(c.id) === String(id);
            });

            if (!customer) {
              setMsg("Ügyfél nem található szerkesztéshez.", true);
              return;
            }

            editingCustomerId = customer.id;

            emailInput.value = customer.email || "";
            subtotalInput.value = customer.subtotal != null ? customer.subtotal : "";
            totalInput.value = customer.total != null ? customer.total : "";
            noteInput.value = customer.note || "";

            saveBtn.textContent = "Módosítás mentése";
            setMsg("Szerkesztési mód: " + (customer.email || ""), false);

            window.scrollTo({ top: 0, behavior: "smooth" });
            return;
          }

          var btn = e.target.closest(".btn-deactivate");
          if (!btn) return;

          if (!adminKey) {
            setMsg("Először csatlakozz admin kulccsal!", true);
            return;
          }

          var email = btn.getAttribute("data-email");
          if (!email) return;

          if (!confirm(email + " törlése / inaktiválása?")) return;

          try {
            var res = await fetch("/admin/customers/deactivate", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-admin-key": adminKey
              },
              body: JSON.stringify({ email: email })
            });

            var data = await res.json();

            if (!res.ok || !data.success) {
              throw new Error(data.error || "Hiba törlés közben.");
            }

            setMsg(data.message || "Ügyfél inaktiválva.", false);
            fetchCustomers();
          } catch (err) {
            console.error(err);
            setMsg(err.message, true);
          }
        });
      })();
    </script>
  </body>
</html>`);
});

app.get("/public/customers", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT email, note, subtotal, total FROM customers WHERE active = TRUE ORDER BY created_at DESC"
    );

    const data = result.rows.map((r) => ({
      "Customer Email": r.email,
      "Customer Name": r.note || "",
      Subtotal: r.subtotal !== null ? Number(r.subtotal) : null,
      Total: r.total !== null ? Number(r.total) : null,
    }));

    res.json(data);
  } catch (err) {
    console.error("❌ Public customers error:", err);
    res.status(500).json({ error: "Szerver hiba." });
  }
});

app.get("/public/settings/welcome-popup", async (req, res) => {
  try {
    const messageResult = await pool.query(
      "SELECT value FROM site_settings WHERE key = $1",
      ["welcome_popup_message"]
    );

    const enabledResult = await pool.query(
      "SELECT value FROM site_settings WHERE key = $1",
      ["welcome_popup_enabled"]
    );

    const enabled = enabledResult.rows[0]?.value !== "false";

    res.json({
      success: true,
      enabled,
      message:
        messageResult.rows[0]?.value ||
        'Facebook Megszűnik hamarosan!!! Ezen a linken Telegrammon tudtok elérni: <a href="https://t.me/SondaC" target="_blank" rel="noopener noreferrer">t.me/SondaC</a>',
    });
  } catch (err) {
    console.error("❌ Public welcome popup error:", err);
    res.status(500).json({
      success: false,
      error: "Szerver hiba.",
    });
  }
});

// ---------- START SERVER ----------

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
