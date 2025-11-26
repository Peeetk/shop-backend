// login.js

const form = document.getElementById("login-form");
const errorBox = document.getElementById("login-error");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.style.display = "none";

  const emailInput = document.getElementById("email");
  const email = emailInput.value.trim();

  if (!email) {
    errorBox.textContent = "Kérlek, add meg az email címed.";
    errorBox.style.display = "block";
    return;
  }

  try {
    const res = await fetch("https://shop-backend-dom2.onrender.com/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    if (!res.ok) {
      // 401 = not found in customers.json
      errorBox.textContent = "Ez az email cím nincs a rendszerben.";
      errorBox.style.display = "block";
      return;
    }

    const data = await res.json();

    if (data.success) {
      // ✅ save login locally and go to main shop
      localStorage.setItem("loggedInEmail", email);
      window.location.href = "index.html";
    } else {
      errorBox.textContent = "Ez az email cím nincs a rendszerben.";
      errorBox.style.display = "block";
    }
  } catch (err) {
    console.error("Login error:", err);
    errorBox.textContent = "Hiba történt. Próbáld újra később.";
    errorBox.style.display = "block";
  }
});
