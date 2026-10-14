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
  clearPageMessage,
  errorMessage,
  escapeHTML,
  formatFCFA,
  generateTrackingCode,
  isValidCni,
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
const submitButton = document.getElementById("saveParcelButton");
const receiptModal = document.getElementById("receiptModal");
const receiptContent = document.getElementById("receiptContent");
let currentAgency = null;
let agencies = [];

function mountLayout() {
  document.getElementById("sidebarMount").innerHTML = agencySidebar();
  document.getElementById("topbarMount").innerHTML = mobileAgencyHeader("Nouveau colis");
}

function renderDestinationAgencies() {
  const previous = destinationSelect.value;
  const options = agencies
    .filter((agency) => agency.id !== currentAgency?.id)
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", "fr"))
    .map((agency) => `<option value="${escapeHTML(agency.id)}">${escapeHTML(agency.name)} — ${escapeHTML(agency.city)}</option>`)
    .join("");
  destinationSelect.innerHTML = `<option value="">Choisir une agence de destination</option>${options}`;
  if (agencies.some((agency) => agency.id === previous)) destinationSelect.value = previous;
  destinationSelect.disabled = !options;
  document.getElementById("noDestinationAgency").hidden = Boolean(options);
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
  if (!values.senderFirstName.trim() || !values.senderLastName.trim()) return "Renseignez le nom complet de l'expéditeur.";
  if (!isValidIvorianPhone(values.senderPhone)) return "Saisissez un téléphone ivoirien valide pour l'expéditeur (10 chiffres).";
  if (!isValidCni(values.senderCni)) return "Le numéro CNI de l'expéditeur doit contenir 8 à 25 caractères et au moins un chiffre.";
  if (!values.recipientFirstName.trim() || !values.recipientLastName.trim()) return "Renseignez le nom complet du destinataire.";
  if (!isValidIvorianPhone(values.recipientPhone)) return "Saisissez un téléphone ivoirien valide pour le destinataire (10 chiffres).";
  if (!values.packageNature.trim()) return "Indiquez la nature du colis.";
  if (!Number.isFinite(Number(values.weightKg)) || Number(values.weightKg) <= 0) return "Le poids doit être supérieur à 0 kg.";
  if (!Number.isFinite(Number(values.priceFCFA)) || Number(values.priceFCFA) < 0) return "Le prix doit être un montant valide.";
  if (!values.originCity.trim() || !values.destinationCity.trim()) return "Indiquez les villes de départ et de destination.";
  if (!values.destinationAgencyId) return "Sélectionnez une agence de destination.";
  return null;
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
  share.innerHTML = links.join("");
}

function showReceipt(parcel) {
  receiptContent.innerHTML = `
    <div class="receipt-brand"><span class="brand-mark">CE</span><strong>COLIS <em>EXPRESS</em></strong></div>
    <p class="receipt-title">Reçu d'enregistrement</p>
    <div class="receipt-code">${escapeHTML(parcel.trackingCode)}</div>
    <p class="receipt-help">Conservez ce code pour suivre votre colis sur COLIS EXPRESS, ou scannez le QR code ci-dessous.</p>
    <div class="receipt-qr" aria-label="QR code de suivi">${qrCodeSvg(publicTrackingUrl(parcel.trackingCode))}</div>
    <div class="receipt-grid">
      <div><small>Expéditeur</small><strong>${escapeHTML(`${parcel.sender.firstName} ${parcel.sender.lastName}`)}</strong><span>${escapeHTML(parcel.sender.phone)}</span></div>
      <div><small>Destinataire</small><strong>${escapeHTML(`${parcel.recipient.firstName} ${parcel.recipient.lastName}`)}</strong><span>${escapeHTML(parcel.recipient.phone)}</span></div>
      <div><small>Itinéraire</small><strong>${escapeHTML(parcel.originCity)} → ${escapeHTML(parcel.destinationCity)}</strong><span>${escapeHTML(parcel.destinationAgencyName)}</span></div>
      <div><small>Colis</small><strong>${escapeHTML(parcel.packageNature)}</strong><span>${escapeHTML(String(parcel.weightKg))} kg · ${escapeHTML(formatFCFA(parcel.priceFCFA))}</span></div>
    </div>
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
  const destinationAgency = agencies.find((agency) => agency.id === values.destinationAgencyId);
  if (!destinationAgency) {
    showPageMessage(message, "L'agence de destination choisie n'est plus disponible. Actualisez la page.");
    return;
  }

  setButtonLoading(submitButton, true, "Enregistrement…");
  try {
    const trackingCode = await createUniqueCode();
    const parcelRef = doc(collection(db, "colis"));
    const now = new Date().toISOString();
    const history = [{
      status: "Enregistré",
      date: now,
      agencyName: currentAgency.name,
      city: values.originCity.trim()
    }];
    const parcel = {
      id: parcelRef.id,
      trackingCode,
      ownerId: currentAgency.id,
      ownerAgencyName: currentAgency.name,
      ownerAgencyCity: currentAgency.city,
      destinationAgencyId: destinationAgency.id,
      destinationAgencyName: destinationAgency.name,
      destinationAgencyCity: destinationAgency.city,
      sender: {
        firstName: values.senderFirstName.trim(),
        lastName: values.senderLastName.trim(),
        phone: normalizeIvorianPhone(values.senderPhone),
        cni: values.senderCni.trim().toUpperCase()
      },
      recipient: {
        firstName: values.recipientFirstName.trim(),
        lastName: values.recipientLastName.trim(),
        phone: normalizeIvorianPhone(values.recipientPhone)
      },
      packageNature: values.packageNature.trim(),
      weightKg: Number(values.weightKg),
      priceFCFA: Math.round(Number(values.priceFCFA)),
      originCity: values.originCity.trim(),
      destinationCity: values.destinationCity.trim(),
      status: "Enregistré",
      history,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdAtISO: now
    };
    const publicTracking = {
      code: trackingCode,
      colisId: parcelRef.id,
      status: parcel.status,
      history,
      originCity: parcel.originCity,
      destinationCity: parcel.destinationCity,
      lastUpdatedAtISO: now
    };
    const batch = writeBatch(db);
    // create() évite tout écrasement accidentel en cas de collision de code.
    batch.create(parcelRef, parcel);
    batch.create(doc(db, "suivis", trackingCode), publicTracking);
    await batch.commit();
    form.reset();
    document.getElementById("originCity").value = currentAgency.city || "";
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
