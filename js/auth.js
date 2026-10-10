import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { auth, firebaseIsConfigured } from "./firebase.js";
import { redirectToLogin, showPageMessage, showToast } from "./utils.js";

export function firebaseSetupError(target = "#pageMessage") {
  showPageMessage(
    target,
    "Firebase n'est pas configuré. Complétez le fichier js/firebase-config.js avant d'utiliser l'application.",
    "error"
  );
}

export function getCurrentUser() {
  return auth?.currentUser || null;
}

export function waitForAuthState() {
  return new Promise((resolve) => {
    if (!firebaseIsConfigured || !auth) {
      resolve(null);
      return;
    }
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

export async function requireAgency({ messageTarget = "#pageMessage" } = {}) {
  if (!firebaseIsConfigured || !auth) {
    firebaseSetupError(messageTarget);
    return null;
  }
  const user = await waitForAuthState();
  if (!user) {
    redirectToLogin();
    return null;
  }
  return user;
}

export async function logout() {
  if (!firebaseIsConfigured || !auth) return;
  try {
    await signOut(auth);
    window.location.href = "connexion.html";
  } catch (error) {
    showToast("La déconnexion a échoué. Réessayez.", "error");
  }
}
