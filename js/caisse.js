import { api } from "./api.js";
import { requireAgency } from "./auth.js";
import { agencySidebar, initAgencyLayout, mobileAgencyHeader } from "./layout.js";
import { MODES_ENCAISSEMENT } from "./metier-tarifs.js";
import {
  clearPageMessage,
  errorMessage,
  escapeHTML,
  formatDateTime,
  formatFCFA,
  localDateKey,
  setButtonLoading,
  showPageMessage,
  showToast,
  statusBadge
} from "./utils.js";

const message = document.getElementById("pageMessage");
const dateInput = document.getElementById("caisseDate");
const caisseList = document.getElementById("caisseList");
const caisseCount = document.getElementById("caisseCount");
const restesList = document.getElementById("restesList");
const restesCount = document.getElementById("restesCount");
const clotureContent = document.getElementById("clotureContent");
const clotureForm = document.getElementById("clotureForm");

let state = { date: localDateKey(), encaissements: [], restes: [], totaux: { especes: 0, mobile_money: 0, total: 0 }, cloture: null };
let exportPret = false;

function mountLayout() {
  document.getElementById("sidebarMount").innerHTML = agencySidebar();
  document.getElementById("topbarMount").innerHTML = mobileAgencyHeader("Caisse du jour");
}

function libelleMode(mode) {
  return MODES_ENCAISSEMENT.find((item) => item.id === mode)?.label || mode;
}

function renderTotaux() {
  document.getElementById("totalJour").textContent = formatFCFA(state.totaux.total || 0);
  document.getElementById("totalEspeces").textContent = formatFCFA(state.totaux.especes || 0);
  document.getElementById("totalMobile").textContent = formatFCFA(state.totaux.mobile_money || 0);
  document.getElementById("totalRestes").textContent = String(state.restes.length);
}

function renderCloture() {
  if (state.cloture) {
    clotureForm.hidden = true;
    const c = state.cloture;
    clotureContent.innerHTML = `
      <div class="cloture-done">
        <span class="status-badge status-retire">Clôturée</span>
        <p><strong>${escapeHTML(formatFCFA(c.countedTotalFCFA))}</strong> comptés par ${escapeHTML(c.agentName || "l'agent")} le ${escapeHTML(formatDateTime(c.createdAtISO))}</p>
        <p class="muted-note">Total calculé par le système : ${escapeHTML(formatFCFA(c.computedTotalFCFA))} · Écart : ${escapeHTML(formatFCFA(c.ecartFCFA))}</p>
      </div>`;
    return;
  }
  clotureContent.innerHTML = '<p class="muted-note">La caisse de cette journée est ouverte : comptez les fonds puis clôturez-la pour valider le total du jour.</p>';
  clotureForm.hidden = false;
}

