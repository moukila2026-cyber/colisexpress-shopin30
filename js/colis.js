import { api } from "./api.js";
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
import {
  agenceDeclaree,
  agencesRattachables,
  etapeValideeParExpediteur,
  libelleEtatPaiement,
  peutRattacher,
  prochaineEtape,
  villeDivergente
} from "./metier-colis.js";
import {
  TYPES_INCIDENT,
  libelleEtatIncident,
  libelleTypeIncident
} from "./metier-incidents.js";
import { estEnSouffrance, joursDepuis, dateArriveeDestinantion } from "./metier-alertes.js";
import {
  ETAPES_PHOTO,
  MAX_PHOTOS_PAR_ETAPE,
  compresserImage,
  libelleEtapePhoto,
  peutPhotographierCoteClient
} from "./photos.js";

const message = document.getElementById("pageMessage");
const target = document.getElementById("parcelDetail");
const collectionModal = document.getElementById("collectionModal");
const collectionForm = document.getElementById("collectionForm");
let currentAgency = null;
let parcelId = null;
let currentParcel = null;
let currentIncidents = [];
let currentPhotos = [];
let agencies = [];
let updateInProgress = false;
let attachInProgress = false;
let refreshTimer = null;
// LOT 8 — plus aucun paiement en ligne des colis : l'agence encaisse
// elle-même au guichet (espèces ou mobile money). Shopin30 n'encaisse en
// ligne que l'abonnement et les recharges du portefeuille (page Abonnement).

function mountLayout() {
  document.getElementById("sidebarMount").innerHTML = agencySidebar();
  document.getElementById("topbarMount").innerHTML = mobileAgencyHeader(
    "Détail du colis",
    '<a class="icon-button" href="dashboard.html" aria-label="Retour au tableau de bord">←</a>'
  );
}

function canMoveToNext(parcel) {
  return prochaineEtape({ parcel, agencyId: currentAgency?.id });
}

/** Libellé de l'agence de retrait : compte inscrit ou agence déclarée à la main. */
function destinationLabel(parcel) {
  const declared = agenceDeclaree(parcel);
  if (!declared) return parcel.destinationAgencyName || "—";
  return `${declared.name || parcel.destinationAgencyName || "—"} · non inscrite`;
}

function inscriptionUrl() {
  return new URL("inscription.html", window.location.href).href;
}

