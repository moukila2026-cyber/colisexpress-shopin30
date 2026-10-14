import {
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase.js";
import { requireAgency } from "./auth.js";
import { agencySidebar, initAgencyLayout, mobileAgencyHeader } from "./layout.js";
import {
  ACTIONS_STATUT,
  STATUTS,
  clearPageMessage,
  errorMessage,
  escapeHTML,
  formatDateTime,
  formatFCFA,
  getQueryParam,
  isValidCni,
  renderHistory,
  setButtonLoading,
  showPageMessage,
  showToast,
  statusBadge,
  publicTrackingUrl,
  toWhatsAppNumber,
  whatsappShareLink
} from "./utils.js";

const message = document.getElementById("pageMessage");
const target = document.getElementById("parcelDetail");
const collectionModal = document.getElementById("collectionModal");
const collectionForm = document.getElementById("collectionForm");
let currentAgency = null;
let parcelId = null;
let currentParcel = null;
let updateInProgress = false;

function mountLayout() {
  document.getElementById("sidebarMount").innerHTML = agencySidebar();
  document.getElementById("topbarMount").innerHTML = mobileAgencyHeader(
    "Détail du colis",
    '<a class="icon-button" href="dashboard.html" aria-label="Retour au tableau de bord">←</a>'
  );
}

function canMoveToNext(parcel) {
  const index = STATUTS.indexOf(parcel.status);
  const nextStatus = STATUTS[index + 1];
  if (!nextStatus || !currentAgency) return null;
  const isOwner = parcel.ownerId === currentAgency.id;
  const isDestination = parcel.destinationAgencyId === currentAgency.id;
  const ownerStep = ["Expédié", "En transit"].includes(nextStatus);
  const destinationStep = ["Arrivé à l'agence de destination", "Retiré"].includes(nextStatus);
  if ((ownerStep && isOwner) || (destinationStep && isDestination)) return nextStatus;
  return null;
}

function whatsappLink(parcel) {
  if (parcel.status !== "Arrivé à l'agence de destination" || !parcel.recipient?.phone) return "";
  const messageText = `Bonjour ${parcel.recipient.firstName || ""}, votre colis ${parcel.trackingCode} est arrivé à l'agence ${parcel.destinationAgencyName || "COLIS EXPRESS"}. Présentez votre CNI pour le retrait.`;
  return `<a class="button button-whatsapp" target="_blank" rel="noopener noreferrer" href="https://wa.me/${encodeURIComponent(toWhatsAppNumber(parcel.recipient.phone))}?text=${encodeURIComponent(messageText)}">◉ Prévenir le destinataire sur WhatsApp</a>`;
}

function shareLinks(parcel) {
  const link = publicTrackingUrl(parcel.trackingCode);
  const links = [];
  if (parcel.recipient?.phone) {
    const text = `Bonjour ${parcel.recipient.firstName || ""}, voici le suivi de votre colis COLIS EXPRESS (code ${parcel.trackingCode}) : ${link}`;
    links.push(`<a class="button button-outline" target="_blank" rel="noopener noreferrer" href="${escapeHTML(whatsappShareLink(parcel.recipient.phone, text))}">Partager le suivi au destinataire</a>`);
  }
  if (parcel.sender?.phone) {
    const text = `Bonjour ${parcel.sender.firstName || ""}, votre colis ${parcel.trackingCode} est enregistré. Suivez-le ici : ${link}`;
    links.push(`<a class="button button-outline" target="_blank" rel="noopener noreferrer" href="${escapeHTML(whatsappShareLink(parcel.sender.phone, text))}">Partager le suivi à l'expéditeur</a>`);
  }
  return links.join("");
}

function renderDetail(parcel) {
  const nextStatus = canMoveToNext(parcel);
  const canNotify = whatsappLink(parcel);
  const statusIndex = STATUTS.indexOf(parcel.status);
  target.innerHTML = `
    <div class="detail-heading">
      <div>
        <a class="back-link" href="dashboard.html">← Retour aux colis</a>
        <p class="eyebrow">Code de suivi</p>
        <h1 class="detail-code">${escapeHTML(parcel.trackingCode)}</h1>
      </div>
      <div class="detail-status">${statusBadge(parcel.status)}</div>
    </div>

    <section class="progress-card" aria-label="Progression du colis">
      <div class="progress-steps">
        ${STATUTS.map((status, index) => `<div class="progress-step ${index <= statusIndex ? "step-done" : ""} ${index === statusIndex ? "step-current" : ""}">
          <span>${index < statusIndex ? "✓" : index + 1}</span><small>${escapeHTML(status)}</small>
        </div>`).join("")}
      </div>
    </section>

    <div class="detail-grid">
      <section class="info-card info-card-route">
        <h2>Itinéraire</h2>
        <div class="route-display route-display-detail">
          <div><span class="route-dot route-start"></span><small>Départ</small><strong>${escapeHTML(parcel.originCity)}</strong><p>${escapeHTML(parcel.ownerAgencyName || "")}</p></div>
          <span class="route-line" aria-hidden="true"></span>
          <div><span class="route-dot route-end"></span><small>Destination</small><strong>${escapeHTML(parcel.destinationCity)}</strong><p>${escapeHTML(parcel.destinationAgencyName || "")}</p></div>
        </div>
        <dl class="parcel-meta">
          <div><dt>Nature</dt><dd>${escapeHTML(parcel.packageNature)}</dd></div>
          <div><dt>Poids</dt><dd>${escapeHTML(String(parcel.weightKg))} kg</dd></div>
          <div><dt>Prix</dt><dd>${escapeHTML(formatFCFA(parcel.priceFCFA))}</dd></div>
          <div><dt>Enregistré le</dt><dd>${escapeHTML(formatDateTime(parcel.createdAtISO))}</dd></div>
        </dl>
      </section>

      <section class="info-card">
        <h2>Expéditeur</h2>
        <dl class="person-data">
          <div><dt>Nom complet</dt><dd>${escapeHTML(`${parcel.sender?.firstName || ""} ${parcel.sender?.lastName || ""}`.trim())}</dd></div>
          <div><dt>Téléphone</dt><dd>${escapeHTML(parcel.sender?.phone || "—")}</dd></div>
          <div><dt>N° CNI</dt><dd>${escapeHTML(parcel.sender?.cni || "—")}</dd></div>
        </dl>
      </section>

      <section class="info-card">
        <h2>Destinataire</h2>
        <dl class="person-data">
          <div><dt>Nom complet</dt><dd>${escapeHTML(`${parcel.recipient?.firstName || ""} ${parcel.recipient?.lastName || ""}`.trim())}</dd></div>
          <div><dt>Téléphone</dt><dd>${escapeHTML(parcel.recipient?.phone || "—")}</dd></div>
          <div><dt>Agence de retrait</dt><dd>${escapeHTML(parcel.destinationAgencyName || "—")}</dd></div>
        </dl>
      </section>

      ${parcel.collectedBy ? `<section class="info-card collected-card"><h2>Retrait enregistré</h2><dl class="person-data"><div><dt>Retiré par</dt><dd>${escapeHTML(parcel.collectedBy.name)}</dd></div><div><dt>N° CNI présenté</dt><dd>${escapeHTML(parcel.collectedBy.cni)}</dd></div><div><dt>Date</dt><dd>${escapeHTML(formatDateTime(parcel.collectedBy.date))}</dd></div></dl></section>` : ""}
    </div>

    <section class="action-card">
      <div><p class="eyebrow">Action sur le colis</p><h2>${nextStatus ? escapeHTML(ACTIONS_STATUT[nextStatus]) : "Aucune action disponible"}</h2>
      <p>${nextStatus ? "Chaque mise à jour est visible immédiatement dans le suivi public." : (parcel.status === "Retiré" ? "Ce colis a déjà été retiré." : "Cette étape doit être effectuée par l'agence concernée.")}</p></div>
      <div class="action-stack">
        ${nextStatus ? `<button class="button button-primary" id="statusAction" type="button">${escapeHTML(ACTIONS_STATUT[nextStatus])}</button>` : ""}
        ${canNotify}
        ${shareLinks(parcel)}
      </div>
    </section>

    <section class="history-card">
      <h2>Historique</h2>
      ${renderHistory(parcel.history)}
    </section>`;

  document.getElementById("statusAction")?.addEventListener("click", () => {
    if (!nextStatus) return;
    if (nextStatus === "Retiré") {
      collectionModal.hidden = false;
      document.body.classList.add("modal-open");
      document.getElementById("collectorName").focus();
    } else {
      updateStatus(nextStatus);
    }
  });
}

async function updateStatus(nextStatus, collectedBy = null) {
  if (updateInProgress || !currentParcel || !currentAgency) return;
  updateInProgress = true;
  clearPageMessage(message);
  const trigger = document.getElementById("statusAction") || collectionForm.querySelector("button[type=submit]");
  setButtonLoading(trigger, true, "Mise à jour…");

  try {
    const parcelRef = doc(db, "colis", parcelId);
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(parcelRef);
      if (!snapshot.exists()) throw new Error("Ce colis n'existe plus.");
      const parcel = { id: snapshot.id, ...snapshot.data() };
      const allowedNext = canMoveToNext(parcel);
      if (allowedNext !== nextStatus) throw new Error("Le statut a changé ou cette action n'est pas autorisée pour votre agence.");

      const now = new Date().toISOString();
      const history = Array.isArray(parcel.history) ? [...parcel.history] : [];
      history.push({
        status: nextStatus,
        date: now,
        agencyName: currentAgency.name,
        city: currentAgency.city
      });
      const changes = {
        status: nextStatus,
        history,
        updatedAt: serverTimestamp()
      };
      if (collectedBy) changes.collectedBy = { ...collectedBy, date: now };
      transaction.update(parcelRef, changes);
      transaction.set(doc(db, "suivis", parcel.trackingCode), {
        code: parcel.trackingCode,
        colisId: parcel.id,
        status: nextStatus,
        history,
        originCity: parcel.originCity,
        destinationCity: parcel.destinationCity,
        lastUpdatedAtISO: now
      });
    });
    collectionModal.hidden = true;
    document.body.classList.remove("modal-open");
    collectionForm.reset();
    showToast("Statut du colis mis à jour.");
  } catch (error) {
    console.error(error);
    showPageMessage(message, errorMessage(error));
  } finally {
    updateInProgress = false;
    setButtonLoading(trigger, false);
  }
}

