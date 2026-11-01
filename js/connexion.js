import { api } from "./api.js";
import {
  clearPageMessage,
  errorMessage,
  getQueryParam,
  initPasswordToggles,
  setButtonLoading,
  showPageMessage
} from "./utils.js";

const form = document.getElementById("loginForm");
const message = document.getElementById("formMessage");
const submitButton = document.getElementById("loginButton");
const forgotPanel = document.getElementById("forgotPanel");
const forgotButton = document.getElementById("forgotButton");
const forgotWhatsappLink = document.getElementById("forgotWhatsappLink");

initPasswordToggles();

function syncForgotWhatsappLink() {
  if (!forgotWhatsappLink) return;
  const email = document.getElementById("loginEmail")?.value?.trim() || "";
  const text = email
    ? `Bonjour COLIS EXPRESS, j'ai oublié le mot de passe de mon compte (${email}) et je souhaite réinitialiser mon accès.`
    : "Bonjour COLIS EXPRESS, j'ai oublié le mot de passe de mon compte agence et je souhaite réinitialiser mon accès.";
  forgotWhatsappLink.href = `https://wa.me/2250501303343?text=${encodeURIComponent(text)}`;
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearPageMessage(message);
  const values = Object.fromEntries(new FormData(form));
  setButtonLoading(submitButton, true, "Connexion…");
  try {
    await api("/api/login", {
      method: "POST",
      body: { email: values.email.trim(), password: values.password }
    });
    const retour = getQueryParam("retour");
    // Empêche les redirections externes depuis un paramètre manipulé.
    window.location.href = retour && /^[a-zA-Z0-9_.-]+\.html(?:\?.*)?$/.test(retour)
      ? retour
      : "dashboard.html";
  } catch (error) {
    showPageMessage(message, errorMessage(error));
  } finally {
    setButtonLoading(submitButton, false);
  }
});

forgotButton?.addEventListener("click", () => {
  forgotPanel.hidden = !forgotPanel.hidden;
  syncForgotWhatsappLink();
});
document.getElementById("loginEmail")?.addEventListener("input", syncForgotWhatsappLink);
