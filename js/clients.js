/*
 * Carnet de clients (LOT 3) : liste, recherche par téléphone/nom, ajout,
 * modification et historique des colis d'un client. Données privées de
 * l'agence — le serveur applique le cloisonnement (lib/app.js).
 */
import { api } from "./api.js";
import { requireAgency } from "./auth.js";
import { agencySidebar, initAgencyLayout, mobileAgencyHeader } from "./layout.js";
import { nomClient, rechercherClients, validerClient } from "./metier-clients.js";
import {
  clearPageMessage,
  errorMessage,
  escapeHTML,
  formatDateTime,
  formatFCFA,
  setButtonLoading,
  showPageMessage,
  showToast,
  statusBadge
} from "./utils.js";

const message = document.getElementById("pageMessage");
const formMessage = document.getElementById("clientFormMessage");
const clientsList = document.getElementById("clientsList");
const clientsCount = document.getElementById("clientsCount");
const formSection = document.getElementById("clientFormSection");
const clientForm = document.getElementById("clientForm");
const formTitle = document.getElementById("clientFormTitle");
const detailSection = document.getElementById("clientDetail");
const detailContent = document.getElementById("clientDetailContent");

let tousLesClients = [];
let enEdition = null; // client en cours de modification (null = création)

function mountLayout() {
  document.getElementById("sidebarMount").innerHTML = agencySidebar();
  document.getElementById("topbarMount").innerHTML = mobileAgencyHeader(
    "Carnet de clients",
    '<button class="button button-small button-orange" id="newClientTop" type="button">＋ <span>Nouveau</span></button>'
  );
}

function libelleRole(kind) {
  return kind === "expediteur" ? "Expéditeur" : "Destinataire";
}

function clientsFiltres() {
  return rechercherClients({
    clients: tousLesClients,
    recherche: document.getElementById("searchClient").value,
    kind: document.getElementById("kindFilter").value
  });
}

