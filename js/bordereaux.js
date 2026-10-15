/*
 * Bordereaux d'acheminement (LOT 4) — page agence : liste, préparation
 * (1 à 200 colis vers la même destination), émargement (remise au
 * transporteur, mise en route, arrivée) et contrôle d'arrivée en cases à
 * cocher. Un colis absent coche « Écart » et crée automatiquement un
 * incident côté serveur. Toutes les autorisations sont vérifiées par l'API.
 */
import { api } from "./api.js";
import { requireAgency } from "./auth.js";
import { agencySidebar, initAgencyLayout, mobileAgencyHeader } from "./layout.js";
import { STATUTS_COLIS_EMBARQUABLES, validerCreationBordereau } from "./metier-bordereau.js";
import {
  clearPageMessage,
  errorMessage,
  escapeHTML,
  formatDateTime,
  getQueryParam,
  setButtonLoading,
  showPageMessage,
  showToast,
  statusBadge,
  whatsappShareLink
} from "./utils.js";

const message = document.getElementById("pageMessage");
const listTarget = document.getElementById("bordereauxList");
const listCount = document.getElementById("bordereauxCount");
const formSection = document.getElementById("bordereauFormSection");
const formMessage = document.getElementById("bordereauFormMessage");
const bordereauForm = document.getElementById("bordereauForm");
const destinationGroup = document.getElementById("destinationGroup");
const embarquablesList = document.getElementById("embarquablesList");
const embarquesCount = document.getElementById("embarquesCount");
const detailSection = document.getElementById("bordereauDetail");
const detailContent = document.getElementById("bordereauDetailContent");

const LABELS_ETAPES = {
  "Remis": "Remettre au transporteur",
  "En route": "Marquer le lot en route",
  "Arrivé": "Déclarer l'arrivée du lot"
};

let currentAgency = null;
let embarquables = [];

function mountLayout() {
  document.getElementById("sidebarMount").innerHTML = agencySidebar();
  document.getElementById("topbarMount").innerHTML = mobileAgencyHeader(
    "Bordereaux",
    '<a class="button button-small button-orange" href="bordereaux.html">＋ <span>Nouveau</span></a>'
  );
}

function bordereauPublicUrl(code) {
  const base = new URL("bordereau.html", window.location.href);
  base.search = `?code=${encodeURIComponent(code)}`;
  return base.href;
}

/* --------------------------------- liste ---------------------------------- */

async function chargerListe() {
  try {
    const { bordereaux } = await api("/api/bordereaux");
    listCount.textContent = `${bordereaux.length} bordereau${bordereaux.length > 1 ? "x" : ""}`;
    if (!bordereaux.length) {
      listTarget.innerHTML = `<div class="empty-state"><h3>Aucun bordereau</h3><p>Regroupez les colis qui partent ensemble : une perte devient une ligne manquante détectée le jour même.</p></div>`;
      return;
    }
    listTarget.innerHTML = `<div class="table-wrap"><table class="parcel-table">
      <thead><tr><th>Code</th><th>Trajet</th><th>Transporteur</th><th>Colis</th><th>Statut</th><th>Rôle</th><th>Créé le</th><th></th></tr></thead>
      <tbody>${bordereaux.map((bordereau) => `<tr>
        <td><strong class="tracking-code">${escapeHTML(bordereau.code)}</strong></td>
        <td><span class="route-cell">${escapeHTML(bordereau.fromCity)} <span>→</span> ${escapeHTML(bordereau.toCity)}</span><br><small class="muted-note">${escapeHTML(bordereau.toAgencyName || "destination non rattachée")}</small></td>
        <td>${escapeHTML(bordereau.carrierName)}${bordereau.vehicleRef ? `<br><small class="muted-note">${escapeHTML(bordereau.vehicleRef)}</small>` : ""}</td>
        <td>${bordereau.parcelCount}</td>
        <td>${statusBadge(bordereau.status)}</td>
        <td>${bordereau.role === "emetteur" ? "Expéditeur" : "Destinataire"}</td>
        <td>${escapeHTML(formatDateTime(bordereau.createdAtISO))}</td>
        <td><a class="table-link" href="bordereaux.html?id=${encodeURIComponent(bordereau.id)}">Voir</a></td>
      </tr>`).join("")}</tbody>
    </table></div>`;
  } catch (error) {
    showPageMessage(message, errorMessage(error));
  }
}

/* ------------------------------- création --------------------------------- */

function cleGroupe(parcel) {
  return `${parcel.destinationAgencyId ?? "non-rattache"}|${(parcel.destinationCity || "").toLowerCase()}`;
}

