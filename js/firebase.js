import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const configValues = Object.values(firebaseConfig);
export const firebaseIsConfigured = configValues.length > 0 && configValues.every(
  (value) => typeof value === "string" && value.trim() && !value.includes("REMPLACEZ_")
);

let app = null;
let auth = null;
let db = null;

if (firebaseIsConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
} else {
  console.warn("Firebase n'est pas encore configuré. Complétez js/firebase-config.js.");
}

export { app, auth, db };