function relanceTexte(parcel) {
  const declared = agenceDeclaree(parcel) || {};
  return `Bonjour${declared.name ? ` ${declared.name}` : ""}, le colis ${parcel.trackingCode} (${parcel.originCity} → ${parcel.destinationCity}) vous est destiné sur COLIS EXPRESS. Créez votre compte agence pour le prendre en charge et être alertée à chaque étape : ${inscriptionUrl()}`;
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

/* ------------------------------------------------------------------ */
/* Rattachement de l'agence de destination                             */
/* ------------------------------------------------------------------ */

function attachCardHtml(parcel) {
  if (!peutRattacher({ parcel, agencyId: currentAgency?.id })) return "";
  const declared = agenceDeclaree(parcel) || {};
  const rattachables = agencesRattachables({ parcel, agencies, currentAgencyId: currentAgency.id });
  const options = rattachables
    .map((agency) => `<option value="${escapeHTML(agency.id)}">${escapeHTML(agency.name)} — ${escapeHTML(agency.city || "")}</option>`)
    .join("");
  const relance = declared.phone
    ? `<a class="button button-outline" target="_blank" rel="noopener noreferrer" href="${escapeHTML(whatsappShareLink(declared.phone, relanceTexte(parcel)))}">◉ Relancer l'agence sur WhatsApp</a>`
    : "";
  return `
    <section class="info-card attach-card" aria-labelledby="attachTitle">
      <h2 id="attachTitle">Agence de destination à rattacher</h2>
      <p class="attach-intro">Ce colis a été enregistré pour une agence sans compte. Rattachez-la dès qu'elle est inscrite : elle verra le colis dans son tableau de bord et recevra les alertes.</p>
      <dl class="person-data attach-declared">
        <div><dt>Agence déclarée</dt><dd>${escapeHTML(declared.name || "—")}</dd></div>
        <div><dt>Ville déclarée</dt><dd>${escapeHTML(declared.city || "—")}</dd></div>
        <div><dt>Téléphone déclaré</dt><dd>${escapeHTML(declared.phone || "—")}</dd></div>
        <div><dt>Déclaré le</dt><dd>${escapeHTML(formatDateTime(parcel.createdAtISO))}</dd></div>
      </dl>
      ${rattachables.length
        ? `<form id="attachForm" class="attach-form" autocomplete="off">
          <div class="field"><label for="attachAgencyId">Agence inscrite <span class="required">*</span></label>
            <select id="attachAgencyId" required>${options}</select>
            <small class="field-help" id="attachHint">Seules les agences inscrites peuvent être rattachées.</small>
          </div>
          <div class="field"><label for="attachCity">Ville de retrait</label>
            <input id="attachCity" type="text" value="${escapeHTML(parcel.destinationCity || "")}" maxlength="60">
            <small class="field-help">À corriger seulement si la ville saisie à l'enregistrement est fausse.</small>
          </div>
          <div class="attach-actions">
            <button class="button button-primary" id="attachButton" type="submit">Rattacher cette agence</button>
            ${relance}
          </div>
          <p class="attach-footnote">Le rattachement est définitif : une agence rattachée ne peut plus être remplacée en ligne, contactez l'équipe COLIS EXPRESS en cas d'erreur.</p>
        </form>`
        : `<div class="attach-empty">Aucune autre agence inscrite pour le moment. Le reste du colis continue normalement : vous pouvez confirmer vous-même l'arrivée et le retrait.</div>
          <div class="attach-actions">${relance}</div>`}
    </section>`;
}

function selectedAgency() {
  const select = document.getElementById("attachAgencyId");
  if (!select) return null;
  return agencies.find((agency) => agency.id === select.value) || null;
}

function refreshAttachHint() {
  const hint = document.getElementById("attachHint");
  if (!hint || !currentParcel) return;
  const agency = selectedAgency();
  if (!agency) {
    hint.textContent = "Seules les agences inscrites peuvent être rattachées.";
    hint.classList.remove("attach-hint-warning");
    return;
  }
  if (villeDivergente({ parcel: currentParcel, agency })) {
    hint.textContent = `Attention : la ville du colis est « ${currentParcel.destinationCity || "—"} » alors que ce compte est à « ${agency.city || "—"} ». Vérifiez avant de valider.`;
    hint.classList.add("attach-hint-warning");
    return;
  }
  hint.textContent = `${agency.name} recevra le colis et pourra valider l'arrivée puis le retrait.`;
  hint.classList.remove("attach-hint-warning");
}

function bindAttachForm() {
  const form = document.getElementById("attachForm");
  if (!form) return;
  refreshAttachHint();
  form.addEventListener("change", refreshAttachHint);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const agency = selectedAgency();
    if (!agency) {
      showPageMessage(message, "Choisissez l'agence inscrite à rattacher.");
      return;
    }
    rattacherAgence(agency.id, document.getElementById("attachCity").value);
  });
}