function groupesDestination() {
  const groupes = new Map();
  for (const parcel of embarquables) {
    const cle = cleGroupe(parcel);
    if (!groupes.has(cle)) {
      groupes.set(cle, {
        label: `${parcel.destinationCity} — ${parcel.destinationAgencyName || "agence non rattachée"}`,
        parcels: []
      });
    }
    groupes.get(cle).parcels.push(parcel);
  }
  return groupes;
}

function renderEmbarquables() {
  const groupes = groupesDestination();
  const precedent = destinationGroup.value;
  destinationGroup.innerHTML = groupes.size
    ? `<option value="">Choisir la destination du lot</option>${[...groupes.entries()]
        .map(([id, groupe]) => `<option value="${escapeHTML(id)}">${escapeHTML(groupe.label)} (${groupe.parcels.length} colis)</option>`)
        .join("")}`
    : `<option value="">Aucun colis embarquable</option>`;
  if (groupes.has(precedent)) destinationGroup.value = precedent;
  else if (groupes.size === 1) destinationGroup.value = [...groupes.keys()][0];

  const groupe = groupes.get(destinationGroup.value);
  if (!groupe) {
    embarquablesList.innerHTML = embarquables.length
      ? `<p class="muted-note">Choisissez la destination du lot pour afficher les colis.</p>`
      : `<p class="muted-note">Aucun colis embarquable : seuls les colis « Enregistré » ou « Expédié » de votre agence, hors bordereau, peuvent partir en lot.</p>`;
    majCompteEmbarques();
    return;
  }
  embarquablesList.innerHTML = `<ul class="checklist">${groupe.parcels.map((parcel) => `
    <li><label class="checklist-item">
      <input type="checkbox" name="embarque" value="${escapeHTML(parcel.id)}" data-code="${escapeHTML(parcel.trackingCode)}">
      <span><strong class="tracking-code">${escapeHTML(parcel.trackingCode)}</strong> · ${escapeHTML(parcel.packageNature)} · ${escapeHTML(String(parcel.weightKg))} kg · ${statusBadge(parcel.status)}</span>
    </label></li>`).join("")}</ul>`;
  embarquablesList.querySelectorAll("input[name=embarque]").forEach((input) => {
    input.addEventListener("change", majCompteEmbarques);
  });
  majCompteEmbarques();
}

function majCompteEmbarques() {
  const n = embarquablesList.querySelectorAll("input[name=embarque]:checked").length;
  embarquesCount.textContent = `${n} colis sélectionné${n > 1 ? "s" : ""}`;
}

async function ouvrirFormulaire() {
  formSection.hidden = false;
  detailSection.hidden = true;
  clearPageMessage(formMessage);
  try {
    const { parcels } = await api("/api/colis");
    embarquables = parcels.filter((parcel) =>
      parcel.ownerId === currentAgency.id &&
      STATUTS_COLIS_EMBARQUABLES.includes(parcel.status) &&
      !parcel.bordereauId
    );
    renderEmbarquables();
    formSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showPageMessage(formMessage, errorMessage(error));
  }
}

async function creerBordereau(event) {
  event.preventDefault();
  clearPageMessage(formMessage);
  const values = Object.fromEntries(new FormData(bordereauForm));
  const parcelIds = [...embarquablesList.querySelectorAll("input[name=embarque]:checked")].map((input) => input.value);
  const controle = validerCreationBordereau({ ...values, parcelIds });
  if (controle.error) {
    showPageMessage(formMessage, controle.error);
    return;
  }
  const button = document.getElementById("saveBordereauButton");
  setButtonLoading(button, true, "Création…");
  try {
    const { bordereau } = await api("/api/bordereaux", { method: "POST", body: controle.valeur });
    showToast(`Bordereau ${bordereau.code} créé avec ${bordereau.parcelCount} colis.`);
    bordereauForm.reset();
    formSection.hidden = true;
    window.location.href = `bordereaux.html?id=${encodeURIComponent(bordereau.id)}`;
  } catch (error) {
    showPageMessage(formMessage, errorMessage(error));
  } finally {
    setButtonLoading(button, false);
  }
}

/* -------------------------------- détail ---------------------------------- */

