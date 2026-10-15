import { api } from "./api.js";
import { logout } from "./auth.js";
import { escapeHTML, showToast } from "./utils.js";
import { affichageCompteur } from "./metier-plans.js";

/* LOT 10 — compteur de colis « temps réel » sans WebSocket :
 *  - une requête légère GET /api/resume (compteur + badge) toutes les 20 s
 *    quand l'onglet est visible, et dès le retour sur l'onglet ;
 *  - POST /api/colis renvoie le compteur à jour → mise à jour immédiate ;
 *  - BroadcastChannel : les autres onglets de la même agence sont prévenus.
 */
const INTERVALLE_RESUME_MS = 20000;
const CANAL_COMPTEUR = "colisexpress-compteur";
let canal = null;
let agenceCourante = null;
let roleCourant = null;
let minuterieResume = null;
const abonnesCompteur = new Set();

function ouvrirCanal() {
  if (canal || typeof BroadcastChannel === "undefined") return canal;
  try {
    canal = new BroadcastChannel(CANAL_COMPTEUR);
    canal.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || data.agenceId !== agenceCourante) return;
      if (data.compteur) afficherCompteur(data.compteur);
      if (data.nonLues !== undefined) afficherBadgeNotifications(data.nonLues);
    });
  } catch {
    canal = null;
  }
  return canal;
}

/**
 * Habillage des pages agence : barre latérale, identité affichée, déconnexion.
 * `agency` est le profil renvoyé par requireAgency() (API /api/me).
 */
export async function initAgencyLayout(agency, activePage) {
  const menuButton = document.querySelector("[data-menu-toggle]");
  const sidebar = document.getElementById("agencySidebar");
  const backdrop = document.getElementById("sidebarBackdrop");

  const closeMenu = () => {
    sidebar?.classList.remove("sidebar-open");
    backdrop?.classList.remove("backdrop-visible");
  };

  menuButton?.addEventListener("click", () => {
    sidebar?.classList.toggle("sidebar-open");
    backdrop?.classList.toggle("backdrop-visible");
  });
  backdrop?.addEventListener("click", closeMenu);
  document.querySelectorAll(".agency-nav a").forEach((link) => {
    if (link.dataset.nav === activePage) link.classList.add("nav-active");
    link.addEventListener("click", closeMenu);
  });
  document.querySelectorAll("[data-logout]").forEach((button) => {
    button.addEventListener("click", logout);
  });

  try {
    if (!agency?.id) {
      showToast("Profil d'agence introuvable. Contactez l'administrateur.", "error");
      return null;
    }
    document.querySelectorAll("[data-agency-name]").forEach((element) => {
      element.textContent = agency.name || "Mon agence";
    });
    document.querySelectorAll("[data-agency-city]").forEach((element) => {
      element.textContent = agency.city || "Ville non renseignée";
    });
    document.querySelectorAll("[data-agency-initial]").forEach((element) => {
      element.textContent = (agency.name || "A").trim().charAt(0).toUpperCase();
    });
    // Membre connecté : l'agent voit son nom, le gérant n'a pas d'affichage
    // supplémentaire (le nom de l'agence le représente déjà).
    document.querySelectorAll("[data-member-label]").forEach((element) => {
      const member = agency.member;
      const estAgent = member && member.role === "agent";
      element.hidden = !estAgent;
      element.textContent = estAgent ? `${member.name} · Agent` : "";
    });
    if (!document.getElementById("agencyCredit")) {
      document.querySelector(".agency-content")?.insertAdjacentHTML(
        "beforeend",
        '<footer class="agency-credit" id="agencyCredit"><a href="conditions.html">Conditions</a> <span>·</span> <a href="confidentialite.html">Confidentialité</a> <span>·</span> Conçu par <strong>Shopin30</strong> <span>·</span> <a href="https://wa.me/2250501303343" target="_blank" rel="noopener noreferrer">WhatsApp : +225 0501303343</a></footer>'
      );
    }
    // LOT 10 — compteur de colis + badge notifications, une seule requête,
    // puis rafraîchissement périodique (onglet visible) et entre onglets.
    agenceCourante = agency.id;
    roleCourant = agency.member?.role || "gerant";
    ouvrirCanal();
    demarrerRafraichissementResume();
    return agency;
  } catch (error) {
    console.error(error);
    showToast(error.message, "error");
    return null;
  }
}

/** Affiche le nombre de notifications non lues dans la barre latérale (masqué à 0). */
export function afficherBadgeNotifications(nonLues) {
  const n = Math.max(0, Number(nonLues) || 0);
  document.querySelectorAll("[data-notif-count]").forEach((element) => {
    element.textContent = n > 99 ? "99+" : String(n);
    element.hidden = n === 0;
    element.setAttribute("aria-label", `${n} notification${n > 1 ? "s" : ""} non lue${n > 1 ? "s" : ""}`);
  });
}

/** Compteur léger (sans balayage des échéances) : une requête par page, jamais bloquante. */
export async function rafraichirBadgeNotifications() {
  try {
    const { nonLues } = await api(`/api/notifications?resume=1&_=${Date.now()}`);
    afficherBadgeNotifications(nonLues);
  } catch {
    // Le badge est un confort : une erreur réseau ne gêne jamais la page.
  }
}

/** Les pages peuvent s'abonner au compteur (carte « Mon forfait », formulaire). */
export function surCompteur(callback) {
  abonnesCompteur.add(callback);
  return () => abonnesCompteur.delete(callback);
}

