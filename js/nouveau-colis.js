import { api } from "./api.js";
import { requireAgency } from "./auth.js";
import { agencySidebar, diffuserCompteur, initAgencyLayout, mobileAgencyHeader, surCompteur } from "./layout.js";
import { phraseProchainColis } from "./metier-plans.js";
import {
  libelleEtatPaiement,
  resoudreDestination,
  validerColis,
  validerPaiement
} from "./metier-colis.js";
import { optionsPrix } from "./metier-tarifs.js";
import { nomClient } from "./metier-clients.js";
import {
  clearPageMessage,
  errorMessage,
  escapeHTML,
  formatFCFA,
  isValidIvorianPhone,
  normalizeIvorianPhone,
  setButtonLoading,
  publicTrackingUrl,
  showPageMessage,
  whatsappShareLink
} from "./utils.js";

const form = document.getElementById("parcelForm");
const message = document.getElementById("pageMessage");
const destinationSelect = document.getElementById("destinationAgencyId");
const unregisteredToggle = document.getElementById("agencyNotRegistered");
const unregisteredPanel = document.getElementById("unregisteredAgencyPanel");
const submitButton = document.getElementById("saveParcelButton");
const receiptModal = document.getElementById("receiptModal");
const receiptContent = document.getElementById("receiptContent");
const priceSelect = document.getElementById("priceTarif");
const priceFree = document.getElementById("priceFCFA");
const priceHelp = document.getElementById("priceHelp");
const priceRecap = document.getElementById("priceRecap");
let currentAgency = null;
let agencies = [];
let tarifs = [];

/**
 * LOT 6 — rappel du quota avant l'enregistrement : colis inclus restants,
 * colis hors forfait prépayé (30 FCFA) ou portefeuille insuffisant. Le
 * serveur reste seul juge (POST /api/colis) ; ce bandeau n'est qu'informatif.
 */
function afficherProchainColis(resume) {
  const ligne = document.getElementById("prochainColis");
  if (!ligne || !resume) return;
  const phrase = phraseProchainColis(resume);
  ligne.dataset.niveau = phrase.niveau;
  ligne.textContent = phrase.texte;
}

async function rafraichirQuota() {
  const notice = document.getElementById("quotaNotice");
  if (!notice) return;
  try {
    const { resume } = await api(`/api/facturation?resume=1&_=${Date.now()}`);
    afficherProchainColis(resume);
    const depassement = resume.prochainColis?.type === "depassement";
    const insuffisant = depassement && resume.soldeFCFA < resume.prochainColis.montantFCFA;
    notice.hidden = !resume.alerte;
    notice.classList.toggle("notice-danger", Boolean(insuffisant || resume.enRetard));
    notice.innerHTML = resume.alerte
      ? `${escapeHTML(resume.alerte)} <a class="table-link" href="abonnement.html">Voir l'abonnement</a>`
      : "";
  } catch {
    notice.hidden = true;
  }
}

function mountLayout() {
  document.getElementById("sidebarMount").innerHTML = agencySidebar();
  document.getElementById("topbarMount").innerHTML = mobileAgencyHeader("Nouveau colis");
}

function agencyMode() {
  return unregisteredToggle?.checked === true;
}

function syncDestinationMode() {
  const unregistered = agencyMode();
  if (unregisteredPanel) unregisteredPanel.hidden = !unregistered;
  destinationSelect.disabled = unregistered;
  destinationSelect.required = !unregistered;
  document.getElementById("destinationRequired")?.toggleAttribute("hidden", unregistered);
  if (unregistered) {
    updateInviteLink();
  } else {
    renderDestinationAgencies();
  }
}

function renderDestinationAgencies() {
  if (agencyMode()) return;
  const previous = destinationSelect.value;
  const options = agencies
    .filter((agency) => agency.id !== currentAgency?.id)
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", "fr"))
    .map((agency) => `<option value="${escapeHTML(agency.id)}">${escapeHTML(agency.name)} — ${escapeHTML(agency.city)}</option>`)
    .join("");
  destinationSelect.innerHTML = `<option value="">Choisir une agence de destination</option>${options}`;
  if (agencies.some((agency) => agency.id === previous)) destinationSelect.value = previous;
  document.getElementById("noDestinationAgency").hidden = Boolean(options);
}

