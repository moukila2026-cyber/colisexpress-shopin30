import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase.js";
import { logout } from "./auth.js";
import { errorMessage, escapeHTML, showToast } from "./utils.js";

export async function initAgencyLayout(user, activePage) {
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
    const agencySnapshot = await getDoc(doc(db, "agences", user.uid));
    if (!agencySnapshot.exists()) {
      showToast("Profil d'agence introuvable. Contactez l'administrateur.", "error");
      return null;
    }
    const agency = { id: agencySnapshot.id, ...agencySnapshot.data() };
    document.querySelectorAll("[data-agency-name]").forEach((element) => {
      element.textContent = agency.name || "Mon agence";
    });
    document.querySelectorAll("[data-agency-city]").forEach((element) => {
      element.textContent = agency.city || "Ville non renseignée";
    });
    document.querySelectorAll("[data-agency-initial]").forEach((element) => {
      element.textContent = (agency.name || "A").trim().charAt(0).toUpperCase();
    });
    if (!document.getElementById("agencyCredit")) {
      document.querySelector(".agency-content")?.insertAdjacentHTML(
        "beforeend",
        '<footer class="agency-credit" id="agencyCredit">Conçu par <strong>Shopin30</strong> <span>·</span> <a href="https://wa.me/2250501303343" target="_blank" rel="noopener noreferrer">WhatsApp : +225 0501303343</a></footer>'
      );
    }
    return agency;
  } catch (error) {
    console.error(error);
    showToast(errorMessage(error), "error");
    return null;
  }
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
        </div>
      </div>
      <nav class="agency-nav">
        <a href="dashboard.html" data-nav="dashboard"><span aria-hidden="true">▦</span> Tableau de bord</a>
        <a href="nouveau-colis.html" data-nav="nouveau"><span aria-hidden="true">＋</span> Nouveau colis</a>
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
    <div class="topbar-action">${actionHtml}</div>
  </header>`;
}
