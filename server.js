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

// Normalize connection string in case it starts with postgresql://
let dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.error("❌ No DATABASE_URL set!");
}

if (dbUrl && dbUrl.startsWith("postgresql://")) {
  dbUrl = "postgres://" + dbUrl.slice("postgresql://".length);
}

const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl ? { rejectUnauthorized: false } : false, // required for Render Postgres
});

// ---------- TABLE INIT ----------

async function initCustomersTable() {
  try {
    // 🔹 If an *old* table exists with UNIQUE(email), drop that constraint
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

    // 🔹 Ensure table exists (without UNIQUE on email)
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

initCustomersTable();
initUsersTable();

// ---------- ADMIN + CUSTOMER HELPERS ----------

const ADMIN_KEY = process.env.ADMIN_KEY || "";

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(403).json({ error: "Nem jogosult." });
  }
  next();
}

// ✅ Allowed customer emails now come ONLY from Postgres
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
      "https://sondyshop.it.com",      // primary domain
      "https://www.sondyshop.it.com",  // www alias (redirects)
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

// 🧾 Register – ONLY emails from *customers table* can register
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

    // ✅ check allowed emails from Postgres
    const allowedEmails = await readCustomerEmails();
    if (!allowedEmails.includes(emailLower)) {
      return res.status(400).json({
        error:
          "Ezzel az email címmel nem lehet regisztrálni. " +
          "Használd azt az email címet, amellyel az előfizetés készült, vagy vedd fel velünk a kapcsolatot.",
      });
    }

    // check if user already exists in DB
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

// 🔑 Login
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

// 🔐 Change password
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

// ❌ Delete account
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