async function rattacherAgence(agencyId, destinationCity) {
  if (attachInProgress || !currentParcel || !currentAgency) return;
  attachInProgress = true;
  clearPageMessage(message);
  const button = document.getElementById("attachButton");
  setButtonLoading(button, true, "Rattachement…");
  try {
    const { parcel } = await api(`/api/colis/${encodeURIComponent(parcelId)}/attach`, {
      method: "POST",
      body: { agencyId, destinationCity }
    });
    currentParcel = parcel;
    renderDetail(parcel);
    showToast("Agence de destination rattachée. Elle voit désormais ce colis.");
  } catch (error) {
    console.error(error);
    showPageMessage(message, errorMessage(error));
  } finally {
    attachInProgress = false;
    setButtonLoading(document.getElementById("attachButton"), false);
  }
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Paiement : état du colis et encaissement du solde (LOT 2)          */
/* ------------------------------------------------------------------ */

function etatPaiement(parcel) {
  return libelleEtatPaiement(parcel.paymentStatus ?? null, {
    priceFCFA: parcel.priceFCFA,
    paidAmountFCFA: parcel.paidAmountFCFA ?? 0
  });
}

function paymentCardHtml(parcel) {
  const etat = etatPaiement(parcel);
  const regle = etat.reste <= 0;
  return `
    <section class="info-card payment-card" aria-labelledby="paymentCardTitle">
      <h2 id="paymentCardTitle">Paiement</h2>
      <p class="payment-status ${regle ? "payment-status-ok" : etat.cle ? "payment-status-due" : ""}">${escapeHTML(etat.label)}</p>
      <dl class="person-data">
        <div><dt>Prix du colis</dt><dd>${escapeHTML(formatFCFA(parcel.priceFCFA))}</dd></div>
        <div><dt>Encaissé</dt><dd>${escapeHTML(formatFCFA(parcel.paidAmountFCFA ?? 0))}</dd></div>
        <div><dt>Reste à payer</dt><dd>${escapeHTML(formatFCFA(etat.reste))}</dd></div>
      </dl>
      ${regle ? '<p class="muted-note">Aucun montant restant dû.</p>' : '<div class="payment-actions"><button class="button button-primary button-small" id="openEncaisser" type="button">Encaisser le solde</button></div><p class="muted-note">Encaissement au guichet de votre agence (espèces ou mobile money), inscrit dans votre caisse du jour.</p>'}
    </section>`;
}

function openPaymentModal() {
  if (!currentParcel) return;
  const etat = etatPaiement(currentParcel);
  document.getElementById("encaisserAmount").value = String(etat.reste);
  document.getElementById("encaisserResteHint").textContent = `Reste à encaisser : ${formatFCFA(etat.reste)} sur ${formatFCFA(currentParcel.priceFCFA)}.`;
  document.getElementById("paymentCollectMessage").hidden = true;
  document.getElementById("paymentModal").hidden = false;
  document.body.classList.add("modal-open");
  document.getElementById("encaisserAmount").focus();
}

function closePaymentModal() {
  document.getElementById("paymentModal").hidden = true;
  document.body.classList.remove("modal-open");
  clearPageMessage(document.getElementById("paymentCollectMessage"));
}

async function encaisserSolde(event) {
  event.preventDefault();
  if (!currentParcel || updateInProgress) return;
  const cible = document.getElementById("paymentCollectMessage");
  clearPageMessage(cible);
  const values = Object.fromEntries(new FormData(document.getElementById("encaisserForm")));
  const montant = Math.round(Number(values.encaisserAmount));
  const etat = etatPaiement(currentParcel);
  if (!Number.isFinite(montant) || montant <= 0) {
    showPageMessage(cible, "Indiquez le montant encaissé (supérieur à 0 FCFA).");
    return;
  }
  if (montant > etat.reste) {
    showPageMessage(cible, `Le montant dépasse le reste à encaisser (${formatFCFA(etat.reste)}).`);
    return;
  }
  const mode = values.encaisserMode;
  if (mode !== "especes" && mode !== "mobile_money") {
    showPageMessage(cible, "Choisissez le mode de paiement : espèces ou mobile money.");
    return;
  }

  updateInProgress = true;
  const trigger = document.querySelector("#encaisserForm button[type=submit]");
  setButtonLoading(trigger, true, "Encaissement…");
  try {
    const { parcel } = await api(`/api/colis/${encodeURIComponent(parcelId)}/encaisser`, {
      method: "POST",
      body: { amountFCFA: montant, mode }
    });
    currentParcel = parcel;
    renderDetail(parcel);
    closePaymentModal();
    document.getElementById("encaisserForm").reset();
    showToast(`Encaissement de ${formatFCFA(montant)} enregistré dans la caisse du jour.`);
  } catch (error) {
    showPageMessage(cible, errorMessage(error));
  } finally {
    updateInProgress = false;
    setButtonLoading(trigger, false);
  }
}

function bindPaymentForm() {
  document.getElementById("openEncaisser")?.addEventListener("click", openPaymentModal);
  document.getElementById("closePayment")?.addEventListener("click", closePaymentModal);
  document.getElementById("cancelEncaisser")?.addEventListener("click", closePaymentModal);
  document.getElementById("encaisserForm")?.addEventListener("submit", encaisserSolde);
}

/* ------------------------------------------------------------------ */
/* LOT 4 — incidents, photos de preuve, souffrance/retour, bordereau   */
/* ------------------------------------------------------------------ */

function incidentActif() {
  return currentIncidents.find((incident) => incident.state !== "resolu") || null;
}

function incidentCardHtml(parcel) {
  const actif = incidentActif();
  const resous = currentIncidents.filter((incident) => incident.state === "resolu");
  if (actif) {
    const escalade = actif.filePlateforme
      ? '<p class="incident-escalade incident-escalade-plateforme">⚠ Ouvert depuis plus de 7 jours : transmis à la file d\'arbitrage plateforme.</p>'
      : actif.alerte24h
        ? '<p class="incident-escalade">⚠ Ouvert depuis plus de 24 h : relancez l\'autre agence (WhatsApp, téléphone).</p>'
        : "";
    return `
      <section class="info-card incident-card incident-${escapeHTML(actif.state)}" aria-labelledby="incidentCardTitle">
        <h2 id="incidentCardTitle">Incident en cours</h2>
        <p class="incident-status"><span class="incident-type incident-type-${escapeHTML(actif.type)}">${escapeHTML(libelleTypeIncident(actif.type))}</span> ${statusBadge(`État : ${libelleEtatIncident(actif.state)}`)}</p>
        <p class="incident-note">${escapeHTML(actif.note)}</p>
        <dl class="person-data">
          <div><dt>Ouvert le</dt><dd>${escapeHTML(formatDateTime(actif.openedAtISO))}</dd></div>
          <div><dt>Ouvert par</dt><dd>${escapeHTML(actif.openedByName || "l'agence")}</dd></div>
          ${actif.bordereauId ? `<div><dt>Bordereau en preuve</dt><dd><a class="table-link" href="bordereaux.html?id=${encodeURIComponent(actif.bordereauId)}">Voir le bordereau</a></dd></div>` : ""}
          ${actif.resolution ? `<div><dt>Résolution</dt><dd>${escapeHTML(actif.resolution)}</dd></div>` : ""}
        </dl>
        ${escalade}
        <div class="incident-actions">
          ${actif.state === "ouvert" ? '<button class="button button-outline button-small" type="button" data-incident-action="recherches">Passer en recherches</button>' : ""}
          <div class="incident-resolve">
            <label for="incidentResolution">Expliquez comment l'incident est résolu <span class="required">*</span></label>
            <textarea id="incidentResolution" name="incidentResolution" rows="2" maxlength="2000" placeholder="Ex. colis retrouvé dans le car, remis au destinataire le …"></textarea>
            <button class="button button-primary button-small" type="button" data-incident-action="resolu">Résoudre l'incident</button>
          </div>
        </div>
      </section>`;
  }
  return `
    <section class="info-card incident-card" aria-labelledby="incidentCardTitle">
      <h2 id="incidentCardTitle">Incident</h2>
      <p class="muted-note">Aucun incident en cours sur ce colis${resous.length ? ` · ${resous.length} incident(s) résolu(s)` : ""}. En cas de perte, dommage, retard, contestation ou blocage, ouvrez un incident : il est visible par les deux agences et un bandeau sobre prévient le client sur le suivi public.</p>
      <form id="incidentForm" class="form-stack" novalidate>
        <div class="field"><label for="incidentType">Type d'incident <span class="required">*</span></label>
          <select id="incidentType" name="incidentType">${TYPES_INCIDENT.map((type) => `<option value="${type.id}">${type.label}</option>`).join("")}</select>
        </div>
        <div class="field"><label for="incidentNote">Description <span class="required">*</span></label>
          <textarea id="incidentNote" name="incidentNote" rows="2" minlength="2" maxlength="2000" placeholder="Ex. colis absent du bordereau reçu ce jour, emballage écrasé…" required></textarea>
        </div>
        <div class="page-message" id="incidentMessage" hidden role="alert"></div>
        <div class="form-footer"><button class="button button-outline" type="submit">Ouvrir l'incident</button></div>
      </form>
      ${resous.map((incident) => `<details class="incident-resolu"><summary>${escapeHTML(libelleTypeIncident(incident.type))} — résolu le ${escapeHTML(formatDateTime(incident.resolvedAtISO))}</summary><p>${escapeHTML(incident.note)}</p><p class="muted-note">Résolution : ${escapeHTML(incident.resolution)}</p></details>`).join("")}
    </section>`;
}

function photosCardHtml(parcel) {
  return `
    <section class="info-card photos-card" aria-labelledby="photosCardTitle">
      <h2 id="photosCardTitle">Photos de preuve</h2>
      <p class="muted-note">2 photos maximum par étape, compressées (~200 Ko). Réservées aux deux agences du colis — jamais publiques, jamais supprimables.</p>
      <div class="photos-etapes">${ETAPES_PHOTO.map((etape) => {
        const photos = currentPhotos.filter((photo) => photo.etape === etape.id);
        const peut = peutPhotographierCoteClient({ parcel, agencyId: currentAgency?.id, etape: etape.id });
        return `
          <div class="photos-etape" data-etape="${etape.id}">
            <h3>${escapeHTML(etape.label)} <small>(${photos.length}/${MAX_PHOTOS_PAR_ETAPE})</small></h3>
            <div class="photos-grid">${photos.map((photo) => `
              <figure class="photo-frame">
                <img src="/api/photos/${encodeURIComponent(photo.id)}" alt="Photo ${escapeHTML(libelleEtapePhoto(photo.etape))} du colis ${escapeHTML(parcel.trackingCode)}" loading="lazy">
                <figcaption>${escapeHTML(photo.agencyName || "Agence")} · ${escapeHTML(photo.agentName || "")} · ${escapeHTML(formatDateTime(photo.createdAtISO))}</figcaption>
              </figure>`).join("") || '<p class="muted-note">Aucune photo pour cette étape.</p>'}
            </div>
            ${peut && photos.length < MAX_PHOTOS_PAR_ETAPE ? `<button class="button button-outline button-small" type="button" data-photo-upload="${etape.id}">＋ Ajouter une photo</button>` : ""}
            <input type="file" accept="image/*" class="photo-input" data-etape="${etape.id}" hidden>
          </div>`;
      }).join("")}</div>
      <div class="page-message" id="photoMessage" hidden role="alert"></div>
    </section>`;
}

function retourCardHtml(parcel) {
  const detenteur = parcel.destinationAgencyId ?? parcel.ownerId;
  const peutDecider = parcel.status === "Arrivé à l'agence de destination" && !parcel.retourStatus && detenteur === currentAgency?.id;
  const peutRecevoir = parcel.retourStatus === "en_cours" && parcel.ownerId === currentAgency?.id;
  const souffrance = estEnSouffrance(parcel);
  if (!peutDecider && !peutRecevoir && !parcel.retourStatus && !souffrance) return "";

  const arrivee = dateArriveeDestinantion(parcel);
  return `
    <section class="info-card retour-card" aria-labelledby="retourCardTitle">
      <h2 id="retourCardTitle">Colis en souffrance — retour à l'expéditeur</h2>
      ${souffrance ? `<p class="retour-warning">⚠ Arrivé et non retiré depuis ${joursDepuis(arrivee ?? parcel.updatedAtISO)} jours (seuil : 7 jours).</p>` : ""}
      ${parcel.retourStatus === "en_cours" ? `<p class="notice-box">Retour à l'expéditeur décidé le ${escapeHTML(formatDateTime(parcel.retourStartedAt))}. ${peutRecevoir ? "Confirmez la réception quand le colis est revenu dans votre agence." : "L'agence expéditrice confirmera la réception."}</p>` : ""}
      ${parcel.retourStatus === "termine" ? `<p class="notice-box">Colis retourné à l'expéditeur le ${escapeHTML(formatDateTime(parcel.retourCompletedAt))}.</p>` : ""}
      <div class="payment-actions">
        ${peutDecider ? '<button class="button button-primary button-small" id="openRetour" type="button">Décider le retour à l\'expéditeur</button>' : ""}
        ${peutRecevoir ? '<button class="button button-primary button-small" id="recevoirRetour" type="button">Confirmer la réception du retour</button>' : ""}
      </div>
    </section>`;
}

function bindIncidentActions() {
  document.getElementById("incidentForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const cible = document.getElementById("incidentMessage");
    clearPageMessage(cible);
    const values = Object.fromEntries(new FormData(event.target));
    try {
      await api(`/api/colis/${encodeURIComponent(parcelId)}/incidents`, {
        method: "POST",
        body: { type: values.incidentType, note: values.incidentNote }
      });
      showToast("Incident ouvert. Les deux agences le voient, le suivi public affiche un bandeau sobre.");
      await chargerColis({ silencieux: true });
    } catch (error) {
      showPageMessage(cible, errorMessage(error));
    }
  });
  target.querySelectorAll("[data-incident-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const actif = incidentActif();
      if (!actif) return;
      const action = button.dataset.incidentAction;
      const resolution = action === "resolu" ? document.getElementById("incidentResolution")?.value : "";
      if (action === "resolu" && (resolution || "").trim().length < 2) {
        showToast("Expliquez comment l'incident a été résolu avant de le clôturer.", "error");
        return;
      }
      setButtonLoading(button, true, "Mise à jour…");
      try {
        await api(`/api/incidents/${encodeURIComponent(actif.id)}`, {
          method: "PATCH",
          body: { state: action === "resolu" ? "resolu" : "recherches", resolution }
        });
        showToast(action === "resolu" ? "Incident résolu." : "Incident passé en recherches.");
        await chargerColis({ silencieux: true });
      } catch (error) {
        showPageMessage(message, errorMessage(error));
        setButtonLoading(button, false);
      }
    });
  });
}

function bindPhotoActions() {
  target.querySelectorAll("[data-photo-upload]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = target.querySelector(`.photo-input[data-etape="${button.dataset.photoUpload}"]`);
      input?.click();
    });
  });
  target.querySelectorAll(".photo-input").forEach((input) => {
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      const cible = document.getElementById("photoMessage");
      clearPageMessage(cible);
      try {
        const dataUrl = await compresserImage(file);
        const res = await api(`/api/colis/${encodeURIComponent(parcelId)}/photos`, {
          method: "POST",
          body: { etape: input.dataset.etape, image: dataUrl }
        });
        currentPhotos.push(res.photo);
        showToast("Photo de preuve ajoutée.");
        await chargerColis({ silencieux: true });
      } catch (error) {
        showPageMessage(cible, errorMessage(error));
      }
    });
  });
}

function bindRetourActions() {
  const modal = document.getElementById("retourModal");
  const form = document.getElementById("retourForm");
  const fermer = () => {
    modal.hidden = true;
    document.body.classList.remove("modal-open");
    clearPageMessage(document.getElementById("retourMessage"));
  };
  document.getElementById("openRetour")?.addEventListener("click", () => {
    modal.hidden = false;
    document.body.classList.add("modal-open");
    document.getElementById("retourFrais").focus();
  });
  document.getElementById("closeRetour")?.addEventListener("click", fermer);
  document.getElementById("cancelRetour")?.addEventListener("click", fermer);
  document.getElementById("retourFrais")?.addEventListener("input", (event) => {
    document.getElementById("retourModeField").hidden = Number(event.target.value || 0) <= 0;
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const cible = document.getElementById("retourMessage");
    clearPageMessage(cible);
    const values = Object.fromEntries(new FormData(form));
    const frais = Math.round(Number(values.retourFrais || 0));
    const trigger = form.querySelector("button[type=submit]");
    setButtonLoading(trigger, true, "Enregistrement…");
    try {
      const { parcel } = await api(`/api/colis/${encodeURIComponent(parcelId)}/retour`, {
        method: "POST",
        body: frais > 0
          ? { etape: "decider", fraisMagasinageFCFA: frais, mode: values.retourMode }
          : { etape: "decider" }
      });
      currentParcel = parcel;
      fermer();
      form.reset();
      renderDetail(parcel);
      showToast(frais > 0 ? `Retour décidé — frais de magasinage de ${frais} FCFA encaissés dans votre caisse du jour.` : "Retour à l'expéditeur décidé et tracé dans l'historique.");
    } catch (error) {
      showPageMessage(cible, errorMessage(error));
    } finally {
      setButtonLoading(trigger, false);
    }
  });
  document.getElementById("recevoirRetour")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setButtonLoading(button, true, "Confirmation…");
    try {
      const { parcel } = await api(`/api/colis/${encodeURIComponent(parcelId)}/retour`, {
        method: "POST",
        body: { etape: "recevoir" }
      });
      currentParcel = parcel;
      renderDetail(parcel);
      showToast("Réception du retour confirmée : le colis est revenu à l'agence expéditrice.");
    } catch (error) {
      showPageMessage(message, errorMessage(error));
      setButtonLoading(button, false);
    }
  });
}

function renderDetail(parcel) {
  const nextStatus = canMoveToNext(parcel);
  const canNotify = whatsappLink(parcel);
  const statusIndex = STATUTS.indexOf(parcel.status);
  const pending = peutRattacher({ parcel, agencyId: currentAgency?.id });
  const exceptionNote = etapeValideeParExpediteur({ parcel, agencyId: currentAgency?.id, nextStatus })
    ? `<p class="action-note">Agence de destination non encore inscrite : c'est votre agence qui valide cette étape. Rattachez l'agence ci-dessous pour qu'elle prenne le relais.</p>`
    : "";
  target.innerHTML = `
    <div class="detail-heading">
      <div>
        <a class="back-link" href="dashboard.html">← Retour aux colis</a>
        <p class="eyebrow">Code de suivi</p>
        <h1 class="detail-code">${escapeHTML(parcel.trackingCode)}</h1>
      </div>
      <div class="detail-status">${statusBadge(parcel.status)}${pending ? '<span class="attach-flag">Agence à rattacher</span>' : ""}</div>
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
          <div><span class="route-dot route-end"></span><small>Destination</small><strong>${escapeHTML(parcel.destinationCity)}</strong><p>${escapeHTML(destinationLabel(parcel))}</p></div>
        </div>
        ${parcel.destinationAgencyAttachedAt ? `<p class="attached-note">Rattachée le ${escapeHTML(formatDateTime(parcel.destinationAgencyAttachedAt))} par ${escapeHTML(parcel.destinationAgencyAttachedBy || "l'agence expéditrice")}</p>` : ""}
        ${parcel.bordereauId ? `<p class="attached-note"><a class="table-link" href="bordereaux.html?id=${encodeURIComponent(parcel.bordereauId)}">▤ Voir le bordereau d'acheminement</a></p>` : ""}
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
          <div><dt>Agence de retrait</dt><dd>${escapeHTML(destinationLabel(parcel))}</dd></div>
          ${agenceDeclaree(parcel)?.phone ? `<div><dt>Téléphone de l'agence</dt><dd>${escapeHTML(agenceDeclaree(parcel).phone)}</dd></div>` : ""}
        </dl>
      </section>

      ${paymentCardHtml(parcel)}

      ${incidentCardHtml(parcel)}

      ${photosCardHtml(parcel)}

      ${retourCardHtml(parcel)}

      ${parcel.collectedBy ? `<section class="info-card collected-card"><h2>Retrait enregistré</h2><dl class="person-data"><div><dt>Retiré par</dt><dd>${escapeHTML(parcel.collectedBy.name)}</dd></div><div><dt>N° CNI présenté</dt><dd>${escapeHTML(parcel.collectedBy.cni)}</dd></div><div><dt>Date</dt><dd>${escapeHTML(formatDateTime(parcel.collectedBy.date))}</dd></div></dl></section>` : ""}
    </div>

    <section class="action-card">
      <div><p class="eyebrow">Action sur le colis</p><h2>${nextStatus ? escapeHTML(ACTIONS_STATUT[nextStatus]) : "Aucune action disponible"}</h2>
      <p>${nextStatus ? "Chaque mise à jour est visible immédiatement dans le suivi public." : (parcel.status === "Retiré" ? "Ce colis a déjà été retiré." : "Cette étape doit être effectuée par l'agence concernée.")}</p>
      ${exceptionNote}</div>
      <div class="action-stack">
        ${nextStatus ? `<button class="button button-primary" id="statusAction" type="button">${escapeHTML(ACTIONS_STATUT[nextStatus])}</button>` : ""}
        ${canNotify}
        ${shareLinks(parcel)}
      </div>
    </section>

    ${attachCardHtml(parcel)}

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
  bindAttachForm();
  bindPaymentForm();
  bindIncidentActions();
  bindPhotoActions();
  bindRetourActions();
}

async function updateStatus(nextStatus, collectedBy = null) {
  if (updateInProgress || !currentParcel || !currentAgency) return;
  updateInProgress = true;
  clearPageMessage(message);
  const trigger = document.getElementById("statusAction") || collectionForm.querySelector("button[type=submit]");
  setButtonLoading(trigger, true, "Mise à jour…");

  try {
    const attendu = canMoveToNext(currentParcel);
    if (attendu !== nextStatus) throw new Error("Le statut a changé ou cette action n'est pas autorisée pour votre agence.");
    const { parcel } = await api(`/api/colis/${encodeURIComponent(parcelId)}/progress`, {
      method: "POST",
      body: collectedBy ? { collectedBy } : {}
    });
    currentParcel = parcel;
    renderDetail(parcel);
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

async function chargerColis({ silencieux = false } = {}) {
  try {
    const [{ parcel }, incidentsRes, photosRes] = await Promise.all([
      api(`/api/colis/${encodeURIComponent(parcelId)}`),
      // LOT 4 : incidents des deux agences et photos de preuve. Un échec de
      // ces routes secondaires ne doit pas priver l'agence de la fiche colis.
      api("/api/incidents").catch(() => ({ incidents: [] })),
      api(`/api/colis/${encodeURIComponent(parcelId)}/photos`).catch(() => ({ photos: [] }))
    ]);
    clearPageMessage(message);
    currentParcel = parcel;
    currentIncidents = incidentsRes.incidents.filter((incident) => incident.parcel?.id === parcel.id);
    currentPhotos = photosRes.photos || [];
    renderDetail(parcel);
  } catch (error) {
    if (silencieux) return;
    target.innerHTML = "";
    if (error.status === 404) {
      showPageMessage(message, "Colis introuvable ou accès non autorisé.");
    } else {
      showPageMessage(message, errorMessage(error));
    }
  }
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

  // Annuaire des agences : nécessaire pour proposer un rattachement.
  try {
    const data = await api("/api/agences");
    agencies = data.agencies;
  } catch (error) {
    console.error(error);
  }

  await chargerColis();
  // Ancien lien de retour de paiement (LOT 7) : simplement nettoyé.
  if (getQueryParam("paiement")) window.history.replaceState(null, "", `colis.html?id=${encodeURIComponent(parcelId)}`);
  refreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") chargerColis({ silencieux: true });
  }, 15000);
}

window.addEventListener("beforeunload", () => {
  if (refreshTimer) clearInterval(refreshTimer);
});

boot();
