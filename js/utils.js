export const STATUTS = [
  "Enregistré",
  "Expédié",
  "En transit",
  "Arrivé à l'agence de destination",
  "Retiré"
];

export const ACTIONS_STATUT = {
  "Expédié": "Expédier le colis",
  "En transit": "Mettre en transit",
  "Arrivé à l'agence de destination": "Confirmer l'arrivée",
  "Retiré": "Enregistrer le retrait"
};

export function escapeHTML(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function formatFCFA(value) {
  const number = Number(value || 0);
  return `${new Intl.NumberFormat("fr-CI", {
    maximumFractionDigits: 0
  }).format(number)} FCFA`;
}

export function asDate(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value) {
  const date = asDate(value);
  if (!date) return "Date indisponible";
  return new Intl.DateTimeFormat("fr-CI", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function formatShortDate(value) {
  const date = asDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("fr-CI", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
}

export function statusClass(status = "") {
  return `status-${status
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll("'", "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

export function statusBadge(status) {
  return `<span class="status-badge ${statusClass(status)}">${escapeHTML(status)}</span>`;
}

export function normalizeTrackingCode(value = "") {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

export function isTrackingCodeValid(value) {
  return /^CLI-[A-Z0-9]{6}$/.test(normalizeTrackingCode(value));
}

export function normalizeIvorianPhone(value = "") {
  let digits = String(value).replace(/\D/g, "");
  if (digits.startsWith("225") && digits.length === 13) digits = digits.slice(3);
  return digits;
}

export function isValidIvorianPhone(value) {
  return /^0[1-9]\d{8}$/.test(normalizeIvorianPhone(value));
}

export function toWhatsAppNumber(value) {
  return `225${normalizeIvorianPhone(value)}`;
}

export function isValidCni(value = "") {
  const clean = value.trim();
  return /^[A-Za-z0-9À-ÿ -]{8,25}$/.test(clean) && /\d/.test(clean);
}

export function generateTrackingCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
  return `CLI-${token}`;
}

export function localDateKey(value = new Date()) {
  const date = asDate(value) || new Date();
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Africa/Abidjan",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const getPart = (type) => parts.find((part) => part.type === type)?.value;
  return `${getPart("year")}-${getPart("month")}-${getPart("day")}`;
}

export function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

export function showToast(message, type = "success") {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.className = "toast-container";
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  window.setTimeout(() => toast.classList.add("toast-visible"), 10);
  window.setTimeout(() => {
    toast.classList.remove("toast-visible");
    window.setTimeout(() => toast.remove(), 250);
  }, 4500);
}

export function showPageMessage(target, message, type = "error") {
  const element = typeof target === "string" ? document.querySelector(target) : target;
  if (!element) return;
  element.className = `page-message page-message-${type}`;
  element.textContent = message;
  element.hidden = false;
}

export function clearPageMessage(target) {
  const element = typeof target === "string" ? document.querySelector(target) : target;
  if (!element) return;
  element.hidden = true;
  element.textContent = "";
}

export function setButtonLoading(button, loading, loadingLabel = "Chargement…") {
  if (!button) return;
  if (loading) {
    button.dataset.originalLabel = button.innerHTML;
    button.disabled = true;
    button.classList.add("is-loading");
    button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span>${escapeHTML(loadingLabel)}`;
  } else {
    button.disabled = false;
    button.classList.remove("is-loading");
    if (button.dataset.originalLabel) button.innerHTML = button.dataset.originalLabel;
  }
}

export function errorMessage(error) {
  // L'API renvoie déjà un message français prêt à afficher dans `error`.
  if (error?.message && typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  return "Une erreur inattendue est survenue. Réessayez, et si le problème persiste, contactez l'équipe COLIS EXPRESS.";
}

export function publicTrackingUrl(code) {
  const base = new URL("suivi.html", window.location.href);
  base.search = `?code=${encodeURIComponent(code)}`;
  base.hash = "";
  return base.href;
}

export function whatsappShareLink(phone, text) {
  return `https://wa.me/${encodeURIComponent(toWhatsAppNumber(phone))}?text=${encodeURIComponent(text)}`;
}

export function renderHistory(history = [], { publicView = false } = {}) {
  if (!Array.isArray(history) || history.length === 0) {
    return `<div class="empty-inline">Aucun événement disponible pour le moment.</div>`;
  }
  return `<ol class="timeline ${publicView ? "timeline-public" : ""}">${history
    .slice()
    .reverse()
    .map(
      (item) => `<li class="timeline-item">
        <span class="timeline-dot" aria-hidden="true"></span>
        <div class="timeline-content">
          <div class="timeline-head">${statusBadge(item.status || "Mise à jour")}</div>
          <strong>${escapeHTML(item.city || "Ville non renseignée")}</strong>
          <p>${escapeHTML(item.agencyName || "Agence COLIS EXPRESS")} · ${escapeHTML(formatDateTime(item.date))}</p>
          ${item.note ? `<p class="timeline-note">${escapeHTML(item.note)}</p>` : ""}
        </div>
      </li>`
    )
    .join("")}</ol>`;
}

export function redirectToLogin() {
  const current = `${window.location.pathname.split("/").pop() || "dashboard.html"}${window.location.search}`;
  window.location.href = `connexion.html?retour=${encodeURIComponent(current)}`;
}
