import {
  sendPasswordResetEmail,
  signInWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { auth, firebaseIsConfigured } from "./firebase.js";
import { firebaseSetupError } from "./auth.js";
import {
  clearPageMessage,
  errorMessage,
  getQueryParam,
  setButtonLoading,
  showPageMessage,
  showToast
} from "./utils.js";

const form = document.getElementById("loginForm");
const message = document.getElementById("formMessage");
const submitButton = document.getElementById("loginButton");
const forgotPanel = document.getElementById("forgotPanel");
const forgotButton = document.getElementById("forgotButton");
const resetForm = document.getElementById("resetForm");
const resetMessage = document.getElementById("resetMessage");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearPageMessage(message);
  if (!firebaseIsConfigured || !auth) {
    firebaseSetupError(message);
    return;
  }
  const values = Object.fromEntries(new FormData(form));
  setButtonLoading(submitButton, true, "Connexion…");
  try {
    await signInWithEmailAndPassword(auth, values.email.trim(), values.password);
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
  if (!forgotPanel.hidden) document.getElementById("resetEmail")?.focus();
});

resetForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearPageMessage(resetMessage);
  if (!firebaseIsConfigured || !auth) {
    firebaseSetupError(resetMessage);
    return;
  }
  const email = new FormData(resetForm).get("resetEmail").trim();
  const button = resetForm.querySelector("button");
  setButtonLoading(button, true, "Envoi…");
  try {
    await sendPasswordResetEmail(auth, email);
    showPageMessage(resetMessage, "E-mail envoyé. Consultez votre boîte de réception et vos indésirables.", "success");
    showToast("Lien de réinitialisation envoyé.");
  } catch (error) {
    showPageMessage(resetMessage, errorMessage(error));
  } finally {
    setButtonLoading(button, false);
  }
});