/** Affiche le compteur (barre latérale + en-tête mobile) et prévient les abonnés de la page. */
export function afficherCompteur(resume) {
  if (!resume) return;
  const vue = affichageCompteur(resume);
  document.querySelectorAll("[data-compteur]").forEach((element) => {
    element.hidden = false;
    element.dataset.niveau = vue.niveau;
    const libelle = element.querySelector("[data-compteur-libelle]");
    const detail = element.querySelector("[data-compteur-detail]");
    const barre = element.querySelector("[data-compteur-barre]");
    const lien = element.querySelector("[data-compteur-recharger]");
    if (libelle) libelle.textContent = vue.libelle;
    if (detail) detail.textContent = vue.detail;
    if (barre) {
      barre.style.width = `${vue.illimite ? 100 : vue.pourcentage}%`;
      barre.parentElement?.setAttribute("aria-valuenow", String(vue.illimite ? 0 : vue.pourcentage));
    }
    if (lien) lien.hidden = !(vue.recharger && roleCourant === "gerant");
    element.setAttribute("aria-label", `${vue.libelle}. ${vue.detail}`);
  });
  document.querySelectorAll("[data-compteur-court]").forEach((element) => {
    element.hidden = false;
    element.dataset.niveau = vue.niveau;
    element.textContent = vue.illimite ? `${resume.compteur ?? 0} colis` : `${resume.compteur ?? 0} / ${resume.quotaEffectif}`;
    element.title = `${vue.libelle}. ${vue.detail}`;
  });
  abonnesCompteur.forEach((callback) => {
    try { callback(resume, vue); } catch (error) { console.error(error); }
  });
}

/**
 * Publie un compteur reçu d'une réponse serveur (ex. POST /api/colis) : la
 * page courante ET les autres onglets de l'agence sont mis à jour aussitôt.
 */
export function diffuserCompteur(compteur, nonLues) {
  if (!compteur) return;
  afficherCompteur(compteur);
  if (nonLues !== undefined) afficherBadgeNotifications(nonLues);
  try {
    ouvrirCanal()?.postMessage({ agenceId: agenceCourante, compteur, nonLues });
  } catch {
    // Diffusion entre onglets : confort, jamais bloquante.
  }
}

/** Une requête légère : compteur du mois + notifications non lues. */
export async function rafraichirResume() {
  try {
    const { compteur, nonLues } = await api(`/api/resume?_=${Date.now()}`);
    afficherCompteur(compteur);
    afficherBadgeNotifications(nonLues);
    return compteur;
  } catch {
    return null;
  }
}

function demarrerRafraichissementResume() {
  rafraichirResume();
  if (minuterieResume) window.clearInterval(minuterieResume);
  minuterieResume = window.setInterval(() => {
    if (document.visibilityState === "visible") rafraichirResume();
  }, INTERVALLE_RESUME_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") rafraichirResume();
  });
}

export function agencySidebar() {
  return `
    <aside class="agency-sidebar" id="agencySidebar" aria-label="Navigation agence">
      <a class="brand brand-sidebar" href="dashboard.html" aria-label="COLIS EXPRESS, tableau de bord">
        <span class="brand-mark" aria-hidden="true">CE</span>
        <span>COLIS <em>EXPRESS</em></span>
      </a>
      <div class="agency-identity">
        <span class="avatar" data-agency-initial>A</span>
        <div>
          <strong data-agency-name>Chargement…</strong>
          <small data-agency-city>—</small>
          <small class="member-line" data-member-label hidden></small>
        </div>
      </div>
      <div class="compteur-colis" data-compteur data-niveau="normal" hidden role="status">
        <strong data-compteur-libelle>Colis ce mois : —</strong>
        <div class="compteur-barre" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span data-compteur-barre></span></div>
        <small data-compteur-detail>—</small>
        <a class="compteur-recharger" data-compteur-recharger href="abonnement.html#recharge" hidden>Recharger</a>
      </div>
      <nav class="agency-nav">
        <a href="dashboard.html" data-nav="dashboard"><span aria-hidden="true">▦</span> Tableau de bord</a>
        <a href="nouveau-colis.html" data-nav="nouveau"><span aria-hidden="true">＋</span> Nouveau colis</a>
        <a href="bordereaux.html" data-nav="bordereaux"><span aria-hidden="true">▤</span> Bordereaux</a>
        <a href="clients.html" data-nav="clients"><span aria-hidden="true">✆</span> Clients</a>
        <a href="caisse.html" data-nav="caisse"><span aria-hidden="true">◈</span> Caisse</a>
        <a href="notifications.html" data-nav="notifications"><span aria-hidden="true">✉</span> Notifications <b class="nav-badge" data-notif-count hidden></b></a>
        <a href="abonnement.html" data-nav="abonnement"><span aria-hidden="true">◎</span> Abonnement</a>
        <a href="parametres.html" data-nav="parametres"><span aria-hidden="true">⚙</span> Paramètres</a>
      </nav>
      <div class="sidebar-footer">
        <a class="public-link" href="index.html"><span aria-hidden="true">↗</span> Voir le site public</a>
        <button class="button button-ghost button-logout" data-logout type="button"><span aria-hidden="true">↪</span> Se déconnecter</button>
      </div>
    </aside>
    <div id="sidebarBackdrop" class="sidebar-backdrop" aria-hidden="true"></div>`;
}

export function mobileAgencyHeader(title, actionHtml = "") {
  return `<header class="agency-topbar">
    <button class="icon-button menu-button" data-menu-toggle type="button" aria-label="Ouvrir le menu">☰</button>
    <div class="topbar-title"><small>COLIS EXPRESS</small><strong>${escapeHTML(title)}</strong></div>
    <a class="compteur-court" data-compteur-court data-niveau="normal" href="abonnement.html" hidden aria-label="Colis ce mois"></a>
    <div class="topbar-action">${actionHtml}</div>
  </header>`;
}
