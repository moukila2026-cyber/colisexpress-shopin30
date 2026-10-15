import { api } from "./api.js";
import { redirectToLogin, showToast } from "./utils.js";

/**
 * Session courante : renvoie le profil de l'agence connectée,
 * ou redirige vers la page de connexion.
 */
export async function requireAgency({ messageTarget = "#pageMessage" } = {}) {
  try {
    const { agency, member } = await api("/api/me");
    if (!agency) return null;
    // Membre connecté (gérant ou agent) : sert à l'affichage et aux garde-fous
    // d'interface — les vraies autorisations restent côté serveur.
    return { ...agency, member };
  } catch (error) {
    if (error.status === 401) {
      redirectToLogin();
      return null;
    }
    showToast(error.message, "error");
    return null;
  }
}

export async function logout() {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    // La session côté serveur est déjà perdue ou le réseau est coupé :
    // on redirige quand même vers la connexion.
  }
  window.location.href = "connexion.html";
}
