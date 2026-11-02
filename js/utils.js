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

const MOTIFS_TECHNIQUES_NAVIGATEUR = /is not a function|is not iterable|Cannot read prop|undefined is not an object|null is not an object|Unexpected token|SyntaxError|ReferenceError|TypeError|RangeError/i;
const MOTIFS_RESEAU_NAVIGATEUR = /Failed to fetch|NetworkError|Load failed|fetch failed|Network request failed/i;

export function errorMessage(error) {
  const texte = typeof error?.message === "string" ? error.message.trim() : "";
  if (texte && MOTIFS_RESEAU_NAVIGATEUR.test(texte)) {
    return "Connexion momentanément interrompue. Vérifiez votre accès internet et réessayez.";
  }
  if (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof RangeError ||
    (texte && MOTIFS_TECHNIQUES_NAVIGATEUR.test(texte))
  ) {
    return "L'opération n'a pas pu aboutir automatiquement. Actualisez la page et réessayez.";
  }
  // L'API renvoie déjà un message français prêt à afficher dans `error`.
  if (texte) {
    return texte;
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
  const encodedText = encodeURIComponent(text || "");
  if (isValidIvorianPhone(phone)) {
    return `https://wa.me/${encodeURIComponent(toWhatsAppNumber(phone))}?text=${encodedText}`;
  }
  return `https://wa.me/?text=${encodedText}`;
}

export function publicRegisterUrl() {
  if (typeof window !== "undefined" && window.location?.href) {
    const base = new URL("inscription.html", window.location.href);
    base.search = "";
    base.hash = "";
    return base.href;
  }
  return "https://colisexpress-shopin30.vercel.app/inscription.html";
}

/**
 * Construit le message pré-rempli WhatsApp lorsqu'une agence invite une autre
 * agence partenaire à rejoindre COLIS EXPRESS (à la création d'un colis, sur
 * une fiche colis ou depuis le tableau de bord / les paramètres).
 */
export function agencyInviteMessage({
  targetAgencyName = "",
  targetCity = "",
  senderAgencyName = "",
  senderCity = "",
  trackingCode = "",
  originCity = "",
  destinationCity = "",
  registerUrl = ""
} = {}) {
  const cible = String(targetAgencyName || "").trim();
  const villeCible = String(targetCity || "").trim();
  const expediteur = String(senderAgencyName || "").trim();
  const villeExpediteur = String(senderCity || "").trim();
  const code = String(trackingCode || "").trim();
  const depart = String(originCity || "").trim();
  const arrivee = String(destinationCity || "").trim() || villeCible;
  const url = String(registerUrl || "").trim() || publicRegisterUrl();

  const salutation = `Bonjour${cible ? ` ${cible}` : ""},`;
  const presentation = expediteur
    ? `ici l'agence ${expediteur}${villeExpediteur ? ` (${villeExpediteur})` : ""}.`
    : "nous utilisons COLIS EXPRESS pour le suivi de nos colis inter-agences.";

  if (code) {
    const trajet = depart && arrivee ? ` (${depart} → ${arrivee})` : arrivee ? ` vers ${arrivee}` : "";
    return `${salutation} ${presentation} Un colis ${code}${trajet} vous est destiné sur COLIS EXPRESS. Créez gratuitement votre compte agence en 2 minutes (50 colis/mois offerts) pour confirmer la réception, suivre vos bordereaux et alerter vos clients : ${url}`;
  }

  const axe = villeCible ? ` vers ${villeCible}` : "";
  return `${salutation} ${presentation} Nous utilisons COLIS EXPRESS pour envoyer et suivre nos colis inter-agences${axe} (code de suivi, reçu QR, bordereaux, caisse). Créez gratuitement le compte de votre agence en 2 minutes (50 colis/mois offerts) pour recevoir et expédier nos colis ensemble : ${url}`;
}

export function agencyInviteWhatsappLink({ phone = "", text = "", ...options } = {}) {
  const message = String(text || "").trim() || agencyInviteMessage(options);
  return whatsappShareLink(phone, message);
}

const EYE_OPEN_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const EYE_OFF_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

/**
 * Initialise les boutons « œil » d'affichage/masquage des champs mot de passe.
 * Chaque bouton porte `data-password-toggle="<idDuChamp>"`.
 */
export function initPasswordToggles(root = document) {
  if (!root?.querySelectorAll) return;
  const buttons = root.querySelectorAll("[data-password-toggle]");
  buttons.forEach((button) => {
    if (button.dataset.passwordToggleBound === "true") return;
    button.dataset.passwordToggleBound = "true";
    const targetId = button.getAttribute("data-password-toggle");
    const input = targetId ? document.getElementById(targetId) : button.closest(".password-input-wrap")?.querySelector("input");
    if (!input) return;

    const syncState = (visible) => {
      input.type = visible ? "text" : "password";
      button.setAttribute("aria-pressed", visible ? "true" : "false");
      const label = visible ? "Masquer le mot de passe" : "Afficher le mot de passe";
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      button.innerHTML = visible ? EYE_OFF_SVG : EYE_OPEN_SVG;
    };

    syncState(input.type === "text");
    button.addEventListener("click", () => {
      syncState(input.type === "password");
      input.focus({ preventScroll: true });
    });
  });
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
          ${item.actorName && item.actorName !== item.agencyName ? `<p class="timeline-actor">Par ${escapeHTML(item.actorName)}</p>` : ""}
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
