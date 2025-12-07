// ⚙️ Stripe publishable key
const stripe = Stripe("pk_live_51N67KeFYbT9vhXCbG4eD7Zru8jC4gE6TJCRblelKS4h6TwEC75dKDUhq7cy9o2xee0OVC2EG2OOi7S6MLuGLqM5Q00rtiPwVw5");

let cart = [];
let customers = [];
let selectedCustomerId = null;

document.addEventListener("DOMContentLoaded", () => {
  const searchInput = document.getElementById("customer-search");
  const customerList = document.getElementById("customer-list");

  // 🛒 Update cart count
  function updateCartCount() {
    document.getElementById("cart-count").textContent = cart.length;
  }

  // 🧍 Display matching customer entries
  function displayCustomers(list) {
    customerList.innerHTML = "";

    if (list.length === 0) {
      customerList.style.display = "none";
      return;
    }

    customerList.style.display = "block";

    list.forEach(customer => {
      const li = document.createElement("li");
      li.textContent = customer.name;
      li.style.cursor = "pointer";

      li.addEventListener("click", () => {
        selectedCustomerId = customer.id || null;

        const item = {
          name: `Customer: ${customer.name}`,
          price: parseFloat(customer.total), // ensure numeric
          quantity: 1
        };

        cart.push(item);
        updateCartCount();

        alert(`${customer.name} added to cart (£${item.price.toFixed(2)})`);
        customerList.innerHTML = "";
        searchInput.value = customer.name;
      });

      customerList.appendChild(li);
    });
  }

  // 🔍 Search filter with shorthand matching
  searchInput.addEventListener("input", () => {
    const query = searchInput.value.toLowerCase().trim();

    if (query === "") {
      customerList.style.display = "none";
      return;
    }

    const filtered = customers.filter(c => {
      const nameParts = c.name.toLowerCase().split(" ");
      if (nameParts.length < 2) return false;

      const first = nameParts[0];
      const second = nameParts[1];
      const last = nameParts[nameParts.length - 1];

      const initials = [
        `${first} ${second[0]}`,
        `${first} ${last[0]}`,
        `${second} ${first[0]}`,
        `${last} ${first[0]}`
      ];

      return initials.includes(query);
    });

    if (filtered.length > 0) {
      displayCustomers(filtered);
    } else {
      customerList.style.display = "none";
    }
  });

  // 📦 Add product to cart
  document.querySelectorAll(".add-to-cart").forEach(button => {
    button.addEventListener("click", e => {
      const product = e.target.closest(".product");
      const item = {
        name: product.dataset.name,
        price: parseFloat(product.dataset.price), // ensure numeric
        quantity: 1
      };
      cart.push(item);
      updateCartCount();
      alert(`${item.name} added to cart!`);
    });
  });

  // 💷 Add custom amount
  const addCustomBtn = document.getElementById("add-custom");
  const customAmountInput = document.getElementById("custom-amount");

  addCustomBtn.addEventListener("click", () => {
    const amount = parseFloat(customAmountInput.value);
    if (isNaN(amount) || amount <= 0) {
      alert("Please enter a valid amount!");
      return;
    }

    const item = {
      name: "Custom Amount",
      price: amount,
      quantity: 1
    };

    cart.push(item);
    updateCartCount();
    alert(`£${amount.toFixed(2)} added to cart!`);
    customAmountInput.value = "";
  });

  // 💳 Checkout logic
// 💳 Checkout
const cartButton = document.getElementById("cart-button");
cartButton.addEventListener("click", () => {
  if (cart.length === 0) {
    alert("Your cart is empty!");
    return;
  }

  // 🧩 Prepare data for backend (numbers only)
  const formattedCart = cart.map(item => ({
    name: item.name,
    price: parseFloat(item.price), // use "price" to match backend
    quantity: item.quantity
  }));

  console.log("🛒 Sending cart:", formattedCart); // for debugging

  // ✅ Send formatted cart to backend
fetch("https://shop-backend-dom2.onrender.com/create-checkout-session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    cart: formattedCart,
    customerName: selectedCustomerId
      ? customers.find(c => c.id === selectedCustomerId)?.name || "Unknown Customer"
      : searchInput.value || "Unknown Customer"
  })
})
  .then(res => res.json())
  .then(data => {
    console.log("💬 Server returned:", data);
    if (!data.id) throw new Error("Missing session ID from server!");
    return stripe.redirectToCheckout({ sessionId: data.id });
  })
  .catch(err => alert("Error: " + err.message));
});


  // 📁 Load customers
  // 📁 Load customers from backend (Postgres)
  fetch("https://shop-backend-dom2.onrender.com/public/customers")
    .then(res => res.json())
    .then(data => {
      customers = data.map(entry => {
        const amount = entry["Total"] ?? entry["Subtotal"] ?? 0;
        return {
          name: entry["Customer Name"],
          total: parseFloat(amount) || 0,
          id: entry["Customer ID"] || null
        };
      });
    })
    .catch(err => {
      console.error("❌ Failed to load customers:", err);
    });
});



