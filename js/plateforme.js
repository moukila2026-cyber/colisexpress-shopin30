/*
 * Console plateforme (LOT 6) — équipe Shopin30, compte SÉPARÉ des agences
 * (cookie ce_plateforme, routes /api/plateforme…). Vue d'ensemble en lecture :
 * file des incidents ouverts depuis plus de 7 jours, litiges, agences (plan,
 * compteur du mois, portefeuille, abonnement) et volumes. Deux écritures,
 * vérifiées côté serveur : fixer le plan d'une agence (Réseau = quota et
 * prix négociés) et créditer son portefeuille d'un paiement reçu.
 */
import { api } from "./api.js";
import { affichageCompteur, libellePeriode, libellePlan, libelleStatutAbonnement } from "./metier-plans.js";
import {
  clearPageMessage,
  errorMessage,
  escapeHTML,
  formatDateTime,
  formatFCFA,
  formatShortDate,
  setButtonLoading,
  showPageMessage,
  showToast,
  statusBadge
} from "./utils.js";

const message = document.getElementById("pageMessage");
const loginPanel = document.getElementById("loginPanel");
const amorcagePanel = document.getElementById("amorcagePanel");
const consolePanel = document.getElementById("consolePanel");
const sessionBar = document.getElementById("plateformeSession");
const modal = document.getElementById("agenceModal");
const modalMessage = document.getElementById("agenceModalMessage");
const planSelect = document.getElementById("planSelect");
const reseauFields = document.getElementById("reseauFields");

let vue = null;
let agenceCourante = null;

function afficherConnexion() {
  consolePanel.hidden = true;
  sessionBar.hidden = true;
  loginPanel.hidden = false;
  document.getElementById("plateformeEmail")?.focus();
  verifierAmorcage();
}

/**
 * LOT 8 — amorçage du premier administrateur sans terminal : le formulaire
 * n'apparaît que si le serveur l'autorise (aucun administrateur actif ET
 * jeton configuré dans Vercel). Après la première création, il disparaît
 * définitivement.
 */
async function verifierAmorcage() {
  try {
    const etat = await api(`/api/plateforme/amorcage?_=${Date.now()}`);
    amorcagePanel.hidden = etat.disponible !== true;
  } catch {
    amorcagePanel.hidden = true;
  }
}

async function amorcer(event) {
  event.preventDefault();
  const button = document.getElementById("amorcageButton");
  const corps = {
    jeton: document.getElementById("amorcageJeton").value.trim(),
    email: document.getElementById("amorcageEmail").value.trim(),
    nom: document.getElementById("amorcageNom").value.trim(),
    password: document.getElementById("amorcagePassword").value
  };
  if (!corps.jeton || !corps.email || !corps.nom || corps.password.length < 12) {
    showPageMessage(message, "Renseignez le jeton, l'e-mail, le nom et un mot de passe d'au moins 12 caractères.");
    return;
  }
  setButtonLoading(button, true, "Création…");
  try {
    const resultat = await api("/api/plateforme/amorcage", { method: "POST", body: corps });
    document.getElementById("amorcageJeton").value = "";
    document.getElementById("amorcagePassword").value = "";
    amorcagePanel.hidden = true;
    showToast(`Compte créé pour ${resultat.admin.email}. ${resultat.aFaire}`);
    await charger();
  } catch (error) {
    showPageMessage(message, errorMessage(error));
  } finally {
    setButtonLoading(button, false);
  }
}

function afficherConsole() {
  loginPanel.hidden = true;
  amorcagePanel.hidden = true;
  consolePanel.hidden = false;
  sessionBar.hidden = false;
  document.getElementById("adminName").textContent = vue?.admin?.name || "";
}

function trajet(parcel) {
  return `${escapeHTML(parcel.originCity || "—")} <span aria-hidden="true">→</span> ${escapeHTML(parcel.destinationCity || "—")}`;
}

