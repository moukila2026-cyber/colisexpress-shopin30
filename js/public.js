import { api } from "./api.js";
import {
  clearPageMessage,
  escapeHTML,
  formatFCFA,
  isTrackingCodeValid,
  normalizeTrackingCode,
  setButtonLoading,
  showPageMessage,
  whatsappShareLink
} from "./utils.js";

const form = document.getElementById("trackingHomeForm");
const input = document.getElementById("trackingCode");
const message = document.getElementById("trackingMessage");

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  clearPageMessage(message);
  const code = normalizeTrackingCode(input.value);
  if (!isTrackingCodeValid(code)) {
    showPageMessage(message, "Saisissez un code valide au format CLI-XXXXXX.");
    input.focus();
    return;
  }
  window.location.href = `suivi.html?code=${encodeURIComponent(code)}`;
});

input?.addEventListener("input", () => {
  input.value = normalizeTrackingCode(input.value);
});

/* ------------------------- devis public (LOT 3) --------------------------- */

const devisForm = document.getElementById("devisForm");
const devisMessage = document.getElementById("devisMessage");
const devisResult = document.getElementById("devisResult");
const devisButton = document.getElementById("devisButton");

function offreHtml(offre, devis) {
  const texte = `Bonjour ${offre.agence.name}, je souhaite envoyer un colis de ${devis.originCity} à ${devis.destinationCity} (${devis.weightKg} kg${devis.packageNature ? `, nature : ${devis.packageNature}` : ""}). L'estimateur COLIS EXPRESS indique ${offre.priceFCFA} FCFA. Pouvez-vous me confirmer ce prix et les modalités ?`;
  return `<article class="devis-card">
    <div class="devis-price">${escapeHTML(formatFCFA(offre.priceFCFA))}</div>
    <div class="devis-agency">
      <strong>${escapeHTML(offre.agence.name)}</strong>
      <span>${escapeHTML(offre.agence.city)} · ${escapeHTML(offre.tranche)}</span>
    </div>
    ${offre.agence.phone ? `<a class="button button-whatsapp button-small" target="_blank" rel="noopener noreferrer" href="${escapeHTML(whatsappShareLink(offre.agence.phone, texte))}">◉ Contacter l'agence</a>` : ""}
  </article>`;
}

async function estimer(event) {
  event.preventDefault();
  clearPageMessage(devisMessage);
  const values = Object.fromEntries(new FormData(devisForm));
  setButtonLoading(devisButton, true, "Calcul…");
  try {
    const { devis } = await api("/api/devis", {
      method: "POST",
      body: {
        originCity: values.originCity,
        destinationCity: values.destinationCity,
        weightKg: Number(values.weightKg),
        packageNature: values.packageNature || ""
      }
    });
    if (!devis.offres.length) {
      devisResult.innerHTML = `<div class="notice-box">Aucune agence du réseau ne couvre encore l'axe ${escapeHTML(devis.originCity)} → ${escapeHTML(devis.destinationCity)} dans sa grille tarifaire. <a href="https://wa.me/2250501303343" target="_blank" rel="noopener noreferrer">Contactez notre équipe sur WhatsApp</a> pour un devis personnalisé.</div>`;
      return;
    }
    devisResult.innerHTML = `
      <p class="devis-summary">${devis.offres.length} offre${devis.offres.length > 1 ? "s" : ""} pour ${escapeHTML(devis.originCity)} → ${escapeHTML(devis.destinationCity)} · ${escapeHTML(String(devis.weightKg))} kg. Prix indicatifs en FCFA, confirmés par l'agence à l'enregistrement.</p>
      <div class="devis-cards">${devis.offres.map((offre) => offreHtml(offre, devis)).join("")}</div>`;
  } catch (error) {
    devisResult.innerHTML = "";
    showPageMessage(devisMessage, error.message || "Le calcul du devis a échoué. Réessayez.");
  } finally {
    setButtonLoading(devisButton, false);
  }
}

devisForm?.addEventListener("submit", estimer);

/* Menu mobile de la vitrine */
const menuToggle = document.querySelector(".menu-toggle");
const publicNav = document.getElementById("publicNav");

function setMenu(open) {
  if (!menuToggle || !publicNav) return;
  publicNav.classList.toggle("is-open", open);
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "Fermer le menu" : "Ouvrir le menu");
}

menuToggle?.addEventListener("click", () => {
  setMenu(menuToggle.getAttribute("aria-expanded") !== "true");
});
publicNav?.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => setMenu(false)));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setMenu(false);
});
window.matchMedia("(min-width: 900px)").addEventListener("change", (event) => {
  if (event.matches) setMenu(false);
});
