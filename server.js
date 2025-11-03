// ✅ Load environment variables FIRST
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import Stripe from "stripe";
import cors from "cors";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") }); // load .env from this folder

const app = express();

// ✅ Enable CORS for your Netlify frontend
app.use(cors({
  origin: "https://sondypayee.netlify.app", // your live frontend URL
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

// ✅ Confirm that the Stripe key is loaded (for debugging)
console.log("Stripe key detected:", process.env.STRIPE_SECRET_KEY ? "✅ Loaded" : "❌ Not found");

// ✅ Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Middleware
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// 💳 Create checkout session
app.post("/create-checkout-session", async (req, res) => {
  try {
    const cart = req.body.cart || [];
    console.log("📩 Received cart:", cart);

    if (!cart.length) return res.status(400).json({ error: "Cart is empty" });

    const line_items = cart.map(i => {
      let amount = parseFloat(i.price ?? i.amount);
      if (isNaN(amount)) amount = Number(String(i.price ?? i.amount).replace(",", "."));
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
      success_url: "https://sondypayee.netlify.app/success.html?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://sondypayee.netlify.app/cancel.html",
    });

    console.log("✅ Stripe session created:", session.id);
    res.json({ id: session.id });
  } catch (err) {
    console.error("❌ Stripe error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Stripe test route
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

// ✅ Root route
app.get("/", (req, res) => {
  res.send("✅ Stripe backend is running successfully!");
});

// ✅ Debug route
app.get("/debug-env", (req, res) => {
  res.json({
    stripeKeyLoaded: !!process.env.STRIPE_SECRET_KEY,
    stripeKeyPrefix: process.env.STRIPE_SECRET_KEY
      ? process.env.STRIPE_SECRET_KEY.slice(0, 10)
      : null
  });
});

// ✅ NEW — Fetch checkout session details
app.get("/checkout-session", async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: "Missing session_id" });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);

    res.json({
      id: session.id,
      amount_total: session.amount_total / 100,
      currency: session.currency,
      date: new Date(session.created * 1000).toLocaleDateString(),
    });
  } catch (err) {
    console.error("❌ Error retrieving session:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Email notification setup
const transporter = nodemailer.createTransport({
  service: "gmail", // You can replace with "hotmail", etc.
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS, // app password or mail token
  },
});

app.post("/notify-payment", async (req, res) => {
  try {
    const { date } = req.body;
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: "your.email@example.com", // 👈 replace with your actual email
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

// ✅ Start the server
const PORT = process.env.PORT || 10000;
// ✅ Get Stripe checkout session details
app.get("/checkout-session", async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) {
      return res.status(400).json({ error: "Missing session_id" });
    }

    // Retrieve session info from Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id);

    res.json({
      id: session.id,
      amount_total: session.amount_total / 100, // convert from pence to GBP
      currency: session.currency,
      date: new Date(session.created * 1000).toLocaleDateString("en-GB"),
      customer_email: session.customer_details?.email || "Unknown",
    });
  } catch (err) {
    console.error("❌ Error fetching session:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