function tableIncidents(incidents, vide) {
  if (!incidents.length) return `<div class="empty-inline panel-empty">${escapeHTML(vide)}</div>`;
  return `<div class="table-wrap"><table class="parcel-table plateforme-table">
    <thead><tr><th>Colis</th><th>Trajet</th><th>Incident</th><th>Ouvert depuis</th><th>Agences</th><th>Note interne</th></tr></thead>
    <tbody>${incidents.map((incident) => `<tr>
      <td><strong class="tracking-code">${escapeHTML(incident.parcel.trackingCode)}</strong><br>${statusBadge(incident.parcel.status)}</td>
      <td class="route-cell">${trajet(incident.parcel)}</td>
      <td><strong>${escapeHTML(incident.libelleType)}</strong><br><small>${escapeHTML(incident.libelleEtat)}${incident.state === "resolu" && incident.resolvedAtISO ? ` le ${escapeHTML(formatShortDate(incident.resolvedAtISO))}` : ""}</small></td>
      <td>${incident.state === "resolu" ? "—" : `<strong class="${incident.filePlateforme ? "texte-alerte" : ""}">${incident.jours} j</strong>`}<br><small>${escapeHTML(formatShortDate(incident.openedAtISO))}</small></td>
      <td><small>${escapeHTML(incident.expediteur.name || "—")}<br>→ ${escapeHTML(incident.destination.name || "—")}</small></td>
      <td class="cell-wrap"><small>${escapeHTML(incident.state === "resolu" && incident.resolution ? `Résolution : ${incident.resolution}` : incident.note || "—")}</small></td>
    </tr>`).join("")}</tbody></table></div>`;
}

function badgePlan(plan) {
  return `<span class="plan-badge plan-badge-${escapeHTML(plan)}">${escapeHTML(libellePlan(plan))}</span>`;
}

function celluleAbonnement(agence) {
  const abonnement = agence.periode.abonnement;
  if (!agence.periodeOuverte) return '<small class="muted-note">Mois pas encore ouvert</small>';
  if (abonnement.statut === "sans_frais") return '<small class="muted-note">Sans abonnement</small>';
  const echeance = abonnement.statut === "paye"
    ? `réglé le ${formatShortDate(abonnement.payeLeISO)}`
    : `avant le ${formatShortDate(abonnement.echeanceISO)}`;
  return `<span class="${abonnement.enRetard ? "texte-alerte" : ""}">${escapeHTML(libelleStatutAbonnement(abonnement))}</span><br><small>${escapeHTML(formatFCFA(abonnement.montantFCFA))} · ${escapeHTML(echeance)}</small>`;
}

/** LOT 10 — compteur de l'agence avec barre, mis en évidence à partir de 80 % du quota. */
function celluleCompteur(agence, quota) {
  const periode = agence.periode;
  const vueCompteur = affichageCompteur({
    compteur: periode.compteur,
    quotaEffectif: periode.quotaEffectif,
    soldeFCFA: agence.portefeuilleFCFA,
    enRetard: periode.abonnement?.enRetard,
    prochainColis: agence.resume.prochainColis,
    colisPrepayes: agence.resume.colisPrepayes
  });
  return `<div class="console-quota" data-niveau="${vueCompteur.niveau}" title="${escapeHTML(vueCompteur.detail)}">
    <strong>${periode.compteur} / ${escapeHTML(String(quota))}${vueCompteur.niveau !== "normal" ? ` · ${vueCompteur.illimite ? "" : vueCompteur.pourcentage + " %"}` : ""}</strong>
    <div class="compteur-barre" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${vueCompteur.illimite ? 0 : vueCompteur.pourcentage}"><span style="width:${vueCompteur.illimite ? 100 : vueCompteur.pourcentage}%"></span></div>
    <small>${escapeHTML(vueCompteur.detail)}${periode.depassements ? ` · ${periode.depassements} hors forfait` : ""}</small>
  </div>`;
}