function bindCollectionForm() {
  collectionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(collectionForm));
    const name = values.collectorName.trim();
    const cni = values.collectorCni.trim().toUpperCase();
    if (name.length < 2) {
      showPageMessage(document.getElementById("collectionMessage"), "Indiquez le nom de la personne qui retire le colis.");
      return;
    }
    if (!isValidCni(cni)) {
      showPageMessage(document.getElementById("collectionMessage"), "Le numéro CNI doit contenir 8 à 25 caractères et au moins un chiffre.");
      return;
    }
    updateStatus("Retiré", { name, cni });
  });
  const closeModal = () => {
    collectionModal.hidden = true;
    document.body.classList.remove("modal-open");
    clearPageMessage(document.getElementById("collectionMessage"));
  };
  document.getElementById("closeCollection")?.addEventListener("click", closeModal);
  document.getElementById("cancelCollection")?.addEventListener("click", closeModal);
}

async function boot() {
  mountLayout();
  parcelId = getQueryParam("id");
  if (!parcelId) {
    showPageMessage(message, "Aucun colis n'a été sélectionné. Retournez au tableau de bord.");
    return;
  }
  const user = await requireAgency();
  if (!user) return;
  currentAgency = await initAgencyLayout(user, "");
  if (!currentAgency) return;
  bindCollectionForm();

  onSnapshot(doc(db, "colis", parcelId), (snapshot) => {
    if (!snapshot.exists()) {
      target.innerHTML = "";
      showPageMessage(message, "Colis introuvable ou accès non autorisé.");
      return;
    }
    clearPageMessage(message);
    currentParcel = { id: snapshot.id, ...snapshot.data() };
    renderDetail(currentParcel);
  }, (error) => {
    showPageMessage(message, errorMessage(error));
  });
}

boot();
