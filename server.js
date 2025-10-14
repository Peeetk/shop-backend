import express from "express";
import Stripe from "stripe";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ✅ Use environment variable for security (Render will store your real key)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.static(path.join(__dirname, "public"))); // serve your frontend if needed
app.use(express.json());

// 💳 Checkout endpoint
app.post("/create-checkout-session", async (req, res) => {
  console.log("📩 Received request:", req.body);

  try {
    const items = req.body.cart || [];
    if (!items.length) {
      console.log("❌ Cart is empty");
      return res.status(400).json({ error: "Cart is empty" });
    }

    const line_items = items.map(i => ({
      price_data: {
        currency: "gbp",
        product_data: { name: i.name },
        unit_amount: Math.round(i.price * 100), // Stripe expects pence
      },
      quantity: i.quantity,
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items,
      // ✅ Update these URLs to your live frontend (Netlify) URLs
      success_url: "https://yourfrontend.netlify.app/success.html",
      cancel_url: "https://yourfrontend.netlify.app/cancel.html",
    });

    console.log("✅ Stripe session created:", session.id);
    res.json({ id: session.id });
  } catch (err) {
    console.error("❌ Stripe error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ⚙️ Render provides PORT automatically
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