function renderAgences() {
  const agences = vue.agences || [];
  document.getElementById("agencesCount").textContent = `${agences.length} agence${agences.length > 1 ? "s" : ""}`;
  const target = document.getElementById("agencesList");
  if (!agences.length) {
    target.innerHTML = '<div class="empty-inline panel-empty">Aucune agence inscrite pour l\'instant.</div>';
    return;
  }
  target.innerHTML = `<div class="table-wrap"><table class="parcel-table plateforme-table">
    <thead><tr><th>Agence</th><th>Plan</th><th>Compteur du mois</th><th>Portefeuille</th><th>Abonnement</th><th>Volumes</th><th>Incidents</th><th></th></tr></thead>
    <tbody>${agences.map((agence) => {
      const periode = agence.periode;
      const quota = periode.quotaEffectif === null ? "illimité" : periode.quotaEffectif;
      return `<tr>
        <td><strong>${escapeHTML(agence.name)}</strong><br><small>${escapeHTML(agence.city)} · ${escapeHTML(agence.phone || "")}</small></td>
        <td>${badgePlan(agence.plan)}${agence.planSuivant ? `<br><small>→ ${escapeHTML(libellePlan(agence.planSuivant))} le mois prochain</small>` : ""}${agence.plan === "reseau" && agence.prixNegocieFCFA !== null ? `<br><small>${escapeHTML(formatFCFA(agence.prixNegocieFCFA))}/mois</small>` : ""}</td>
        <td>${celluleCompteur(agence, quota)}</td>
        <td>${escapeHTML(formatFCFA(agence.portefeuilleFCFA))}<br><small>${agence.resume.colisPrepayes} colis prépayés</small></td>
        <td>${celluleAbonnement(agence)}</td>
        <td><small>Envoyés : ${agence.volumes.envoyesMois} ce mois / ${agence.volumes.envoyesTotal}<br>Reçus : ${agence.volumes.recusMois} ce mois / ${agence.volumes.recusTotal}</small></td>
        <td>${agence.incidentsOuverts}</td>
        <td><button class="button button-small button-outline" type="button" data-gerer="${escapeHTML(agence.id)}">Gérer</button></td>
      </tr>`;
    }).join("")}</tbody></table></div>`;
  target.querySelectorAll("[data-gerer]").forEach((button) => {
    button.addEventListener("click", () => ouvrirAgence(button.dataset.gerer));
  });
}

function renderVolumes() {
  const { parMois = [], parStatut = [] } = vue.volumes || {};
  document.getElementById("volumesTotal").textContent = `${vue.indicateurs.colisTotal} colis au total`;
  document.getElementById("volumesList").innerHTML = `
    <div><h3 class="form-subheading">Colis enregistrés par mois</h3>
      ${parMois.length ? `<table class="parcel-table plateforme-table"><tbody>${parMois.map((ligne) => `<tr><td>${escapeHTML(libellePeriode(ligne.periode))}</td><td><strong>${ligne.colis}</strong></td></tr>`).join("")}</tbody></table>` : '<div class="empty-inline">Aucun colis.</div>'}
    </div>
    <div><h3 class="form-subheading">Colis par statut</h3>
      ${parStatut.length ? `<table class="parcel-table plateforme-table"><tbody>${parStatut.map((ligne) => `<tr><td>${statusBadge(ligne.status)}</td><td><strong>${ligne.colis}</strong></td></tr>`).join("")}</tbody></table>` : '<div class="empty-inline">Aucun colis.</div>'}
    </div>`;
}

