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
  origin: "https://sondypayee.netlify.app" // your live frontend URL
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
    const items = req.body.cart || [];
    if (!items.length) return res.status(400).json({ error: "Cart is empty" });

    const line_items = items.map(i => ({
      price_data: {
        currency: "gbp",
        product_data: { name: i.name },
        unit_amount: Math.round(i.price * 100), // convert £ to pence
      },
      quantity: i.quantity,
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items,
      success_url: "https://sondypayee.netlify.app/success.html",
      cancel_url: "https://sondypayee.netlify.app/cancel.html",
    });

    res.json({ id: session.id });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Test Stripe connection
app.get("/test", async (req, res) => {
  try {
    const account = await stripe.accounts.retrieve();
    console.log("Full account object:", account); // 👈 add this
    res.send(`✅ Connected to Stripe account: ${account.id}`);
  } catch (err) {
    console.error("Stripe test failed:", err);
    res.status(500).send("❌ Stripe error: " + err.message);
  }
});

app.get("/", (req, res) => {
  res.send("✅ Stripe backend is running successfully!");
});

// ✅ Start the server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
