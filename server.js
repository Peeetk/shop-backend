// ✅ Load environment variables FIRST
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") }); // load .env from this folder

import express from "express";
import Stripe from "stripe";
import cors from "cors";

const app = express();

// ✅ Enable CORS for your Netlify frontend
app.use(cors({
  origin: "https://sondypayee.netlify.app", // your live frontend URL
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

// ✅ Confirm that the Stripe key is loaded (for debugging)
console.log("Stripe key detected:", process.env.STRIPE_SECRET_KEY ? "✅ Loaded" : "❌ Not found");

// ✅ Initialize Stripe with your environment variable
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Middleware
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// 💳 Create checkout session
app.post("/create-checkout-session", async (req, res) => {
  try {
    const cart = req.body.cart || [];
    console.log("📩 Received cart:", cart);

    if (!cart.length) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const line_items = cart.map(i => {
      let amount = parseFloat(i.price ?? i.amount);
      if (isNaN(amount)) {
        amount = Number(String(i.price ?? i.amount).replace(",", "."));
      }

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

    console.log("🧾 Stripe line_items:", JSON.stringify(line_items, null, 2));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items,
      success_url: "https://sondypayee.netlify.app/success.html",
      cancel_url: "https://sondypayee.netlify.app/cancel.html",
    });

    console.log("✅ Stripe session created:", session.id);
    res.json({ id: session.id });
  } catch (err) {
    console.error("❌ Stripe error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Test Stripe connection
app.get("/test", async (req, res) => {
  try {
    const account = await stripe.accounts.retrieve();
    console.log("Full account object:", account);
    res.send(`✅ Connected to Stripe account: ${account.id}`);
  } catch (err) {
    console.error("Stripe test failed:", err);
    res.status(500).send("❌ Stripe error: " + err.message);
  }
});

// 🧭 Root route
app.get("/", (req, res) => {
  res.send("✅ Stripe backend is running successfully!");
});

// 🧩 Debug route
app.get("/debug-env", (req, res) => {
  res.json({
    stripeKeyLoaded: !!process.env.STRIPE_SECRET_KEY,
    stripeKeyPrefix: process.env.STRIPE_SECRET_KEY
      ? process.env.STRIPE_SECRET_KEY.slice(0, 10)
      : null
  });
});

// ✅ Start the server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

import nodemailer from "nodemailer";

// 📧 Create reusable transporter
const transporter = nodemailer.createTransport({
  service: "gmail", // or "hotmail" / "outlook" etc.
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS, // app password
  },
});

app.post("/notify-payment", async (req, res) => {
  try {
    const { date } = req.body;
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: "your.email@example.com", // 👈 your inbox
      subject: "💰 New Payment Completed",
      text: `Someone has completed a payment on ${date}.`,
    });

    console.log("📧 Email sent successfully!");
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Email sending failed:", err);
    res.status(500).json({ error: err.message });
  }
});