function renderAll() {
  const k = vue.indicateurs;
  document.getElementById("consolePeriode").textContent = `Mois en cours : ${libellePeriode(vue.periode)} · mis à jour le ${formatDateTime(new Date())}`;
  document.getElementById("kpiAgences").textContent = String(k.agences);
  document.getElementById("kpiAbonnements").textContent = `${k.abonnementsDus} abonnement${k.abonnementsDus > 1 ? "s" : ""} à régler${k.abonnementsEnRetard ? `, dont ${k.abonnementsEnRetard} en retard` : ""}`;
  document.getElementById("kpiColisMois").textContent = String(k.colisMois);
  document.getElementById("kpiColisTotal").textContent = `${k.colisTotal} colis au total`;
  document.getElementById("kpiFile").textContent = String(k.incidentsFile);
  document.getElementById("kpiLitiges").textContent = String(k.litigesOuverts);
  document.getElementById("kpiPortefeuilles").textContent = `Portefeuilles : ${formatFCFA(k.portefeuillesFCFA)}`;

  document.getElementById("fileCount").textContent = `${vue.fileIncidents.length} incident${vue.fileIncidents.length > 1 ? "s" : ""}`;
  document.getElementById("fileList").innerHTML = tableIncidents(vue.fileIncidents, "Aucun incident ouvert depuis plus de 7 jours.");
  document.getElementById("litigesCount").textContent = `${k.litigesOuverts} ouvert${k.litigesOuverts > 1 ? "s" : ""} · ${vue.litiges.length} au total`;
  document.getElementById("litigesList").innerHTML = tableIncidents(vue.litiges, "Aucun litige.");
  renderAgences();
  renderVolumes();
}

const ETATS_MISE_EN_SERVICE = { ok: ["✓", "mes-ok", "OK"], attention: ["⚠", "mes-attention", "À vérifier"], erreur: ["✗", "mes-erreur", "À corriger"] };

/** LOT 9 — panneau « Mise en service » (lecture seule, aucun secret). */
async function chargerMiseEnService() {
  const target = document.getElementById("miseEnServiceList");
  const resume = document.getElementById("miseEnServiceResume");
  try {
    const diagnostic = await api(`/api/plateforme/mise-en-service?_=${Date.now()}`);
    resume.textContent = `${diagnostic.environnement} · ${diagnostic.resume.ok} ✓ · ${diagnostic.resume.attention} ⚠ · ${diagnostic.resume.erreur} ✗`;
    target.innerHTML = `<div class="table-wrap"><table class="parcel-table plateforme-table mes-table">
      <thead><tr><th>État</th><th>Point de contrôle</th><th>Constat</th><th>Action à faire</th></tr></thead>
      <tbody>${diagnostic.lignes.map((l) => {
        const [symbole, classe, libelle] = ETATS_MISE_EN_SERVICE[l.etat] || ETATS_MISE_EN_SERVICE.attention;
        return `<tr class="${classe}">
          <td><span class="mes-etat" aria-label="${libelle}">${symbole}</span></td>
          <td><strong>${escapeHTML(l.libelle)}</strong></td>
          <td class="cell-wrap"><small>${escapeHTML(l.detail)}</small></td>
          <td class="cell-wrap"><small>${escapeHTML(l.action || "—")}</small></td>
        </tr>`;
      }).join("")}</tbody></table></div>`;
  } catch (error) {
    resume.textContent = "—";
    target.innerHTML = `<div class="empty-inline panel-empty">${escapeHTML(errorMessage(error))}</div>`;
  }
}

async function charger({ silencieux = false } = {}) {
  try {
    vue = await api(`/api/plateforme?_=${Date.now()}`);
    clearPageMessage(message);
    afficherConsole();
    renderAll();
    await chargerMiseEnService();
  } catch (error) {
    if (error.status === 401) {
      vue = null;
      afficherConnexion();
      return;
    }
    if (!silencieux) showPageMessage(message, errorMessage(error));
  }
}

async function connexion(event) {
  event.preventDefault();
  const button = document.getElementById("plateformeLoginButton");
  const email = document.getElementById("plateformeEmail").value.trim();
  const password = document.getElementById("plateformePassword").value;
  if (!email || !password) {
    showPageMessage(message, "Saisissez l'e-mail et le mot de passe de votre compte plateforme.");
    return;
  }
  setButtonLoading(button, true, "Connexion…");
  try {
    await api("/api/plateforme/connexion", { method: "POST", body: { email, password } });
    document.getElementById("plateformePassword").value = "";
    await charger();
  } catch (error) {
    showPageMessage(message, errorMessage(error));
  } finally {
    setButtonLoading(button, false);
  }
}

async function deconnexion() {
  try {
    await api("/api/plateforme/deconnexion", { method: "POST", body: {} });
  } catch {
    // Cookie déjà expiré ou réseau coupé : on revient quand même à la connexion.
  }
  vue = null;
  afficherConnexion();
}