function datesHtml(bordereau) {
  const lignes = [
    ["Préparé le", bordereau.createdAtISO, null],
    ["Remis au transporteur", bordereau.handedOverAt, bordereau.handedOverBy],
    ["Mis en route", bordereau.departedAt, null],
    ["Arrivé", bordereau.arrivedAt, bordereau.arrivedBy],
    ["Contrôlé", bordereau.checkedAt, bordereau.checkedBy]
  ].filter(([, date]) => Boolean(date));
  return `<dl class="person-data">${lignes.map(([label, date, par]) => `
    <div><dt>${label}</dt><dd>${escapeHTML(formatDateTime(date))}${par ? ` · par ${escapeHTML(par)}` : ""}</dd></div>`).join("")}</dl>`;
}

function renderDetail(data) {
  const { bordereau, parcels, actions } = data;
  const lienPublic = bordereauPublicUrl(bordereau.code);
  const textePartage = `Bordereau COLIS EXPRESS ${bordereau.code} (${bordereau.fromCity} → ${bordereau.toCity}, ${bordereau.parcelCount} colis). Suivi du lot : ${lienPublic}`;
  const absents = parcels.filter((parcel) => parcel.absent);

  detailContent.innerHTML = `
    <div class="detail-heading">
      <div>
        <p class="eyebrow">Bordereau d'acheminement</p>
        <h1 class="detail-code">${escapeHTML(bordereau.code)}</h1>
      </div>
      <div class="detail-status">${statusBadge(bordereau.status)}<span class="attach-flag">${bordereau.role === "emetteur" ? "Votre lot expédié" : "Lot reçu"}</span></div>
    </div>

    <section class="info-card">
      <h2>Trajet et transporteur</h2>
      <div class="route-display route-display-detail">
        <div><span class="route-dot route-start"></span><small>Départ</small><strong>${escapeHTML(bordereau.fromCity)}</strong><p>${escapeHTML(bordereau.fromAgencyName)}</p></div>
        <span class="route-line" aria-hidden="true"></span>
        <div><span class="route-dot route-end"></span><small>Arrivée</small><strong>${escapeHTML(bordereau.toCity)}</strong><p>${escapeHTML(bordereau.toAgencyName || "Agence non rattachée")}</p></div>
      </div>
      <dl class="person-data">
        <div><dt>Transporteur</dt><dd>${escapeHTML(bordereau.carrierName)}</dd></div>
        <div><dt>Téléphone</dt><dd>${escapeHTML(bordereau.carrierPhone || "—")}</dd></div>
        <div><dt>Véhicule / ligne</dt><dd>${escapeHTML(bordereau.vehicleRef || "—")}</dd></div>
        <div><dt>Colis du lot</dt><dd>${bordereau.parcelCount}</dd></div>
      </dl>
      ${datesHtml(bordereau)}
      <div class="payment-actions">
        <a class="button button-outline button-small" target="_blank" rel="noopener noreferrer" href="${escapeHTML(lienPublic)}">Lien public du bordereau</a>
        ${bordereau.carrierPhone ? `<a class="button button-whatsapp button-small" target="_blank" rel="noopener noreferrer" href="${escapeHTML(whatsappShareLink(bordereau.carrierPhone, textePartage))}">◉ Envoyer au transporteur</a>` : ""}
      </div>
    </section>

    ${actions.prochaineEtape ? `<section class="action-card">
      <div><p class="eyebrow">Émargement</p><h2>${escapeHTML(LABELS_ETAPES[actions.prochaineEtape] || actions.prochaineEtape)}</h2>
      <p>${actions.prochaineEtape === "Remis" ? "La remise au transporteur est horodatée et tracée dans l'historique de chaque colis du lot." : "Chaque émargement est horodaté : c'est la preuve du passage du lot."}</p></div>
      <div class="action-stack"><button class="button button-primary" id="etapeBordereau" type="button" data-etape="${escapeHTML(actions.prochaineEtape)}">${escapeHTML(LABELS_ETAPES[actions.prochaineEtape] || actions.prochaineEtape)}</button></div>
    </section>` : ""}

    ${actions.peutControler ? `<section class="action-card" id="controleCard">
      <div><p class="eyebrow">Contrôle d'arrivée</p><h2>Vérifier chaque colis du lot</h2>
      <p>Décochez les colis absents : le bordereau passe en « Écart » et un incident « perdu » est ouvert automatiquement sur chaque colis manquant.</p></div>
      <ul class="checklist" id="controleList">${parcels.map((parcel) => `
        <li><label class="checklist-item">
          <input type="checkbox" name="present" value="${escapeHTML(parcel.id)}" checked>
          <span><strong class="tracking-code">${escapeHTML(parcel.trackingCode)}</strong> · ${escapeHTML(parcel.packageNature)} · ${escapeHTML(String(parcel.weightKg))} kg</span>
        </label></li>`).join("")}</ul>
      <div class="action-stack"><button class="button button-primary" id="validerControle" type="button">Valider le contrôle d'arrivée</button></div>
      <div class="page-message" id="controleMessage" hidden role="alert"></div>
    </section>` : ""}

    ${bordereau.status === "Écart" ? `<div class="notice-box notice-danger">Écart constaté au contrôle : ${absents.length} colis absent${absents.length > 1 ? "s" : ""} (${absents.map((parcel) => escapeHTML(parcel.trackingCode)).join(", ")}). Un incident « perdu » a été ouvert automatiquement sur chacun — visible par les deux agences.</div>` : ""}

    <section class="panel-card">
      <div class="panel-title-row"><h2>Colis du lot (${parcels.length})</h2></div>
      <div class="table-wrap"><table class="parcel-table">
        <thead><tr><th>Code</th><th>Nature</th><th>Poids</th><th>Statut du colis</th><th>Contrôle</th><th></th></tr></thead>
        <tbody>${parcels.map((parcel) => `<tr${parcel.absent ? ' class="row-absent"' : ""}>
          <td><strong class="tracking-code">${escapeHTML(parcel.trackingCode)}</strong></td>
          <td>${escapeHTML(parcel.packageNature)}</td>
          <td>${escapeHTML(String(parcel.weightKg))} kg</td>
          <td>${statusBadge(parcel.status)}</td>
          <td>${bordereau.checkedAt ? (parcel.absent ? '<span class="ecart-flag">Absent</span>' : '<span class="present-flag">Présent</span>') : "—"}</td>
          <td><a class="table-link" href="colis.html?id=${encodeURIComponent(parcel.id)}">Voir</a></td>
        </tr>`).join("")}</tbody>
      </table></div>
    </section>`;

  document.getElementById("etapeBordereau")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setButtonLoading(button, true, "Émargement…");
    try {
      await api(`/api/bordereaux/${encodeURIComponent(bordereau.id)}/remettre`, {
        method: "POST",
        body: { etape: button.dataset.etape }
      });
      showToast("Bordereau mis à jour.");
      await afficherDetail(bordereau.id);
    } catch (error) {
      showPageMessage(message, errorMessage(error));
      setButtonLoading(button, false);
    }
  });

  document.getElementById("validerControle")?.addEventListener("click", async () => {
    const cible = document.getElementById("controleMessage");
    clearPageMessage(cible);
    const absents = [...detailContent.querySelectorAll("input[name=present]:not(:checked)")].map((input) => input.value);
    const button = document.getElementById("validerControle");
    setButtonLoading(button, true, "Contrôle…");
    try {
      const res = await api(`/api/bordereaux/${encodeURIComponent(bordereau.id)}/controle`, {
        method: "POST",
        body: { absentParcelIds: absents }
      });
      showToast(res.bordereau.status === "Écart"
        ? `Écart : ${res.incidentsCrees} incident(s) ouvert(s) automatiquement.`
        : `Lot contrôlé : ${res.colisAvances} colis confirmé(s) arrivé(s).`);
      await afficherDetail(bordereau.id);
    } catch (error) {
      showPageMessage(cible, errorMessage(error));
      setButtonLoading(button, false);
    }
  });
}

