/*
 * Notifications (LOT 5) — journal de l'agence. Chaque événement (incident
 * ouvert / escalade 24 h, bordereau arrivé / écart, colis en souffrance,
 * retour décidé / reçu, colis qui dorment) est notifié aux DEUX agences
 * concernées, sans aucune donnée personnelle. Mode simulation par défaut :
 * rien ne sort de l'application tant qu'aucun transport réel (WhatsApp, SMS,
 * e-mail) n'est branché et configuré côté serveur (lib/notifications.js).
 * Lecture, filtres et « marquer comme lu » ; aucune suppression.
 */
import { api } from "./api.js";
import { requireAgency } from "./auth.js";
import { afficherBadgeNotifications, agencySidebar, initAgencyLayout, mobileAgencyHeader } from "./layout.js";
import {
  FAMILLES_NOTIFICATION,
  filtrerNotifications,
  libelleCanalNotification,
  libelleStatutNotification,
  libelleTypeNotification,
  resumeNotifications
} from "./metier-notifications.js";
import {
  clearPageMessage,
  errorMessage,
  escapeHTML,
  formatDateTime,
  setButtonLoading,
  showPageMessage,
  showToast
} from "./utils.js";

const RAFRAICHISSEMENT_MS = 30_000;
/** Seuls les liens internes construits par le serveur sont suivis. */
const LIEN_INTERNE = /^(colis|bordereaux)\.html\?id=[A-Za-z0-9%._-]+$/;

const message = document.getElementById("pageMessage");
const modeTarget = document.getElementById("notifMode");
const listTarget = document.getElementById("notifList");
const countTarget = document.getElementById("notifCount");
const familleSelect = document.getElementById("notifFamille");
const nonLuesCheckbox = document.getElementById("notifNonLuesSeulement");
const toutLireButton = document.getElementById("toutLireButton");

let notifications = [];
let nonLues = 0;
let chargementEnCours = false;

function mountLayout() {
  document.getElementById("sidebarMount").innerHTML = agencySidebar();
  document.getElementById("topbarMount").innerHTML = mobileAgencyHeader(
    "Notifications",
    '<button class="button button-small button-outline" type="button" data-tout-lire>✓ <span>Tout lu</span></button>'
  );
}

function remplirFamilles() {
  familleSelect.insertAdjacentHTML(
    "beforeend",
    FAMILLES_NOTIFICATION.map((famille) => `<option value="${escapeHTML(famille.id)}">${escapeHTML(famille.label)}</option>`).join("")
  );
}

function renderMode(configuration) {
  if (!configuration) return;
  modeTarget.classList.toggle("notif-mode-reel", configuration.simulation === false);
  modeTarget.innerHTML = configuration.simulation
    ? `<strong>Mode simulation</strong> — aucun message n'est envoyé hors de l'application : chaque notification est journalisée ici, pour les deux agences concernées, sans aucune donnée personnelle (ni nom, ni téléphone, ni CNI). Le branchement WhatsApp, SMS ou e-mail se fera côté serveur, sans changer cet écran.`
    : `<strong>Envoi réel actif</strong> (${escapeHTML(libelleCanalNotification(configuration.canal))}) — les notifications partent vers les coordonnées professionnelles de votre agence et restent journalisées ici.`;
}

function renderCompteurs() {
  const resume = resumeNotifications(notifications);
  document.getElementById("notifNonLues").textContent = String(nonLues);
  document.getElementById("notifIncidents").textContent = String(resume.parFamille.incidents);
  document.getElementById("notifBordereaux").textContent = String(resume.parFamille.bordereaux);
  document.getElementById("notifDorment").textContent = String(resume.parFamille.dorment);
  afficherBadgeNotifications(nonLues);
}

function libelleLien(lien) {
  return lien.startsWith("bordereaux.html") ? "Ouvrir le bordereau" : "Ouvrir le colis";
}

