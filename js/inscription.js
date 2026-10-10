import { createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { doc, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { auth, db, firebaseIsConfigured } from "./firebase.js";
import { firebaseSetupError } from "./auth.js";
import {
  clearPageMessage,
  errorMessage,
  isValidIvorianPhone,
  normalizeIvorianPhone,
  setButtonLoading,
  showPageMessage
} from "./utils.js";

const form = document.getElementById("signupForm");
const message = document.getElementById("formMessage");
const submitButton = document.getElementById("signupButton");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearPageMessage(message);
  if (!firebaseIsConfigured || !auth || !db) {
    firebaseSetupError(message);
    return;
  }

  const values = Object.fromEntries(new FormData(form));
  const name = values.name.trim();
  const city = values.city.trim();
  const phone = normalizeIvorianPhone(values.phone);
  const email = values.email.trim();
  const password = values.password;

  if (name.length < 2) {
    showPageMessage(message, "Indiquez le nom de votre agence.");
    return;
  }
  if (city.length < 2) {
    showPageMessage(message, "Indiquez la ville de votre agence.");
    return;
  }
  if (!isValidIvorianPhone(phone)) {
    showPageMessage(message, "Saisissez un numéro ivoirien valide (10 chiffres, ex. 0700000000).");
    return;
  }
  if (password.length < 6) {
    showPageMessage(message, "Le mot de passe doit contenir au moins 6 caractères.");
    return;
  }
  if (password !== values.confirmPassword) {
    showPageMessage(message, "Les deux mots de passe ne correspondent pas.");
    return;
  }

  setButtonLoading(submitButton, true, "Création…");
  try {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, "agences", credential.user.uid), {
      name,
      city,
      phone,
      email,
      createdAt: serverTimestamp(),
      createdAtISO: new Date().toISOString()
    });
    window.location.href = "dashboard.html";
  } catch (error) {
    showPageMessage(message, errorMessage(error));
  } finally {
    setButtonLoading(submitButton, false);
  }
});