async function afficherDetail(id) {
  try {
    const data = await api(`/api/bordereaux/${encodeURIComponent(id)}`);
    clearPageMessage(message);
    formSection.hidden = true;
    detailSection.hidden = false;
    renderDetail(data);
  } catch (error) {
    detailSection.hidden = true;
    showPageMessage(message, error.status === 404 ? "Bordereau introuvable ou accès non autorisé." : errorMessage(error));
    await chargerListe();
  }
}

/* --------------------------------- boot ------------------------------------ */

async function boot() {
  mountLayout();
  const user = await requireAgency();
  if (!user) return;
  currentAgency = await initAgencyLayout(user, "bordereaux");
  if (!currentAgency) return;

  document.getElementById("newBordereauButton")?.addEventListener("click", ouvrirFormulaire);
  document.getElementById("cancelBordereau")?.addEventListener("click", () => {
    formSection.hidden = true;
    clearPageMessage(formMessage);
  });
  document.getElementById("closeBordereauDetail")?.addEventListener("click", () => {
    window.location.href = "bordereaux.html";
  });
  destinationGroup.addEventListener("change", renderEmbarquables);
  bordereauForm.addEventListener("submit", creerBordereau);

  const id = getQueryParam("id");
  if (id) {
    await afficherDetail(id);
  } else {
    await chargerListe();
  }
}

boot();
