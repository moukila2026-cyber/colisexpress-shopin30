import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase.js";
import { requireAgency } from "./auth.js";
import { agencySidebar, initAgencyLayout, mobileAgencyHeader } from "./layout.js";
import {
  construireColis,
  resoudreDestination,
  validerColis
} from "./metier-colis.js";
import {
  clearPageMessage,
  errorMessage,
  escapeHTML,
  formatFCFA,
  generateTrackingCode,
  isValidIvorianPhone,
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
let currentAgency = null;
let agencies = [];

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

async function createUniqueCode() {
  for (let attempts = 0; attempts < 8; attempts += 1) {
    const code = generateTrackingCode();
    const trackingSnapshot = await getDoc(doc(db, "suivis", code));
    if (!trackingSnapshot.exists()) return code;
  }
  throw new Error("Impossible de générer un code de suivi unique. Réessayez.");
}

function validate(values) {
  return validerColis({ values, agencyNotRegistered: agencyMode() });
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
    links.push(`<a class="button button-whatsapp" target="_blank" rel="noopener noreferrer" href="${escapeHTML(whatsappShareLink(parcel.sender.phone, text))}">Envoyer le code à l'expéditeur</a>`);
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
    ${pendingNotice}
    <p class="receipt-date">Enregistré le ${escapeHTML(new Intl.DateTimeFormat("fr-CI", { dateStyle: "long", timeStyle: "short" }).format(new Date()))}</p>`;
  renderReceiptShare(parcel);
  receiptModal.dataset.parcelId = parcel.id;
  receiptModal.hidden = false;
  document.body.classList.add("modal-open");
}

async function saveParcel(event) {
  event.preventDefault();
  clearPageMessage(message);
  const values = Object.fromEntries(new FormData(form));
  const invalidMessage = validate(values);
  if (invalidMessage) {
    showPageMessage(message, invalidMessage);
    return;
  }
  const resolution = resoudreDestination({
    values,
    agencies,
    currentAgencyId: currentAgency.id,
    agencyNotRegistered: agencyMode()
  });
  if (!resolution.ok) {
    showPageMessage(message, resolution.error);
    return;
  }

  setButtonLoading(submitButton, true, "Enregistrement…");
  try {
    const trackingCode = await createUniqueCode();
    const parcelRef = doc(collection(db, "colis"));
    const now = new Date().toISOString();
    const built = construireColis({
      values,
      currentAgency,
      destination: resolution.destination,
      parcelId: parcelRef.id,
      trackingCode,
      nowISO: now
    });
    const parcel = {
      ...built.parcel,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };
    const batch = writeBatch(db);
    // create() évite tout écrasement accidentel en cas de collision de code.
    batch.create(parcelRef, parcel);
    batch.create(doc(db, "suivis", trackingCode), built.publicTracking);
    await batch.commit();
    form.reset();
    document.getElementById("originCity").value = currentAgency.city || "";
    syncDestinationMode();
    showReceipt(parcel);
  } catch (error) {
    console.error(error);
    showPageMessage(message, errorMessage(error));
  } finally {
    setButtonLoading(submitButton, false);
  }
}

async function boot() {
  mountLayout();
  const user = await requireAgency();
  if (!user) return;
  currentAgency = await initAgencyLayout(user, "nouveau");
  if (!currentAgency) return;
  document.getElementById("originCity").value = currentAgency.city || "";

  onSnapshot(collection(db, "agences"), (snapshot) => {
    agencies = snapshot.docs.map((agencyDoc) => ({ id: agencyDoc.id, ...agencyDoc.data() }));
    renderDestinationAgencies();
  }, (error) => showPageMessage(message, errorMessage(error)));

  destinationSelect.addEventListener("change", () => {
    const agency = agencies.find((item) => item.id === destinationSelect.value);
    const cityInput = document.getElementById("destinationCity");
    if (agency && !cityInput.value.trim()) cityInput.value = agency.city || "";
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
  document.getElementById("viewSavedParcel")?.addEventListener("click", () => {
    const id = receiptModal.dataset.parcelId;
    window.location.href = `colis.html?id=${encodeURIComponent(id)}`;
  });
}

boot();