/** Lien d'invitation vers l'agence saisie à la main (elle n'a pas encore de compte). */
function invitationAgence() {
  const phone = document.getElementById("declaredAgencyPhone").value;
  const name = document.getElementById("declaredAgencyName").value.trim();
  const city = document.getElementById("declaredAgencyCity").value.trim();
  const url = new URL("inscription.html", window.location.href);
  const text = `Bonjour${name ? ` ${name}` : ""}, COLIS EXPRESS a un colis${city ? ` à livrer à ${city}` : ""} pour vous. Créez votre compte agence en 2 minutes pour être prévenue à chaque arrivée et suivre vos colis : ${url.href}`;
  return isValidIvorianPhone(phone) ? whatsappShareLink(phone, text) : null;
}

function updateInviteLink() {
  const link = document.getElementById("inviteAgencyWhatsapp");
  if (!link) return;
  const href = invitationAgence();
  if (href) link.setAttribute("href", href);
  else link.setAttribute("href", "#");
  link.classList.toggle("is-disabled", !href);
  link.setAttribute("aria-disabled", href ? "false" : "true");
}

function validate(values) {
  return validerColis({ values, agencyNotRegistered: agencyMode() });
}

/* --------------------------- prix par la grille ---------------------------- */

/** Prix actuellement retenu : menu déroulant (grille) ou saisie libre. */
function prixCourant() {
  if (priceSelect && !priceSelect.hidden && !priceSelect.disabled && priceSelect.value !== "") {
    return Number(priceSelect.value);
  }
  return Number(priceFree?.value);
}

/**
 * Alimente le menu déroulant « prix » depuis la grille de l'agence selon
 * destination + poids. Si la grille est vide ou non applicable, la saisie
 * libre reste autorisée (compatibilité).
 */
function refreshPrix() {
  const originCity = document.getElementById("originCity").value;
  const destinationCity = document.getElementById("destinationCity").value;
  const weightKg = document.getElementById("weightKg").value;
  const options = optionsPrix({ tarifs, originCity, destinationCity, weightKg });

  const enGrille = options.length > 0;
  priceSelect.hidden = !enGrille;
  priceSelect.disabled = !enGrille;
  priceFree.hidden = enGrille;
  priceFree.disabled = enGrille;
  if (enGrille) {
    priceSelect.innerHTML = options
      .map((option, index) => `<option value="${option.priceFCFA}"${index === 0 ? " selected" : ""}>${escapeHTML(option.label)}</option>`)
      .join("");
    priceHelp.textContent = "Prix défini par la grille tarifaire de votre agence (Paramètres > Tarifs). Il sera figé sur le colis.";
  } else if (tarifs.length > 0) {
    priceHelp.textContent = "Aucun tarif ne correspond à cet axe et à ce poids : saisie libre autorisée (complétez votre grille dans Paramètres > Tarifs).";
  } else {
    priceHelp.textContent = "Saisie libre : votre agence n'a pas encore de grille tarifaire (Paramètres > Tarifs).";
  }
  rendreRecap();
  rendreResteDu();
}

/** Récapitulatif affiché avant validation de l'enregistrement. */
function rendreRecap() {
  const originCity = document.getElementById("originCity").value.trim();
  const destinationCity = document.getElementById("destinationCity").value.trim();
  const weightKg = document.getElementById("weightKg").value;
  const prix = prixCourant();
  if (!originCity || !destinationCity || !weightKg || !Number.isFinite(prix) || prix < 0) {
    priceRecap.hidden = true;
    priceRecap.innerHTML = "";
    return;
  }
  const enGrille = !priceSelect.hidden;
  priceRecap.hidden = false;
  priceRecap.innerHTML = `
    <strong>Récapitulatif avant validation</strong>
    <dl class="recap-grid">
      <div><dt>Itinéraire</dt><dd>${escapeHTML(originCity)} → ${escapeHTML(destinationCity)}</dd></div>
      <div><dt>Poids</dt><dd>${escapeHTML(String(weightKg))} kg</dd></div>
      <div><dt>Prix</dt><dd>${escapeHTML(formatFCFA(prix))}${enGrille ? " — grille tarifaire" : " — saisie libre"}</dd></div>
    </dl>
    <small>Le prix sera figé sur le colis à l'enregistrement.</small>`;
}

/* --------------------- carnet de clients (LOT 3) --------------------------- */

/**
 * Recherche par téléphone dans le carnet de l'agence : si le client est
 * connu, un bouton propose de pré-remplir ses champs en un geste.
 */
