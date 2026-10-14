import { normalizeTrackingCode, isTrackingCodeValid, showPageMessage, clearPageMessage } from "./utils.js";

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
