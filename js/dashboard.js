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
    listTarget.innerHTML = `<div class="empty-state">
      <span class="empty-icon" aria-hidden="true">▣</span>
      <h3>Aucun colis trouvé</h3>
      <p>Modifiez les filtres ou enregistrez votre premier colis.</p>
      <a class="button button-primary" href="nouveau-colis.html">Enregistrer un colis</a>
    </div>`;
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
