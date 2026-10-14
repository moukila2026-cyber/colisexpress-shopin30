import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db, firebaseIsConfigured } from "./firebase.js";
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
let unsubscribe = null;

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

function showResult(tracking) {
  result.innerHTML = `
    <article class="tracking-card">
      <div class="tracking-card-head">
        <div>
          <p class="eyebrow">Suivi en direct</p>
          <h2>${escapeHTML(tracking.code)}</h2>
        </div>
        ${statusBadge(tracking.status)}
      </div>
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

function launchTracking(code) {
  clearPageMessage(message);
  hideResult();
  if (unsubscribe) unsubscribe();
  if (!firebaseIsConfigured || !db) {
    showPageMessage(message, "Le suivi est indisponible tant que Firebase n'est pas configuré.");
    return;
  }
  loading.hidden = false;
  unsubscribe = onSnapshot(
    doc(db, "suivis", code),
    (snapshot) => {
      loading.hidden = true;
      if (!snapshot.exists()) {
        showPageMessage(message, "Aucun colis ne correspond à ce code. Vérifiez les caractères saisis.", "info");
        return;
      }
      showResult(snapshot.data());
    },
    (error) => {
      loading.hidden = true;
      showPageMessage(message, errorMessage(error));
    }
  );
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
  launchTracking(code);
});

input?.addEventListener("input", () => {
  input.value = normalizeTrackingCode(input.value);
});

const codeFromUrl = normalizeTrackingCode(getQueryParam("code") || "");
if (codeFromUrl) {
  input.value = codeFromUrl;
  if (isTrackingCodeValid(codeFromUrl)) launchTracking(codeFromUrl);
  else showPageMessage(message, "Le code dans le lien n'est pas valide.");
}

window.addEventListener("beforeunload", () => unsubscribe?.());