function renderEncaissements() {
  caisseCount.textContent = `${state.encaissements.length} encaissement${state.encaissements.length > 1 ? "s" : ""}`;
  if (!state.encaissements.length) {
    caisseList.innerHTML = '<div class="empty-inline">Aucun encaissement sur cette journée.</div>';
    return;
  }
  caisseList.innerHTML = `<div class="table-wrap"><table class="parcel-table caisse-table">
    <thead><tr><th>Heure</th><th>Code</th><th>Expéditeur</th><th>Destinataire</th><th>Prix</th><th>Payé</th><th>Reste</th><th>Mode</th><th>Agent</th></tr></thead>
    <tbody>${state.encaissements.map((item) => `<tr>
      <td>${escapeHTML(formatDateTime(item.createdISO))}</td>
      <td><a class="table-link" href="colis.html?id=${encodeURIComponent(item.parcelId)}">${escapeHTML(item.trackingCode)}</a></td>
      <td>${escapeHTML(item.senderName || "—")}</td>
      <td>${escapeHTML(item.recipientName || "—")}</td>
      <td>${escapeHTML(formatFCFA(item.priceFCFA))}</td>
      <td>${escapeHTML(formatFCFA(item.paidAmountFCFA))}</td>
      <td>${escapeHTML(formatFCFA(item.resteFCFA))}</td>
      <td>${escapeHTML(libelleMode(item.mode))}</td>
      <td>${escapeHTML(item.agentName || "—")}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderRestes() {
  restesCount.textContent = `${state.restes.length} colis`;
  if (!state.restes.length) {
    restesList.innerHTML = '<div class="empty-inline">Aucun reste à encaisser : tout est réglé.</div>';
    return;
  }
  restesList.innerHTML = `<div class="table-wrap"><table class="parcel-table caisse-table">
    <thead><tr><th>Code</th><th>Itinéraire</th><th>Destinataire</th><th>Prix</th><th>Payé</th><th>Reste</th><th>Statut</th><th></th></tr></thead>
    <tbody>${state.restes.map((item) => `<tr>
      <td><strong class="tracking-code">${escapeHTML(item.trackingCode)}</strong></td>
      <td><span class="route-cell">${escapeHTML(item.destinationAgencyName || "—")}</span></td>
      <td>${escapeHTML(item.recipientName || "—")}</td>
      <td>${escapeHTML(formatFCFA(item.priceFCFA))}</td>
      <td>${escapeHTML(formatFCFA(item.paidAmountFCFA))}</td>
      <td><strong>${escapeHTML(formatFCFA(item.resteFCFA))}</strong></td>
      <td>${statusBadge(item.status)}</td>
      <td><a class="table-link" href="colis.html?id=${encodeURIComponent(item.id)}">Encaisser</a></td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderAll() {
  renderTotaux();
  renderCloture();
  renderEncaissements();
  renderRestes();
}

async function charger() {
  const date = dateInput.value || localDateKey();
  try {
    const data = await api(`/api/caisse?date=${encodeURIComponent(date)}&_=${Date.now()}`);
    state = data;
    exportPret = true;
    clearPageMessage(message);
    renderAll();
  } catch (error) {
    showPageMessage(message, errorMessage(error));
  }
}

/* --------------------------------- CSV ------------------------------------- */

/** Export CSV du jour : date, code, expéditeur, destinataire, prix, payé, reste, mode, agent. */
function exporterCsv() {
  if (!exportPret || !state.encaissements.length) {
    showPageMessage(message, "Aucun encaissement à exporter sur cette journée.", "info");
    return;
  }
  const entetes = ["date", "code", "expéditeur", "destinataire", "prix", "payé", "reste", "mode", "agent"];
  const echapper = (valeur) => `"${String(valeur ?? "").replaceAll('"', '""')}"`;
  const lignes = state.encaissements.map((item) =>
    [
      state.date,
      item.trackingCode,
      item.senderName,
      item.recipientName,
      item.priceFCFA,
      item.paidAmountFCFA,
      item.resteFCFA,
      libelleMode(item.mode),
      item.agentName
    ].map(echapper).join(";")
  );
  const contenu = "\uFEFF" + [entetes.join(";"), ...lignes].join("\r\n");
  const lien = document.createElement("a");
  lien.href = URL.createObjectURL(new Blob([contenu], { type: "text/csv;charset=utf-8" }));
  lien.download = `caisse-${state.date}.csv`;
  document.body.appendChild(lien);
  lien.click();
  lien.remove();
  URL.revokeObjectURL(lien.href);
}

/* ------------------------------- clôture ----------------------------------- */

async function cloturerCaisse(event) {
  event.preventDefault();
  clearPageMessage(message);
  const brut = document.getElementById("clotureTotal").value;
  const total = Math.round(Number(brut));
  if (!Number.isFinite(total) || total < 0 || brut === "") {
    showPageMessage(message, "Indiquez le total compté en FCFA (nombre positif).");
    return;
  }
  const calcule = state.totaux.total || 0;
  if (total !== calcule && !window.confirm(
    `Le total saisi (${formatFCFA(total)}) ne correspond pas au total calculé (${formatFCFA(calcule)}) de ${formatFCFA(Math.abs(total - calcule))}. Clôturer quand même ?`
  )) {
    return;
  }
  const button = document.getElementById("clotureButton");
  setButtonLoading(button, true, "Clôture…");
  try {
    await api("/api/caisse/cloture", {
      method: "POST",
      body: { date: state.date, countedTotalFCFA: total }
    });
    showToast("Caisse du jour clôturée.");
    await charger();
  } catch (error) {
    showPageMessage(message, errorMessage(error));
  } finally {
    setButtonLoading(button, false);
  }
}

async function boot() {
  mountLayout();
  const user = await requireAgency();
  if (!user) return;
  const agency = await initAgencyLayout(user, "caisse");
  if (!agency) return;

  dateInput.value = state.date;
  dateInput.addEventListener("change", charger);
  document.getElementById("refreshCaisse")?.addEventListener("click", charger);
  document.getElementById("exportCsv")?.addEventListener("click", exporterCsv);
  clotureForm.addEventListener("submit", cloturerCaisse);

  renderAll();
  await charger();
  window.setInterval(() => {
    if (document.visibilityState === "visible") charger();
  }, 20000);
}

boot();
