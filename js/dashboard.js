import {
  collection,
  onSnapshot,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase.js";
import { requireAgency } from "./auth.js";
import { agencySidebar, initAgencyLayout, mobileAgencyHeader } from "./layout.js";
import {
  clearPageMessage,
  errorMessage,
  escapeHTML,
  formatDateTime,
  localDateKey,
  showPageMessage,
  statusBadge
} from "./utils.js";

const EMPTY_ILLUSTRATION = `<svg class="empty-art" viewBox="0 0 120 90" aria-hidden="true" focusable="false">
  <rect x="14" y="30" width="92" height="50" rx="6" fill="#e6f3ee"/>
  <path d="M14 42h92" stroke="#126656" stroke-width="2" stroke-opacity=".25"/>
  <rect x="48" y="30" width="24" height="50" fill="#f27622" fill-opacity=".85"/>
  <rect x="34" y="14" width="52" height="22" rx="5" fill="#fff" stroke="#dce7e1" stroke-width="2"/>
  <rect x="42" y="21" width="36" height="4" rx="2" fill="#126656" fill-opacity=".5"/>
  <rect x="42" y="29" width="22" height="3" rx="1.5" fill="#f27622" fill-opacity=".6"/>
</svg>`;

const state = {
  owner: new Map(),
  destination: new Map(),
  parcels: []
};

const dashboardMessage = document.getElementById("pageMessage");
const listTarget = document.getElementById("parcelsList");
const listCount = document.getElementById("listCount");

function mountLayout() {
  document.getElementById("sidebarMount").innerHTML = agencySidebar();
  document.getElementById("topbarMount").innerHTML = mobileAgencyHeader(
    "Tableau de bord",
    '<a class="button button-small button-orange" href="nouveau-colis.html">＋ <span>Nouveau</span></a>'
  );
}

function mergeParcels() {
  const map = new Map([...state.owner, ...state.destination]);
  state.parcels = [...map.values()].sort((a, b) => {
    const dateA = new Date(a.createdAtISO || 0).getTime();
    const dateB = new Date(b.createdAtISO || 0).getTime();
    return dateB - dateA;
  });
}

function filteredParcels() {
  const keyword = document.getElementById("searchParcel").value.trim().toLowerCase();
  const status = document.getElementById("statusFilter").value;
  const city = document.getElementById("cityFilter").value.trim().toLowerCase();
  const date = document.getElementById("dateFilter").value;

  return state.parcels.filter((parcel) => {
    const haystack = [
      parcel.trackingCode,
      parcel.sender?.firstName,
      parcel.sender?.lastName,
      parcel.recipient?.firstName,
      parcel.recipient?.lastName
    ].join(" ").toLowerCase();
    const cities = `${parcel.originCity || ""} ${parcel.destinationCity || ""}`.toLowerCase();
    const createdKey = (parcel.createdAtISO || "").slice(0, 10);
    return (!keyword || haystack.includes(keyword)) &&
      (!status || parcel.status === status) &&
      (!city || cities.includes(city)) &&
      (!date || createdKey === date);
  });
}

function renderStats() {
  const today = localDateKey();
  const registeredToday = state.parcels.filter((parcel) => (parcel.createdAtISO || "").slice(0, 10) === today).length;
  const inTransit = state.parcels.filter((parcel) => ["Expédié", "En transit"].includes(parcel.status)).length;
  const waiting = state.parcels.filter((parcel) => parcel.status === "Arrivé à l'agence de destination").length;
  const pickedUp = state.parcels.filter((parcel) => parcel.status === "Retiré").length;

  document.getElementById("statToday").textContent = registeredToday;
  document.getElementById("statTransit").textContent = inTransit;
  document.getElementById("statWaiting").textContent = waiting;
  document.getElementById("statPickedUp").textContent = pickedUp;
}

function renderList() {
  const parcels = filteredParcels();
  listCount.textContent = `${parcels.length} colis`;
  if (!parcels.length) {
    const noParcelAtAll = state.parcels.length === 0;
    listTarget.innerHTML = noParcelAtAll
      ? `<div class="empty-state empty-state-rich">
      ${EMPTY_ILLUSTRATION}
      <h3>Pas encore de colis</h3>
      <p>Enregistrez votre premier envoi : vous obtiendrez un code de suivi et un QR code à remettre au client.</p>
      <div class="empty-actions"><a class="button button-orange" href="nouveau-colis.html">＋ Enregistrer un colis</a><a class="button button-outline" href="parametres.html">Compléter mon profil</a></div>
    </div>`
      : `<div class="empty-state empty-state-rich">
      ${EMPTY_ILLUSTRATION}
      <h3>Aucun colis ne correspond à votre recherche</h3>
      <p>Essayez un autre code, un autre statut ou une autre ville.</p>
      <div class="empty-actions"><button class="button button-outline" id="resetFiltersInline" type="button">Réinitialiser les filtres</button></div>
    </div>`;
    document.getElementById("resetFiltersInline")?.addEventListener("click", () => {
      document.getElementById("dashboardFilters").reset();
      renderList();
    });
    return;
  }

  listTarget.innerHTML = `<div class="table-wrap"><table class="parcel-table">
    <thead><tr><th>Code</th><th>Itinéraire</th><th>Destinataire</th><th>Statut</th><th>Créé le</th><th></th></tr></thead>
    <tbody>${parcels.map((parcel) => `<tr>
      <td><strong class="tracking-code">${escapeHTML(parcel.trackingCode)}</strong></td>
      <td><span class="route-cell">${escapeHTML(parcel.originCity)} <span>→</span> ${escapeHTML(parcel.destinationCity)}</span></td>
      <td>${escapeHTML(`${parcel.recipient?.firstName || ""} ${parcel.recipient?.lastName || ""}`.trim() || "—")}</td>
      <td>${statusBadge(parcel.status)}</td>
      <td>${escapeHTML(formatDateTime(parcel.createdAtISO))}</td>
      <td><a class="table-link" href="colis.html?id=${encodeURIComponent(parcel.id)}" aria-label="Voir le colis ${escapeHTML(parcel.trackingCode)}">Voir</a></td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderAll() {
  mergeParcels();
  renderStats();
  renderList();
}

function updateMap(target, snapshot) {
  target.clear();
  snapshot.forEach((docSnapshot) => target.set(docSnapshot.id, { id: docSnapshot.id, ...docSnapshot.data() }));
  clearPageMessage(dashboardMessage);
  renderAll();
}

async function boot() {
  mountLayout();
  const user = await requireAgency();
  if (!user) return;
  const agency = await initAgencyLayout(user, "dashboard");
  if (!agency) return;

  ["searchParcel", "statusFilter", "cityFilter", "dateFilter"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", renderList);
    document.getElementById(id)?.addEventListener("change", renderList);
  });
  document.getElementById("clearFilters")?.addEventListener("click", () => {
    document.getElementById("dashboardFilters").reset();
    renderList();
  });

  const ownerQuery = query(collection(db, "colis"), where("ownerId", "==", user.uid));
  const destinationQuery = query(collection(db, "colis"), where("destinationAgencyId", "==", user.uid));

  onSnapshot(ownerQuery, (snapshot) => updateMap(state.owner, snapshot), (error) => {
    showPageMessage(dashboardMessage, errorMessage(error));
  });
  onSnapshot(destinationQuery, (snapshot) => updateMap(state.destination, snapshot), (error) => {
    showPageMessage(dashboardMessage, errorMessage(error));
  });
}

boot();
