// ✅ Load environment variables FIRST
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import Stripe from "stripe";
import cors from "cors";
import nodemailer from "nodemailer";
import fs from "fs/promises";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") }); // load .env from this folder

const app = express();

// ---------- USER / CUSTOMER HELPERS ----------

const USERS_FILE = path.join(__dirname, "customers.json");
const CUSTOMERS_FILE = path.join(__dirname, "customers.json");

async function readUsers() {
  try {
    const data = await fs.readFile(USERS_FILE, "utf8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeUsers(users) {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

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

// read all allowed customer emails from customers.json
async function readCustomerEmails() {
  try {
    const data = await fs.readFile(CUSTOMERS_FILE, "utf8");
    const list = JSON.parse(data);
    return list
      .map((item) => (item["Customer Email"] || "").trim().toLowerCase())
      .filter(Boolean);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

// ---------- MIDDLEWARE / STRIPE / EMAIL ----------

// CORS for Netlify + local dev
app.use(
  cors({
    origin: [
      "https://sondypayee.netlify.app",
      "http://127.0.0.1:5500",
      "http://localhost:5500",
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// Stripe
console.log(
  "Stripe key detected:",
  process.env.STRIPE_SECRET_KEY ? "✅ Loaded" : "❌ Not found"
);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Static + JSON parsing
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

transporter.verify((err, success) => {
  if (err) {
    console.error("❌ Email transporter error:", err);
  } else {
    console.log("✅ Email transporter ready");
  }
});

// ---------- AUTH ROUTES ----------

// 🧾 Register – ONLY emails from customers.json can register
app.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email és jelszó kötelező." });
    }
    if (password.length < 6) {
      return res.status(400).json({
        error: "A jelszónak legalább 6 karakter hosszúnak kell lennie.",
      });
    }

    const emailLower = email.trim().toLowerCase();

    // check allowed emails from customers.json
    const allowedEmails = await readCustomerEmails();
    if (!allowedEmails.includes(emailLower)) {
      return res.status(400).json({
        error:
          "Ezzel az email címmel nem lehet regisztrálni. " +
          "Használd azt az email címet, amellyel az előfizetés készült, vagy vedd fel velünk a kapcsolatot.",
      });
    }

    const users = await readUsers();
    const exists = users.find((u) => u.email.toLowerCase() === emailLower);
    if (exists) {
      return res
        .status(400)
        .json({ error: "Ezzel az email címmel már van fiók." });
    }

    const user = {
      id: Date.now(),
      email: emailLower,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    };

    users.push(user);
    await writeUsers(users);

    res.json({ success: true, message: "Sikeres regisztráció!" });
  } catch (err) {
    console.error("❌ Register error:", err);
    res.status(500).json({ error: "Szerver hiba regisztráció közben." });
  }
});

// 🔑 Login
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email és jelszó kötelező." });
    }

    const users = await readUsers();
    const user = users.find(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: "Hibás email vagy jelszó." });
    }

    res.json({ success: true, email: user.email });
  } catch (err) {
    console.error("❌ Login error:", err);
    res
      .status(500)
      .json({ error: "Szerver hiba bejelentkezés közben." });
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
      return res.status(400).json({
        error: "Az új jelszónak legalább 6 karakter hosszúnak kell lennie.",
      });
    }

    const users = await readUsers();
    const index = users.findIndex(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );
    if (index === -1) {
      return res.status(404).json({ error: "Felhasználó nem található." });
    }

    const user = users[index];

    if (!verifyPassword(oldPassword, user.passwordHash)) {
      return res.status(401).json({ error: "Hibás régi jelszó." });
    }

    users[index].passwordHash = hashPassword(newPassword);
    await writeUsers(users);

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

    const users = await readUsers();
    const index = users.findIndex(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );
    if (index === -1) {
      return res.status(404).json({ error: "Felhasználó nem található." });
    }

    const user = users[index];
    if (!verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: "Hibás jelszó." });
    }

    users.splice(index, 1);
    await writeUsers(users);

    res.json({ success: true, message: "Fiók törölve." });
  } catch (err) {
    console.error("❌ Delete account error:", err);
    res.status(500).json({ error: "Szerver hiba fiók törlése közben." });
  }
});

// 🔁 Forgot password – generate temp password and send email
app.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email kötelező." });
    }

    const users = await readUsers();
    const index = users.findIndex(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );

    // Always respond generically if user not found
    if (index === -1) {
      return res.json({
        success: true,
        message:
          "Ha létezik ilyen email cím, küldtünk egy új jelszót.",
      });
    }

    const tempPassword = crypto.randomBytes(4).toString("hex"); // 8 chars
    users[index].passwordHash = hashPassword(tempPassword);
    await writeUsers(users);

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Új ideiglenes jelszó - Sonda SHOP",
      text:
        `Új ideiglenes jelszót kértél a Sonda SHOP oldalán.\n\n` +
        `Ideiglenes jelszavad: ${tempPassword}\n\n` +
        `Jelentkezz be ezzel a jelszóval, majd a fiókban változtasd meg egy saját jelszóra.`,
    });

    console.log("📧 Temporary password email sent to:", email);

    res.json({
      success: true,
      message:
        "Ha létezik ilyen email cím, küldtünk egy új jelszót.",
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
        "https://sondypayee.netlify.app/success.html?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://sondypayee.netlify.app/cancel.html",
    });

    console.log("✅ Stripe session created:", session.id);
    res.json({ id: session.id });
  } catch (err) {
    console.error("❌ Stripe error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// simple test route for session by id
app.get("/session/:id", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id);
    res.json({
      customer_name: session.metadata.customer_name,
      amount_total: session.amount_total,
    });
  } catch (err) {
    console.error("❌ Failed to fetch session:", err.message);
    res
      .status(500)
      .json({ error: "Failed to retrieve session details." });
  }
});

// root + debug
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
      to: "your.email@example.com", // change this to your real email
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

// ---------- START SERVER ----------

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
