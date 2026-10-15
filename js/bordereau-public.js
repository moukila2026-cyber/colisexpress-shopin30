/*
 * Suivi PUBLIC d'un bordereau (LOT 4) — bordereau.html?code=BDR-…
 * Aucune donnée personnelle : codes de suivi des colis, statuts, trajet,
 * transporteur (nom et véhicule seulement — jamais son téléphone), et
 * résultat du contrôle d'arrivée (présent/absent par colis).
 */
import { api } from "./api.js";
import {
  clearPageMessage,
  errorMessage,
  escapeHTML,
  formatDateTime,
  getQueryParam,
  showPageMessage,
  statusBadge
} from "./utils.js";

const form = document.getElementById("bordereauForm");
const input = document.getElementById("bordereauCode");
const message = document.getElementById("bordereauMessage");
const result = document.getElementById("bordereauResult");
const loading = document.getElementById("bordereauLoading");
let suiviTimer = null;

export function normalizeBordereauCode(value = "") {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

export function isBordereauCodeValid(value) {
  return /^BDR-[A-Z0-9]{6}$/.test(normalizeBordereauCode(value));
}

function hideResult() {
  result.hidden = true;
  result.innerHTML = "";
}

function showResult(bordereau) {
  result.innerHTML = `
    <article class="tracking-card">
      <div class="tracking-card-head">
        <div>
          <p class="eyebrow">Bordereau d'acheminement</p>
          <h2>${escapeHTML(bordereau.code)}</h2>
        </div>
        ${statusBadge(bordereau.status)}
      </div>
      <div class="route-display" aria-label="Trajet du lot">
        <div><span class="route-dot route-start"></span><small>Départ</small><strong>${escapeHTML(bordereau.originCity)}</strong></div>
        <span class="route-line" aria-hidden="true"></span>
        <div><span class="route-dot route-end"></span><small>Arrivée</small><strong>${escapeHTML(bordereau.destinationCity)}</strong></div>
      </div>
      <dl class="person-data bordereau-public-meta">
        <div><dt>Transporteur</dt><dd>${escapeHTML(bordereau.carrierName)}</dd></div>
        ${bordereau.vehicleRef ? `<div><dt>Véhicule / ligne</dt><dd>${escapeHTML(bordereau.vehicleRef)}</dd></div>` : ""}
        <div><dt>Colis dans le lot</dt><dd>${bordereau.parcelCount}</dd></div>
        ${bordereau.checkedAtISO ? `<div><dt>Contrôlé le</dt><dd>${escapeHTML(formatDateTime(bordereau.checkedAtISO))}</dd></div>` : ""}
        <div><dt>Dernière mise à jour</dt><dd>${escapeHTML(formatDateTime(bordereau.lastUpdatedAtISO))}</dd></div>
      </dl>
      <div class="tracking-history">
        <h3>Colis du lot</h3>
        <ul class="bordereau-parcels-public">${bordereau.parcels.map((parcel) => `
          <li>
            <strong class="tracking-code">${escapeHTML(parcel.trackingCode)}</strong>
            ${statusBadge(parcel.status)}
            ${parcel.present === true ? '<span class="present-flag">Présent au contrôle</span>' : ""}
            ${parcel.present === false ? '<span class="ecart-flag">Absent au contrôle</span>' : ""}
            <a class="table-link" href="suivi.html?code=${encodeURIComponent(parcel.trackingCode)}">Suivre</a>
          </li>`).join("")}</ul>
      </div>
      <p class="tracking-help">Chaque colis reste suivi individuellement avec son code <strong>CLI-XXXXXX</strong> sur <a href="suivi.html">la page de suivi</a>.</p>
      <p class="privacy-note">Suivi public du lot : aucun nom, aucun téléphone, aucune pièce d'identité n'est affiché ici.</p>
    </article>`;
  result.hidden = false;
}

async function chargerBordereau(code, { silencieux = false } = {}) {
  if (!silencieux) {
    clearPageMessage(message);
    hideResult();
    loading.hidden = false;
  }
  try {
    const { bordereau } = await api(`/api/suivi-bordereau/${encodeURIComponent(code)}`);
    loading.hidden = true;
    clearPageMessage(message);
    showResult(bordereau);
    if (suiviTimer) clearInterval(suiviTimer);
    suiviTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") chargerBordereau(code, { silencieux: true });
    }, 20000);
  } catch (error) {
    loading.hidden = true;
    if (silencieux && error.status === 404) return;
    if (error.status === 404) {
      showPageMessage(message, "Aucun bordereau ne correspond à ce code. Vérifiez les caractères saisis.", "info");
    } else {
      showPageMessage(message, errorMessage(error));
    }
  }
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = normalizeBordereauCode(input.value);
  input.value = code;
  if (!isBordereauCodeValid(code)) {
    hideResult();
    showPageMessage(message, "Saisissez un code valide au format BDR-XXXXXX.");
    input.focus();
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("code", code);
  window.history.replaceState({}, "", url);
  chargerBordereau(code);
});

input?.addEventListener("input", () => {
  input.value = normalizeBordereauCode(input.value);
});

const codeFromUrl = normalizeBordereauCode(getQueryParam("code") || "");
if (codeFromUrl) {
  input.value = codeFromUrl;
  if (isBordereauCodeValid(codeFromUrl)) chargerBordereau(codeFromUrl);
  else showPageMessage(message, "Le code dans le lien n'est pas valide.");
}

window.addEventListener("beforeunload", () => {
  if (suiviTimer) clearInterval(suiviTimer);
});