function syncReseau() {
  reseauFields.hidden = planSelect.value !== "reseau";
}

function ouvrirAgence(agencyId) {
  agenceCourante = vue.agences.find((agence) => agence.id === agencyId) || null;
  if (!agenceCourante) return;
  clearPageMessage(modalMessage);
  document.getElementById("agenceModalTitle").textContent = agenceCourante.name;
  document.getElementById("agenceModalResume").textContent =
    `${libellePlan(agenceCourante.plan)} · ${agenceCourante.periode.compteur} colis ce mois · portefeuille ${formatFCFA(agenceCourante.portefeuilleFCFA)}`;
  planSelect.value = agenceCourante.plan;
  document.getElementById("quotaReseau").value = agenceCourante.quotaNegocie ?? "";
  document.getElementById("prixReseau").value = agenceCourante.prixNegocieFCFA ?? "";
  document.getElementById("creditMontant").value = "";
  document.getElementById("creditReference").value = "";
  syncReseau();
  modal.hidden = false;
  document.body.classList.add("modal-open");
}

function fermerAgence() {
  modal.hidden = true;
  document.body.classList.remove("modal-open");
  agenceCourante = null;
}

async function appliquerPlan(event) {
  event.preventDefault();
  if (!agenceCourante) return;
  const button = document.getElementById("planSubmit");
  setButtonLoading(button, true, "Application…");
  try {
    await api("/api/plateforme/plan", {
      method: "POST",
      body: {
        agencyId: agenceCourante.id,
        plan: planSelect.value,
        quotaMensuel: document.getElementById("quotaReseau").value,
        prixMensuelFCFA: document.getElementById("prixReseau").value
      }
    });
    showToast(`Plan ${libellePlan(planSelect.value)} appliqué à ${agenceCourante.name}.`);
    fermerAgence();
    await charger();
  } catch (error) {
    showPageMessage(modalMessage, errorMessage(error));
  } finally {
    setButtonLoading(button, false);
  }
}

async function crediter(event) {
  event.preventDefault();
  if (!agenceCourante) return;
  const button = document.getElementById("creditSubmit");
  setButtonLoading(button, true, "Crédit…");
  try {
    const resultat = await api("/api/plateforme/credit", {
      method: "POST",
      body: {
        agencyId: agenceCourante.id,
        montantFCFA: Number(document.getElementById("creditMontant").value),
        reference: document.getElementById("creditReference").value
      }
    });
    showToast(`Portefeuille crédité : nouveau solde ${formatFCFA(resultat.soldeFCFA)}${resultat.abonnementRegle ? " (abonnement du mois réglé)" : ""}.`);
    fermerAgence();
    await charger();
  } catch (error) {
    showPageMessage(modalMessage, errorMessage(error));
  } finally {
    setButtonLoading(button, false);
  }
}

function boot() {
  document.getElementById("plateformeLoginForm").addEventListener("submit", connexion);
  document.getElementById("amorcageForm").addEventListener("submit", amorcer);
  document.getElementById("logoutPlateforme").addEventListener("click", deconnexion);
  document.getElementById("refreshConsole").addEventListener("click", () => charger());
  document.getElementById("closeAgenceModal").addEventListener("click", fermerAgence);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) fermerAgence();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) fermerAgence();
  });
  planSelect.addEventListener("change", syncReseau);
  document.getElementById("planForm").addEventListener("submit", appliquerPlan);
  document.getElementById("creditForm").addEventListener("submit", crediter);
  // LOT 10 — compteurs des agences rafraîchis toutes les 30 s (onglet visible, aucune fenêtre ouverte).
  window.setInterval(() => {
    if (vue && document.visibilityState === "visible" && modal.hidden) charger({ silencieux: true });
  }, 30_000);
  document.addEventListener("visibilitychange", () => {
    if (vue && document.visibilityState === "visible" && modal.hidden) charger({ silencieux: true });
  });
  charger();
}

boot();