function renderList() {
  const clients = clientsFiltres();
  clientsCount.textContent = `${clients.length} client${clients.length > 1 ? "s" : ""}`;
  if (!clients.length) {
    clientsList.innerHTML = tousLesClients.length
      ? `<div class="empty-state"><h3>Aucun client ne correspond</h3><p>Essayez un autre téléphone ou un autre nom.</p></div>`
      : `<div class="empty-state"><h3>Carnet vide</h3><p>Ajoutez un client, ou enregistrez un colis : l'expéditeur et le destinataire sont mémorisés automatiquement.</p></div>`;
    return;
  }
  clientsList.innerHTML = `<div class="table-wrap"><table class="parcel-table">
    <thead><tr><th>Client</th><th>Rôle</th><th>Téléphone</th><th>Ville</th><th></th></tr></thead>
    <tbody>${clients.map((client) => `<tr>
      <td><strong>${escapeHTML(nomClient(client))}</strong>${client.notes ? `<br><small class="muted-note">${escapeHTML(client.notes)}</small>` : ""}</td>
      <td><span class="client-kind client-kind-${escapeHTML(client.kind)}">${libelleRole(client.kind)}</span></td>
      <td class="tracking-code">${escapeHTML(client.phone)}</td>
      <td>${escapeHTML(client.city || "—")}</td>
      <td class="client-actions">
        <button class="table-link" type="button" data-action="voir" data-id="${escapeHTML(client.id)}">Voir</button>
        <button class="table-link" type="button" data-action="modifier" data-id="${escapeHTML(client.id)}">Modifier</button>
      </td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

async function charger() {
  try {
    const { clients } = await api("/api/clients");
    tousLesClients = clients;
    clearPageMessage(message);
    renderList();
  } catch (error) {
    showPageMessage(message, errorMessage(error));
  }
}

/* ------------------------------- formulaire ------------------------------- */

function ouvrirFormulaire(client = null) {
  enEdition = client;
  formTitle.textContent = client ? `Modifier ${nomClient(client)}` : "Ajouter un client";
  clientForm.reset();
  if (client) {
    clientForm.elements.kind.value = client.kind;
    clientForm.elements.phone.value = client.phone;
    clientForm.elements.firstName.value = client.firstName;
    clientForm.elements.lastName.value = client.lastName;
    clientForm.elements.cni.value = client.cni || "";
    clientForm.elements.city.value = client.city || "";
    clientForm.elements.notes.value = client.notes || "";
  }
  syncCniField();
  formSection.hidden = false;
  clearPageMessage(formMessage);
  formSection.scrollIntoView({ behavior: "smooth", block: "center" });
  document.getElementById("clientPhone").focus();
}

function fermerFormulaire() {
  formSection.hidden = true;
  enEdition = null;
  clearPageMessage(formMessage);
}

function syncCniField() {
  const kind = clientForm.elements.kind.value;
  document.getElementById("clientCniField").hidden = kind !== "expediteur";
}

async function enregistrer(event) {
  event.preventDefault();
  clearPageMessage(formMessage);
  const values = Object.fromEntries(new FormData(clientForm));
  const controle = validerClient(values);
  if (controle.error) {
    showPageMessage(formMessage, controle.error);
    return;
  }
  const button = document.getElementById("saveClientButton");
  setButtonLoading(button, true, "Enregistrement…");
  try {
    if (enEdition) {
      await api(`/api/clients/${encodeURIComponent(enEdition.id)}`, { method: "PATCH", body: controle.valeur });
      showToast("Fiche client mise à jour.");
    } else {
      const res = await api("/api/clients", { method: "POST", body: controle.valeur });
      showToast(res.cree ? "Client ajouté au carnet." : "Client déjà connu : sa fiche a été complétée.");
    }
    fermerFormulaire();
    await charger();
  } catch (error) {
    showPageMessage(formMessage, errorMessage(error));
  } finally {
    setButtonLoading(button, false);
  }
}

/* ------------------------------ fiche + historique ------------------------- */

async function voirClient(id) {
  try {
    const { client, historique } = await api(`/api/clients/${encodeURIComponent(id)}`);
    detailContent.innerHTML = `
      <dl class="person-data">
        <div><dt>Client</dt><dd>${escapeHTML(nomClient(client))}</dd></div>
        <div><dt>Rôle</dt><dd>${libelleRole(client.kind)}</dd></div>
        <div><dt>Téléphone</dt><dd>${escapeHTML(client.phone)}</dd></div>
        <div><dt>Ville</dt><dd>${escapeHTML(client.city || "—")}</dd></div>
        ${client.cni ? `<div><dt>N° CNI</dt><dd>${escapeHTML(client.cni)}</dd></div>` : ""}
        ${client.notes ? `<div><dt>Note</dt><dd>${escapeHTML(client.notes)}</dd></div>` : ""}
        <div><dt>Au carnet depuis</dt><dd>${escapeHTML(formatDateTime(client.createdAtISO))}</dd></div>
      </dl>
      <h3 class="form-subheading">Historique des colis (${historique.length})</h3>
      ${historique.length ? `<div class="table-wrap"><table class="parcel-table">
        <thead><tr><th>Code</th><th>Itinéraire</th><th>Rôle</th><th>Statut</th><th>Prix</th><th>Enregistré le</th><th></th></tr></thead>
        <tbody>${historique.map((colis) => `<tr>
          <td><strong class="tracking-code">${escapeHTML(colis.trackingCode)}</strong></td>
          <td><span class="route-cell">${escapeHTML(colis.originCity)} <span>→</span> ${escapeHTML(colis.destinationCity)}</span></td>
          <td>${colis.roles.map(libelleRole).join(" / ")}</td>
          <td>${statusBadge(colis.status)}</td>
          <td>${escapeHTML(formatFCFA(colis.priceFCFA))}</td>
          <td>${escapeHTML(formatDateTime(colis.createdAtISO))}</td>
          <td><a class="table-link" href="colis.html?id=${encodeURIComponent(colis.id)}">Voir</a></td>
        </tr>`).join("")}</tbody>
      </table></div>` : '<p class="muted-note">Aucun colis enregistré pour ce client avec ce téléphone.</p>'}`;
    detailSection.hidden = false;
    detailSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showPageMessage(message, errorMessage(error));
  }
}

function bindEvents() {
  ["searchClient", "kindFilter"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", renderList);
    document.getElementById(id)?.addEventListener("change", renderList);
  });
  document.getElementById("clearClientFilters")?.addEventListener("click", () => {
    document.getElementById("clientsFilters").reset();
    renderList();
  });
  document.getElementById("newClientButton")?.addEventListener("click", () => ouvrirFormulaire());
  document.getElementById("newClientTop")?.addEventListener("click", () => ouvrirFormulaire());
  document.getElementById("cancelClientButton")?.addEventListener("click", fermerFormulaire);
  document.getElementById("closeClientDetail")?.addEventListener("click", () => { detailSection.hidden = true; });
  clientForm.elements.kind.addEventListener("change", syncCniField);
  clientForm.addEventListener("submit", enregistrer);
  clientsList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const client = tousLesClients.find((item) => item.id === button.dataset.id);
    if (!client) return;
    if (button.dataset.action === "voir") voirClient(client.id);
    if (button.dataset.action === "modifier") ouvrirFormulaire(client);
  });
}

async function boot() {
  mountLayout();
  const user = await requireAgency();
  if (!user) return;
  const agency = await initAgencyLayout(user, "clients");
  if (!agency) return;
  bindEvents();
  await charger();
}

boot();
