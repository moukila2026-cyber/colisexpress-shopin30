import { api } from "./api.js";
import { variablesMarque } from "./metier-marque.js";
import {
  STATUTS,
  clearPageMessage,
  errorMessage,
  escapeHTML,
  getQueryParam,
  isTrackingCodeValid,
  normalizeTrackingCode,
  renderHistory,
  showPageMessage,
  statusBadge
} from "./utils.js";

const form = document.getElementById("trackingForm");
const input = document.getElementById("trackingCode");
const message = document.getElementById("trackingMessage");
const result = document.getElementById("trackingResult");
const loading = document.getElementById("trackingLoading");
let suiviTimer = null;

function hideResult() {
  result.hidden = true;
  result.innerHTML = "";
}

function progressHtml(status) {
  const current = STATUTS.indexOf(status);
  return `<ol class="public-progress" aria-label="Étapes du colis">${STATUTS.map((step, index) => {
    const state = index < current || (index === current && status === "Retiré") ? "done" : index === current ? "current" : "todo";
    return `<li class="public-progress-step is-${state}"><span aria-hidden="true">${state === "done" ? "✓" : index + 1}</span><small>${escapeHTML(step)}</small></li>`;
  }).join("")}</ol>`;
}

/**
 * LOT 7 — habillage de l'agence expéditrice (si elle l'a activé) : nom
 * affiché, couleurs et logo. Les couleurs sont revalidées (#rrggbb) avant
 * d'entrer dans l'attribut style ; aucune donnée personnelle.
 */
function marqueHtml(tracking) {
  const marque = tracking.marque;
  if (!marque) return "";
  const logo = marque.logo
    ? `<img class="tracking-brand-logo" src="/api/suivi/${encodeURIComponent(tracking.code)}/logo?v=${encodeURIComponent(marque.version || "")}" alt="Logo ${escapeHTML(marque.nom)}" width="52" height="52">`
    : `<span class="tracking-brand-initiale" aria-hidden="true">${escapeHTML((marque.nom || "A").trim().charAt(0).toUpperCase())}</span>`;
  return `<div class="tracking-brand">${logo}<div><small>Colis confié à</small><strong>${escapeHTML(marque.nom)}</strong></div></div>`;
}

function showResult(tracking) {
  const style = tracking.marque ? ` style="${variablesMarque(tracking.marque)}"` : "";
  result.innerHTML = `
    <article class="tracking-card${tracking.marque ? " tracking-card-marque" : ""}"${style}>
      ${marqueHtml(tracking)}
      <div class="tracking-card-head">
        <div>
          <p class="eyebrow">Suivi en direct</p>
          <h2>${escapeHTML(tracking.code)}</h2>
        </div>
        ${statusBadge(tracking.status)}
      </div>
      ${tracking.notice ? `<div class="tracking-notice" role="status">⚠ ${escapeHTML(tracking.notice)}</div>` : ""}
      ${progressHtml(tracking.status)}
      <div class="route-display" aria-label="Itinéraire">
        <div><span class="route-dot route-start"></span><small>Départ</small><strong>${escapeHTML(tracking.originCity)}</strong></div>
        <span class="route-line" aria-hidden="true"></span>
        <div><span class="route-dot route-end"></span><small>Destination</small><strong>${escapeHTML(tracking.destinationCity)}</strong></div>
      </div>
      <div class="tracking-history">
        <h3>Historique de l'acheminement</h3>
        ${renderHistory(tracking.history, { publicView: true })}
      </div>
      <p class="tracking-help">Une question sur votre colis ? <a href="https://wa.me/2250501303343" target="_blank" rel="noopener noreferrer">Contactez-nous sur WhatsApp</a>.</p>
      <p class="privacy-note">Pour protéger les expéditeurs et destinataires, aucune donnée personnelle n'est affichée ici.</p>
    </article>`;
  result.hidden = false;
}

async function chargerSuivi(code, { silencieux = false } = {}) {
  if (!silencieux) {
    clearPageMessage(message);
    hideResult();
    loading.hidden = false;
  }
  try {
    const { tracking } = await api(`/api/suivi/${encodeURIComponent(code)}`);
    loading.hidden = true;
    clearPageMessage(message);
    showResult(tracking);
    if (suiviTimer) clearInterval(suiviTimer);
    // Rafraîchissement doux pendant que le résultat est affiché.
    suiviTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") chargerSuivi(code, { silencieux: true });
    }, 15000);
  } catch (error) {
    loading.hidden = true;
    if (silencieux && error.status === 404) return;
    if (error.status === 404) {
      showPageMessage(message, "Aucun colis ne correspond à ce code. Vérifiez les caractères saisis.", "info");
    } else {
      showPageMessage(message, errorMessage(error));
    }
  }
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = normalizeTrackingCode(input.value);
  input.value = code;
  if (!isTrackingCodeValid(code)) {
    hideResult();
    showPageMessage(message, "Saisissez un code valide au format CLI-XXXXXX.");
    input.focus();
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("code", code);
  window.history.replaceState({}, "", url);
  chargerSuivi(code);
});

input?.addEventListener("input", () => {
  input.value = normalizeTrackingCode(input.value);
});

const codeFromUrl = normalizeTrackingCode(getQueryParam("code") || "");
if (codeFromUrl) {
  input.value = codeFromUrl;
  if (isTrackingCodeValid(codeFromUrl)) chargerSuivi(codeFromUrl);
  else showPageMessage(message, "Le code dans le lien n'est pas valide.");
}

window.addEventListener("beforeunload", () => {
  if (suiviTimer) clearInterval(suiviTimer);
});