function renderListe() {
  const visibles = filtrerNotifications({
    notifications,
    famille: familleSelect.value,
    nonLuesSeulement: nonLuesCheckbox.checked
  });
  countTarget.textContent = `${visibles.length} notification${visibles.length > 1 ? "s" : ""} · ${nonLues} non lue${nonLues > 1 ? "s" : ""}`;
  toutLireButton.disabled = nonLues === 0;
  if (!visibles.length) {
    listTarget.innerHTML = notifications.length
      ? '<div class="empty-state"><h3>Aucune notification pour ce filtre</h3><p>Modifiez les filtres pour revoir tout le journal.</p></div>'
      : '<div class="empty-state"><div class="empty-icon" aria-hidden="true">✉</div><h3>Aucune notification pour l\'instant</h3><p>Incidents, arrivées de bordereaux, écarts, colis en souffrance, retours et colis qui dorment apparaîtront ici dès qu\'ils concernent votre agence.</p></div>';
    return;
  }
  listTarget.innerHTML = `<ul class="notif-list">${visibles.map((item) => {
    const lien = LIEN_INTERNE.test(item.lien || "") ? item.lien : "";
    return `<li class="notif-item${item.lu ? "" : " notif-unread"}">
      <div class="notif-head">
        <span class="notif-type notif-famille-${escapeHTML(item.famille || "autre")}">${escapeHTML(libelleTypeNotification(item.type))}</span>
        ${item.lu ? "" : '<span class="notif-dot" aria-label="Non lue"></span>'}
        <small>${escapeHTML(formatDateTime(item.createdAtISO))}</small>
      </div>
      <strong class="notif-title">${escapeHTML(item.titre)}</strong>
      <p class="notif-message">${escapeHTML(item.message)}</p>
      <div class="notif-meta">
        <span class="notif-canal">${escapeHTML(libelleCanalNotification(item.canal))} · ${escapeHTML(libelleStatutNotification(item.statut))}${item.statut === "echec" && item.erreur ? ` — ${escapeHTML(item.erreur)}` : ""}</span>
        <span class="notif-actions">
          ${lien ? `<a class="table-link" href="${escapeHTML(lien)}" data-ouvrir="${escapeHTML(item.id)}">${libelleLien(lien)}</a>` : ""}
          ${item.lu ? "" : `<button class="button button-small button-outline" type="button" data-lire="${escapeHTML(item.id)}">Marquer comme lue</button>`}
        </span>
      </div>
    </li>`;
  }).join("")}</ul>`;
}

async function charger({ silencieux = false } = {}) {
  if (chargementEnCours) return;
  chargementEnCours = true;
  try {
    const data = await api(`/api/notifications?_=${Date.now()}`);
    notifications = data.notifications || [];
    nonLues = Number(data.nonLues) || 0;
    renderMode(data.configuration);
    renderCompteurs();
    renderListe();
    clearPageMessage(message);
  } catch (error) {
    if (!silencieux) {
      showPageMessage(message, errorMessage(error));
      listTarget.innerHTML = '<div class="empty-inline">Le journal est momentanément indisponible. Réessayez.</div>';
    }
  } finally {
    chargementEnCours = false;
  }
}

async function marquerLues(corps) {
  const data = await api("/api/notifications/lecture", { method: "POST", body: corps });
  nonLues = Number(data.nonLues) || 0;
  const ids = new Set(corps.ids || []);
  notifications = notifications.map((item) => (corps.toutes || ids.has(item.id) ? { ...item, lu: true } : item));
  renderCompteurs();
  renderListe();
}

async function toutLire(button) {
  setButtonLoading(button, true, "Enregistrement…");
  try {
    await marquerLues({ toutes: true });
    showToast("Toutes les notifications sont marquées comme lues.");
  } catch (error) {
    showToast(errorMessage(error), "error");
  } finally {
    setButtonLoading(button, false);
    toutLireButton.disabled = nonLues === 0;
  }
}

function brancherEvenements() {
  familleSelect.addEventListener("change", renderListe);
  nonLuesCheckbox.addEventListener("change", renderListe);
  document.getElementById("refreshNotifications").addEventListener("click", () => charger());
  toutLireButton.addEventListener("click", () => toutLire(toutLireButton));
  document.querySelectorAll("[data-tout-lire]").forEach((button) => {
    button.addEventListener("click", () => toutLire(button));
  });

  listTarget.addEventListener("click", async (event) => {
    const lire = event.target.closest("[data-lire]");
    if (lire) {
      lire.disabled = true;
      try {
        await marquerLues({ ids: [lire.dataset.lire] });
      } catch (error) {
        lire.disabled = false;
        showToast(errorMessage(error), "error");
      }
      return;
    }
    const ouvrir = event.target.closest("[data-ouvrir]");
    if (ouvrir && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      // Ouvrir = lire : on marque la notification avant de suivre le lien interne.
      event.preventDefault();
      const notification = notifications.find((item) => item.id === ouvrir.dataset.ouvrir);
      if (notification && !notification.lu) {
        await marquerLues({ ids: [notification.id] }).catch(() => {});
      }
      window.location.href = ouvrir.getAttribute("href");
    }
  });

  // Le journal se met à jour seul (et déclenche le balayage des échéances côté serveur).
  setInterval(() => {
    if (document.visibilityState === "visible") charger({ silencieux: true });
  }, RAFRAICHISSEMENT_MS);
}

async function boot() {
  mountLayout();
  const user = await requireAgency();
  if (!user) return;
  const agency = await initAgencyLayout(user, "notifications");
  if (!agency) return;
  remplirFamilles();
  brancherEvenements();
  await charger();
}

boot();