const PREFILL = [
  {
    phoneId: "senderPhone",
    matchId: "senderMatch",
    kind: "expediteur",
    champs: { senderFirstName: "firstName", senderLastName: "lastName", senderCni: "cni" }
  },
  {
    phoneId: "recipientPhone",
    matchId: "recipientMatch",
    kind: "destinataire",
    champs: { recipientFirstName: "firstName", recipientLastName: "lastName" }
  }
];

async function chercherClientConn(telephone, kind) {
  const phone = normalizeIvorianPhone(telephone);
  if (!isValidIvorianPhone(phone)) return null;
  try {
    const { clients } = await api(`/api/clients?recherche=${encodeURIComponent(phone)}&kind=${kind}`);
    return clients.find((client) => client.phone === phone) || null;
  } catch {
    return null; // carnet indisponible : la saisie manuelle reste la norme
  }
}

function renderClientMatch(cible, client, config) {
  if (!client) {
    cible.hidden = true;
    cible.innerHTML = "";
    return;
  }
  cible.hidden = false;
  cible.innerHTML = `<button class="client-match-button" type="button" data-prefill="${escapeHTML(config.phoneId)}">
    ✆ Client connu : <strong>${escapeHTML(nomClient(client))}</strong>${client.city ? ` — ${escapeHTML(client.city)}` : ""} · pré-remplir
  </button>`;
  cible.querySelector("button").addEventListener("click", () => {
    for (const [champId, cle] of Object.entries(config.champs)) {
      const valeur = client[cle] || "";
      const champ = document.getElementById(champId);
      if (champ && valeur) champ.value = valeur;
    }
    cible.hidden = true;
  });
}

function bindClientPrefill() {
  for (const config of PREFILL) {
    const input = document.getElementById(config.phoneId);
    const cible = document.getElementById(config.matchId);
    if (!input || !cible) continue;
    let timer = null;
    input.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const client = await chercherClientConn(input.value, config.kind);
        renderClientMatch(cible, client, config);
      }, 350);
    });
  }
}

/* --------------------------- état de paiement ----------------------------- */

function syncPaiement() {
  const status = document.getElementById("paymentStatus")?.value;
  document.getElementById("paidAmountField").hidden = status !== "partiel";
  document.getElementById("paymentModeField").hidden = status === "arrivee";
  rendreResteDu();
}

function rendreResteDu() {
  const cible = document.getElementById("resteDu");
  if (!cible) return;
  const prix = prixCourant();
  const status = document.getElementById("paymentStatus")?.value;
  if (!Number.isFinite(prix) || prix < 0) {
    cible.textContent = "—";
    return;
  }
  if (status === "arrivee") {
    cible.textContent = formatFCFA(prix);
  } else if (status === "partiel") {
    const paye = Number(document.getElementById("paidAmountFCFA")?.value || 0);
    cible.textContent = formatFCFA(Math.max(0, prix - paye));
  } else {
    cible.textContent = formatFCFA(0);
  }
}