// 🔁 Forgot password
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
        "https://www.sondyshop.it.com/success.html?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://www.sondyshop.it.com/cancel.html",
    });

    res.json({ id: session.id });
  } catch (err) {
    console.error("❌ Error creating checkout session:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// used by success.html to show payment info
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
      to: "your.email@example.com", // change to your real email
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

// list customers
app.get("/admin/customers", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, subtotal, total, note, active, created_at
       FROM customers
       ORDER BY created_at DESC`
    );
    res.json({ success: true, customers: result.rows });
  } catch (err) {
    console.error("❌ List customers error:", err);
    res.status(500).json({ error: "Szerver hiba." });
  }
});

// add/update customer
app.post("/admin/customers", requireAdmin, async (req, res) => {
  try {
    const { email, subtotal, total, note } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email kötelező." });
    }

    const emailLower = email.trim().toLowerCase();

    await pool.query(
      `
      INSERT INTO customers (email, subtotal, total, note, active)
      VALUES ($1, $2, $3, $4, TRUE)
      `,
      [emailLower, subtotal || null, total || null, note || null]
    );

    res.json({ success: true, message: "Ügyfél elmentve." });
  } catch (err) {
    console.error("❌ Save customer error:", err);
    res.status(500).json({ error: "Szerver hiba mentés közben." });
  }
});


// deactivate customer
app.post("/admin/customers/deactivate", requireAdmin, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email kötelező." });
    }

    await pool.query(
      "UPDATE customers SET active = FALSE WHERE LOWER(email) = LOWER($1)",
      [email]
    );

    res.json({ success: true, message: "Ügyfél inaktiválva." });
  } catch (err) {
    console.error("❌ Deactivate customer error:", err);
    res.status(500).json({ error: "Szerver hiba." });
  }
});

// simple admin UI
app.get("/admin", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="hu">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sonda SHOP – Admin</title>
  <style>
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
        sans-serif;
      background: #f4f4f4;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .admin-box {
      background: #ffffff;
      padding: 24px;
      border-radius: 16px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.15);
      max-width: 700px;
      width: 100%;
    }
    h1 {
      margin-top: 0;
      margin-bottom: 8px;
      font-size: 1.4rem;
    }
    p {
      margin-top: 0;
      font-size: 0.9rem;
      color: #555;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 8px;
    }
    input, button {
      padding: 6px 8px;
      font-size: 0.9rem;
    }
    input {
      flex: 1;
      min-width: 120px;
    }
    button {
      cursor: pointer;
      border-radius: 4px;
      border: 1px solid #1976d2;
      background: #1976d2;
      color: #fff;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      font-size: 0.85rem;
    }
    th, td {
      border-bottom: 1px solid #ddd;
      padding: 4px 6px;
      text-align: left;
    }
    th {
      background: #f0f0f0;
    }
    .msg {
      min-height: 1.2em;
      font-size: 0.85rem;
      margin-top: 4px;
    }
    .msg.error { color: #c62828; }
    .msg.success { color: #2e7d32; }
  </style>
</head>
<body>
  <div class="admin-box">
    <h1>Sonda SHOP – Admin</h1>
    <p>Csak saját használatra. Itt tudod az engedélyezett email címeket kezelni.</p>

    <div class="row">
      <input type="password" id="admin-key" placeholder="ADMIN_KEY" />
      <button id="btn-connect">Csatlakozás</button>
    </div>
    <div id="msg" class="msg"></div>

    <hr />

    <h2 style="font-size:1rem;">Új / meglévő ügyfél mentése</h2>
    <div class="row">
      <input type="email" id="cust-email" placeholder="Email cím" />
      <input type="number" step="0.01" id="cust-subtotal" placeholder="Subtotal (£)" />
      <input type="number" step="0.01" id="cust-total" placeholder="Total (£)" />
    </div>
    <div class="row">
      <input type="text" id="cust-note" placeholder="Megjegyzés (név stb.)" />
      <button id="btn-save">Mentés / frissítés</button>
    </div>

   <h2 style="font-size:1rem;margin-top:16px;">Ügyfelek</h2>
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
  <tbody id="cust-table-body"></tbody>
</table>

  </div>

  <script>
    let adminKey = "";
    const msgEl = document.getElementById("msg");
    const tbody = document.getElementById("cust-table-body");

    function setMsg(text, error) {
      msgEl.textContent = text || "";
      msgEl.className = "msg " + (error ? "error" : "success");
    }

    async function fetchCustomers() {
      if (!adminKey) return;
      try {
        const res = await fetch("/admin/customers", {
          headers: { "x-admin-key": adminKey }
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || "Hiba történt.");
        }
        tbody.innerHTML = "";
        data.customers.forEach(c => {
          const tr = document.createElement("tr");
          tr.innerHTML =
            "<td>" + c.email + "</td>" +
            "<td>" + (c.subtotal ?? "") + "</td>" +
            "<td>" + (c.total ?? "") + "</td>" +
            "<td>" + (c.active ? "✔" : "✖") + "</td>" +
            "<td>" +
              (c.active
                ? '<button class="btn-deactivate" data-email="' + c.email + '">Törlés</button>'
                : ""
              ) +
            "</td>";
          tbody.appendChild(tr);
        });


      } catch (err) {
        setMsg(err.message, true);
      }
    }

    document.getElementById("btn-connect").addEventListener("click", async () => {
      adminKey = document.getElementById("admin-key").value.trim();
      if (!adminKey) {
        setMsg("Add meg az admin kulcsot!", true);
        return;
      }
      setMsg("Kapcsolódás...");
      await fetchCustomers();
      setMsg("Kapcsolódva.", false);
    });

    document.getElementById("btn-save").addEventListener("click", async () => {
      if (!adminKey) {
        setMsg("Először csatlakozz admin kulccsal!", true);
        return;
      }
      const email = document.getElementById("cust-email").value.trim();
      const subtotal = document.getElementById("cust-subtotal").value;
      const total = document.getElementById("cust-total").value;
      const note = document.getElementById("cust-note").value.trim();

      if (!email) {
        setMsg("Email kötelező.", true);
        return;
      }

      try {
        const res = await fetch("/admin/customers", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-admin-key": adminKey
          },
          body: JSON.stringify({
            email,
            subtotal: subtotal || null,
            total: total || null,
            note
          })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || "Hiba mentés közben.");
        }
        setMsg(data.message || "Mentve.", false);
        await fetchCustomers();
      } catch (err) {
        setMsg(err.message, true);
      }
    });
    // Handle delete / deactivate clicks
// Handle delete / deactivate clicks
tbody.addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn-deactivate");
  if (!btn) return;

  if (!adminKey) {
    setMsg("Először csatlakozz admin kulccsal!", true);
    return;
  }

  const email = btn.dataset.email;
  if (!confirm(email + " törlése / inaktiválása?")) return;

  try {
    const res = await fetch("/admin/customers/deactivate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": adminKey
      },
      body: JSON.stringify({ email })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || "Hiba törlés közben.");
    }

    setMsg(data.message || "Ügyfél inaktiválva.", false);
    await fetchCustomers();
  } catch (err) {
    setMsg(err.message, true);
  }
});


  </script>
</body>
</html>`);
});

// Public endpoint for frontend name suggestions
// Public endpoint for frontend name suggestions
app.get("/public/customers", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT email, note, subtotal, total FROM customers WHERE active = TRUE ORDER BY created_at DESC"
    );

    const data = result.rows.map((r) => ({
      "Customer Email": r.email,
      "Customer Name": r.note || "",
      "Subtotal": r.subtotal !== null ? Number(r.subtotal) : null,
      "Total": r.total !== null ? Number(r.total) : null,
    }));

    res.json(data);
  } catch (err) {
    console.error("❌ Public customers error:", err);
    res.status(500).json({ error: "Szerver hiba." });
  }
});



// ---------- START SERVER ----------

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