function qrCodeSvg(text) {
  if (typeof window.qrcode !== "function") return "";
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function renderReceiptShare(parcel) {
  const link = publicTrackingUrl(parcel.trackingCode);
  const share = document.getElementById("receiptShare");
  const links = [];
  if (parcel.recipient?.phone) {
    const text = `Bonjour ${parcel.recipient.firstName}, votre colis COLIS EXPRESS est enregistré. Code de suivi : ${parcel.trackingCode}. Suivez-le ici : ${link}`;
    links.push(`<a class="button button-whatsapp" target="_blank" rel="noopener noreferrer" href="${escapeHTML(whatsappShareLink(parcel.recipient.phone, text))}">Envoyer le code au destinataire</a>`);
  }
  if (parcel.sender?.phone) {
    const text = `Bonjour ${parcel.sender.firstName}, votre colis ${parcel.trackingCode} est enregistré. Suivez-le ici : ${link}`;
    links.push(`<a class="button button-outline" target="_blank" rel="noopener noreferrer" href="${escapeHTML(whatsappShareLink(parcel.sender.phone, text))}">Envoyer le code à l'expéditeur</a>`);
  }
  const declared = parcel.unregisteredDestinationAgency;
  if (declared?.phone) {
    const url = new URL("inscription.html", window.location.href);
    const text = `Bonjour ${declared.name}, un colis ${parcel.trackingCode} (${parcel.originCity} → ${parcel.destinationCity}) est attendu chez vous. Suivi : ${link} — Créez votre compte agence pour être alertée à l'arrivée : ${url.href}`;
    links.push(`<a class="button button-outline" target="_blank" rel="noopener noreferrer" href="${escapeHTML(whatsappShareLink(declared.phone, text))}">Prévenir l'agence de destination</a>`);
  }
  share.innerHTML = links.join("");
}

function showReceipt(parcel) {
  const pendingNotice = parcel.destinationAgencyId === null
    ? `<p class="receipt-warning">Le retrait s'effectue chez <strong>${escapeHTML(parcel.unregisteredDestinationAgency?.name || parcel.destinationAgencyName)}</strong>${parcel.unregisteredDestinationAgency?.city ? ` à ${escapeHTML(parcel.unregisteredDestinationAgency.city)}` : ""}. Ce point de retrait n'est pas encore inscrit sur COLIS EXPRESS : votre agence le confirmera dans l'application et vous serez prévenu ici.</p>`
    : "";
  receiptContent.innerHTML = `
    <div class="receipt-brand"><span class="brand-mark">CE</span><strong>COLIS <em>EXPRESS</em></strong></div>
    <p class="receipt-title">Reçu d'enregistrement</p>
    <div class="receipt-code">${escapeHTML(parcel.trackingCode)}</div>
    <p class="receipt-help">Conservez ce code pour suivre votre colis sur COLIS EXPRESS, ou scannez le QR code ci-dessous.</p>
    <div class="receipt-qr" aria-label="QR code de suivi">${qrCodeSvg(publicTrackingUrl(parcel.trackingCode))}</div>
    <div class="receipt-grid">
      <div><small>Expéditeur</small><strong>${escapeHTML(`${parcel.sender.firstName} ${parcel.sender.lastName}`)}</strong><span>${escapeHTML(parcel.sender.phone)}</span></div>
      <div><small>Destinataire</small><strong>${escapeHTML(`${parcel.recipient.firstName} ${parcel.recipient.lastName}`)}</strong><span>${escapeHTML(parcel.recipient.phone)}</span></div>
      <div><small>Itinéraire</small><strong>${escapeHTML(parcel.originCity)} → ${escapeHTML(parcel.destinationCity)}</strong><span>${escapeHTML(parcel.destinationAgencyName)}${parcel.destinationAgencyId === null ? " (à confirmer)" : ""}</span></div>
      <div><small>Colis</small><strong>${escapeHTML(parcel.packageNature)}</strong><span>${escapeHTML(String(parcel.weightKg))} kg · ${escapeHTML(formatFCFA(parcel.priceFCFA))}</span></div>
    </div>
    <p class="receipt-payment">Paiement : <strong>${escapeHTML(libelleEtatPaiement(parcel.paymentStatus, { priceFCFA: parcel.priceFCFA, paidAmountFCFA: parcel.paidAmountFCFA ?? 0 }).label)}</strong>${(parcel.paidAmountFCFA ?? 0) > 0 ? ` · ${escapeHTML(formatFCFA(parcel.paidAmountFCFA))} encaissés` : ""}</p>
    ${pendingNotice}
    <p class="receipt-date">Enregistré le ${escapeHTML(new Intl.DateTimeFormat("fr-CI", { dateStyle: "long", timeStyle: "short" }).format(new Date()))}</p>`;
  renderReceiptShare(parcel);
  // Lien réel (pas un simple bouton) : clic gauche, clic milieu et copie du lien
  // fonctionnent, et la fiche s'ouvre avec l'identifiant du colis.
  const viewLink = document.getElementById("viewSavedParcel");
  if (viewLink) viewLink.href = `colis.html?id=${encodeURIComponent(parcel.id)}`;
  receiptModal.hidden = false;
  document.body.classList.add("modal-open");
}

async function saveParcel(event) {
  event.preventDefault();
  clearPageMessage(message);
  const values = Object.fromEntries(new FormData(form));
  // En mode grille, le prix vient du menu déroulant (champ libre désactivé).
  if (!priceSelect.hidden && !priceSelect.disabled) values.priceFCFA = priceSelect.value;
  delete values.priceTarif;
  const invalidMessage = validate(values);
  if (invalidMessage) {
    showPageMessage(message, invalidMessage);
    return;
  }

  const payment = {
    status: values.paymentStatus,
    paidAmountFCFA: values.paidAmountFCFA,
    mode: values.paymentMode
  };
  delete values.paymentStatus;
  delete values.paidAmountFCFA;
  delete values.paymentMode;
  const controlePaiement = validerPaiement({ priceFCFA: Number(values.priceFCFA), payment });
  if (controlePaiement.error) {
    showPageMessage(message, controlePaiement.error);
    return;
  }

  const resolution = resoudreDestination({
    values,
    agencies,
    currentAgencyId: currentAgency?.id,
    agencyNotRegistered: agencyMode()
  });
  if (!resolution.ok) {
    showPageMessage(message, resolution.error);
    return;
  }

  setButtonLoading(submitButton, true, "Enregistrement…");
  try {
    const { parcel, compteur } = await api("/api/colis", {
      method: "POST",
      body: {
        values,
        agencyNotRegistered: agencyMode(),
        ...(controlePaiement.valeur ? { payment: controlePaiement.valeur } : {})
      }
    });
    form.reset();
    document.getElementById("originCity").value = currentAgency.city || "";
    syncDestinationMode();
    refreshPrix();
    syncPaiement();
    showReceipt(parcel);
    // LOT 10 — compteur renvoyé avec le colis : mise à jour immédiate de la
    // barre latérale, de cette ligne et des autres onglets de l'agence.
    if (compteur) diffuserCompteur(compteur);
    rafraichirQuota();
  } catch (error) {
    showPageMessage(message, errorMessage(error));
    if (error.status === 402) rafraichirQuota();
  } finally {
    setButtonLoading(submitButton, false);
  }
}

async function boot() {
  mountLayout();
  const user = await requireAgency();
  if (!user) return;
  currentAgency = await initAgencyLayout(user, "nouveau");
  // LOT 10 — la ligne « Ce colis sera le … » suit le compteur temps réel.
  surCompteur((resume) => afficherProchainColis(resume));
  if (!currentAgency) return;
  document.getElementById("originCity").value = currentAgency.city || "";

  try {
    const data = await api("/api/agences");
    agencies = data.agencies;
    renderDestinationAgencies();
  } catch (error) {
    showPageMessage(message, errorMessage(error));
  }

  // Grille tarifaire de l'agence : alimente le menu déroulant « prix ».
  try {
    const dataTarifs = await api("/api/tarifs");
    tarifs = dataTarifs.tarifs || [];
  } catch {
    tarifs = [];
  }
  refreshPrix();
  syncPaiement();
  bindClientPrefill();
  rafraichirQuota();
  ["originCity", "destinationCity", "weightKg"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", refreshPrix);
    document.getElementById(id)?.addEventListener("change", refreshPrix);
  });
  priceSelect?.addEventListener("change", rendreRecap);
  priceFree?.addEventListener("input", () => { rendreRecap(); rendreResteDu(); });
  document.getElementById("paymentStatus")?.addEventListener("change", syncPaiement);
  document.getElementById("paidAmountFCFA")?.addEventListener("input", rendreResteDu);

  destinationSelect.addEventListener("change", () => {
    const agency = agencies.find((item) => item.id === destinationSelect.value);
    const cityInput = document.getElementById("destinationCity");
    if (agency && !cityInput.value.trim()) cityInput.value = agency.city || "";
    refreshPrix();
  });

  unregisteredToggle?.addEventListener("change", syncDestinationMode);
  ["declaredAgencyName", "declaredAgencyCity", "declaredAgencyPhone"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", updateInviteLink);
  });
  // La ville de l'agence déclarée et la ville de destination du colis doivent rester cohérentes.
  document.getElementById("declaredAgencyCity")?.addEventListener("change", (event) => {
    const cityInput = document.getElementById("destinationCity");
    if (cityInput && !cityInput.value.trim()) cityInput.value = event.target.value.trim();
  });
  document.getElementById("inviteAgencyWhatsapp")?.addEventListener("click", (event) => {
    if (!invitationAgence()) {
      event.preventDefault();
      showPageMessage(message, "Saisissez le téléphone ivoirien de l'agence (10 chiffres) pour l'inviter par WhatsApp.");
    }
  });

  form.addEventListener("submit", saveParcel);

  document.getElementById("printReceipt")?.addEventListener("click", () => window.print());
  document.getElementById("closeReceipt")?.addEventListener("click", () => {
    receiptModal.hidden = true;
    document.body.classList.remove("modal-open");
  });
}

boot();
