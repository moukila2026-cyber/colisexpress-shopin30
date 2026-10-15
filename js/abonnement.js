/*
 * Abonnement (LOT 6) — plan de l'agence, compteur des colis du mois,
 * portefeuille prépayé, échéances et historique. Lecture pour tout membre ;
 * changement de plan et règlement réservés au gérant (garde serveur, les
 * boutons ne sont qu'un confort d'interface). Seuls les colis ENREGISTRÉS par
 * l'agence sont comptés ; un solde impayé ne bloque jamais un colis en cours.
 */
import { api } from "./api.js";
import { requireAgency } from "./auth.js";
import { agencySidebar, initAgencyLayout, mobileAgencyHeader } from "./layout.js";
import {
  IDS_PLANS,
  libelleMouvement,
  libellePeriode,
  libellePlan,
  libelleStatutAbonnement,
  libelleStatutEcheance,
  periodeSuivante
} from "./metier-plans.js";
import { libelleModePaiement } from "./metier-paiements.js";
import {
  clearPageMessage,
  errorMessage,
  escapeHTML,
  formatDateTime,
  formatFCFA,
  formatShortDate,
  getQueryParam,
  setButtonLoading,
  showPageMessage,
  showToast
} from "./utils.js";

const LIEN_DEVIS_RESEAU = `https://wa.me/2250501303343?text=${encodeURIComponent("Bonjour Shopin30, nous souhaitons un devis pour le plan Réseau de COLIS EXPRESS.")}`;

const message = document.getElementById("pageMessage");
const alerteTarget = document.getElementById("abonnementAlerte");
let facturation = null;
// LOT 7 — paiement en ligne SasPay (abonnement dû, recharge du portefeuille).
let paiementsEnLigne = { actif: false, mode: null, raison: "" };

function mountLayout() {
  document.getElementById("sidebarMount").innerHTML = agencySidebar();
  document.getElementById("topbarMount").innerHTML = mobileAgencyHeader("Abonnement");
}

function prixPlan(plan) {
  if (plan.surDevis) return "Sur devis";
  return plan.prixMensuelFCFA ? `${formatFCFA(plan.prixMensuelFCFA)} / mois` : "0 FCFA / mois";
}

function quotaTexte(quota) {
  return quota === null ? "illimité" : `${quota}`;
}

function renderSynthese() {
  const { periode, resume, portefeuille, plan, planSuivant } = facturation;
  document.getElementById("planActuel").textContent = libellePlan(plan);
  document.getElementById("planDetail").textContent = planSuivant
    ? `Passage au plan ${libellePlan(planSuivant)} le 1er ${libellePeriode(periodeSuivante(periode.cle))}`
    : plan === "reseau"
      ? `Quota négocié : ${quotaTexte(periode.quota)} colis`
      : `${quotaTexte(periode.quota)} colis inclus par mois`;
  document.getElementById("compteurColis").textContent =
    periode.quotaEffectif === null ? `${periode.compteur}` : `${periode.compteur} / ${periode.quotaEffectif}`;
  document.getElementById("periodeLabel").textContent =
    `${periode.libelle}${periode.depassements ? ` · ${periode.depassements} hors forfait` : ""}`;
  document.getElementById("soldePortefeuille").textContent = formatFCFA(portefeuille.soldeFCFA);
  document.getElementById("colisPrepayes").textContent = `${resume.colisPrepayes} colis hors forfait prépayé${resume.colisPrepayes > 1 ? "s" : ""}`;
  document.getElementById("statutAbonnement").textContent = libelleStatutAbonnement(periode.abonnement);
  document.getElementById("echeanceAbonnement").textContent =
    periode.abonnement.statut === "sans_frais"
      ? "Aucun abonnement à payer"
      : periode.abonnement.statut === "paye"
        ? `${formatFCFA(periode.abonnement.montantFCFA)} réglés le ${formatShortDate(periode.abonnement.payeLeISO)}`
        : `${formatFCFA(periode.abonnement.montantFCFA)} avant le ${formatShortDate(periode.abonnement.echeanceISO)}`;

  alerteTarget.hidden = !resume.alerte;
  alerteTarget.textContent = resume.alerte || "";
  alerteTarget.classList.toggle(
    "notice-danger",
    Boolean(periode.abonnement.enRetard || (resume.prochainColis.type === "depassement" && portefeuille.soldeFCFA < resume.prochainColis.montantFCFA))
  );

  const bar = document.getElementById("quotaBar");
  bar.setAttribute("aria-valuenow", String(resume.pourcentage));
  bar.classList.toggle("quota-bar-plein", resume.pourcentage >= 100);
  document.getElementById("quotaBarFill").style.width = `${periode.quotaEffectif === null ? 0 : resume.pourcentage}%`;
  document.getElementById("quotaLegende").textContent = periode.quotaEffectif === null
    ? `${periode.compteur} colis ce mois-ci · quota illimité`
    : `${periode.compteur} sur ${periode.quotaEffectif} colis inclus · ${periode.inclusRestants} restant${periode.inclusRestants > 1 ? "s" : ""}`;

  const actions = document.getElementById("abonnementActions");
  const du = periode.abonnement.statut === "du" && facturation.peutModifier;
  const mode = paiementsEnLigne.mode && paiementsEnLigne.mode !== "live" ? ` (${escapeHTML(libelleModePaiement(paiementsEnLigne.mode).toLowerCase())})` : "";
  actions.innerHTML = du
    ? `<button class="button button-primary" type="button" id="reglerAbonnement">Régler l'abonnement (${escapeHTML(formatFCFA(periode.abonnement.montantFCFA))}) depuis le portefeuille</button>${paiementsEnLigne.actif ? `<button class="button button-orange" type="button" id="payerAbonnementEnLigne">Payer en ligne avec SasPay${mode}</button>` : ""}`
    : "";
  document.getElementById("reglerAbonnement")?.addEventListener("click", reglerAbonnement);
  document.getElementById("payerAbonnementEnLigne")?.addEventListener("click", (event) => payerEnLigne(event.currentTarget, { objet: "abonnement" }));

  const recharge = document.getElementById("rechargeEnLigneForm");
  recharge.hidden = !(paiementsEnLigne.actif && facturation.peutModifier);
  document.getElementById("rechargeModeNote").textContent = paiementsEnLigne.actif
    ? `${paiementsEnLigne.mode === "live" ? "Paiement réel." : `Mode ${libelleModePaiement(paiementsEnLigne.mode).toLowerCase()} : aucune somme réelle n'est prélevée.`} Le portefeuille est crédité dès la confirmation, et un abonnement dû est réglé automatiquement.`
    : "";
}

function boutonPlan(plan) {
  const { plan: actuel, planSuivant, peutModifier } = facturation;
  if (plan.id === actuel) {
    if (planSuivant && peutModifier) {
      return `<button class="button button-outline" type="button" data-plan="${escapeHTML(plan.id)}">Garder le plan ${escapeHTML(plan.label)}</button>`;
    }
    return '<span class="plan-current">Plan actuel</span>';
  }
  if (plan.surDevis) {
    return `<a class="button button-outline" href="${LIEN_DEVIS_RESEAU}" target="_blank" rel="noopener noreferrer">Demander un devis</a>`;
  }
  if (actuel === "reseau") return '<span class="muted-note">Plan géré par Shopin30</span>';
  if (planSuivant === plan.id) return '<span class="plan-current">Programmé le mois prochain</span>';
  if (!peutModifier) return '<span class="muted-note">Réservé au gérant</span>';
  const libelle = plan.id === "pro" ? "Passer au Pro" : "Revenir au Gratuit le mois prochain";
  return `<button class="button ${plan.id === "pro" ? "button-primary" : "button-outline"}" type="button" data-plan="${escapeHTML(plan.id)}">${libelle}</button>`;
}

function renderPlans() {
  const target = document.getElementById("plansGrid");
  target.innerHTML = IDS_PLANS.map((id) => {
    const plan = facturation.plans[id];
    const courant = id === facturation.plan;
    return `<article class="plan-card${courant ? " plan-card-current" : ""}">
      <div class="plan-card-head"><h3>${escapeHTML(plan.label)}</h3><strong>${escapeHTML(prixPlan(plan))}</strong></div>
      <p>${escapeHTML(plan.description)}</p>
      <div class="plan-card-action">${boutonPlan(plan)}</div>
    </article>`;
  }).join("");
  target.querySelectorAll("[data-plan]").forEach((button) => {
    button.addEventListener("click", () => changerPlan(button));
  });
}

function renderEcheances() {
  const echeances = facturation.echeances || [];
  document.getElementById("echeancesCount").textContent = `${echeances.length} échéance${echeances.length > 1 ? "s" : ""}`;
  const target = document.getElementById("echeancesList");
  if (!echeances.length) {
    target.innerHTML = '<div class="empty-inline panel-empty">Aucune échéance : le plan Gratuit est sans abonnement. Seuls les colis hors forfait sont prélevés, au moment de leur enregistrement.</div>';
    return;
  }
  target.innerHTML = `<div class="table-wrap"><table class="parcel-table billing-table">
    <thead><tr><th>Échéance</th><th>Montant</th><th>À régler avant le</th><th>Statut</th></tr></thead>
    <tbody>${echeances.map((item) => `<tr>
      <td>${escapeHTML(item.libelle)}</td>
      <td>${escapeHTML(formatFCFA(item.montantFCFA))}</td>
      <td>${escapeHTML(formatShortDate(item.echeanceISO))}</td>
      <td><span class="status-badge echeance-${escapeHTML(item.statut)}">${escapeHTML(libelleStatutEcheance(item.statut))}</span></td>
    </tr>`).join("")}</tbody></table></div>`;
}

function renderMouvements() {
  const mouvements = facturation.portefeuille.mouvements || [];
  document.getElementById("mouvementsCount").textContent = `${mouvements.length} mouvement${mouvements.length > 1 ? "s" : ""}`;
  const target = document.getElementById("mouvementsList");
  if (!mouvements.length) {
    target.innerHTML = '<div class="empty-inline panel-empty">Aucun mouvement pour l\'instant.</div>';
    return;
  }
  target.innerHTML = `<div class="table-wrap"><table class="parcel-table billing-table">
    <thead><tr><th>Date</th><th>Opération</th><th>Montant</th><th>Solde après</th><th>Référence</th></tr></thead>
    <tbody>${mouvements.map((item) => `<tr>
      <td>${escapeHTML(formatDateTime(item.createdAtISO))}</td>
      <td><strong>${escapeHTML(libelleMouvement(item.type))}</strong><br><small>${escapeHTML(item.libelle)}</small></td>
      <td class="${item.montantFCFA < 0 ? "montant-debit" : "montant-credit"}">${item.montantFCFA > 0 ? "+" : ""}${escapeHTML(formatFCFA(item.montantFCFA))}</td>
      <td>${escapeHTML(formatFCFA(item.soldeApresFCFA))}</td>
      <td><small>${escapeHTML([item.reference, item.acteurNom].filter(Boolean).join(" · ") || "—")}</small></td>
    </tr>`).join("")}</tbody></table></div>`;
}

function renderPeriodes() {
  const periodes = facturation.periodes || [];
  document.getElementById("periodesCount").textContent = `${periodes.length} mois`;
  document.getElementById("periodesList").innerHTML = `<div class="table-wrap"><table class="parcel-table billing-table">
    <thead><tr><th>Mois</th><th>Plan</th><th>Colis enregistrés</th><th>Hors forfait</th><th>Abonnement</th></tr></thead>
    <tbody>${periodes.map((item) => `<tr>
      <td>${escapeHTML(item.libelle)}</td>
      <td>${escapeHTML(libellePlan(item.plan))}</td>
      <td>${item.compteur}${item.quota === null ? "" : ` / ${item.quota}`}</td>
      <td>${item.depassements}</td>
      <td>${item.abonnement.statut === "sans_frais" ? "—" : `${escapeHTML(formatFCFA(item.abonnement.montantFCFA))} · ${escapeHTML(libelleStatutAbonnement(item.abonnement))}`}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

function renderAll() {
  if (!facturation) return;
  renderSynthese();
  renderPlans();
  renderEcheances();
  renderMouvements();
  renderPeriodes();
}

async function charger() {
  try {
    const data = await api(`/api/facturation?_=${Date.now()}`);
    facturation = data.facturation;
    clearPageMessage(message);
    renderAll();
  } catch (error) {
    showPageMessage(message, errorMessage(error));
  }
}

async function changerPlan(button) {
  const plan = button.dataset.plan;
  const confirmation = plan === "pro" && facturation.plan !== "pro"
    ? "Passer au plan Pro : 10 000 FCFA par mois, 500 colis inclus. L'abonnement de ce mois est prélevé sur le portefeuille dès que le solde le permet (échéance sous 7 jours). Confirmer ?"
    : plan === "gratuit"
      ? "Revenir au plan Gratuit au 1er du mois prochain ? Le mois en cours reste au plan actuel."
      : null;
  if (confirmation && !window.confirm(confirmation)) return;
  setButtonLoading(button, true, "Enregistrement…");
  try {
    const data = await api("/api/facturation/plan", { method: "POST", body: { plan } });
    facturation = { ...facturation, ...data.facturation };
    renderAll();
    showToast(
      data.effet === "immediat"
        ? "Votre agence est passée au plan Pro."
        : data.effet === "annulation"
          ? "Le changement de plan programmé est annulé."
          : "Le retour au plan Gratuit est programmé pour le mois prochain."
    );
  } catch (error) {
    showToast(errorMessage(error), "error");
    setButtonLoading(button, false);
  }
}

/** Paiement hébergé SasPay : redirection vers la page de paiement (simulée sans clé). */
async function payerEnLigne(bouton, corps) {
  setButtonLoading(bouton, true, "Préparation…");
  try {
    const { paiement } = await api("/api/paiements", { method: "POST", body: corps });
    window.location.href = paiement.checkoutUrl;
  } catch (error) {
    showToast(errorMessage(error), "error");
    setButtonLoading(bouton, false);
  }
}

async function rechargerEnLigne(event) {
  event.preventDefault();
  const montant = Number(document.getElementById("rechargeMontant").value);
  if (!Number.isInteger(montant) || montant < 100 || montant > 1_000_000) {
    showToast("Indiquez un montant entier entre 100 et 1 000 000 FCFA.", "error");
    return;
  }
  await payerEnLigne(document.getElementById("rechargeEnLigneButton"), { objet: "recharge", montantFCFA: montant });
}

/** Retour de la page de paiement : vérification côté serveur, puis nettoyage de l'adresse. */
async function verifierRetourPaiement(id) {
  window.history.replaceState(null, "", "abonnement.html");
  try {
    const { paiement } = await api("/api/paiements/verifier", { method: "POST", body: { id } });
    if (paiement.statut === "paye") showToast(`Paiement en ligne confirmé : ${formatFCFA(paiement.montantFCFA)} crédités au portefeuille.`);
    else if (paiement.statut === "echec") showToast("Le paiement en ligne a échoué. Vous pouvez réessayer.", "error");
    else if (paiement.statut === "en_attente") showToast("Paiement en attente de confirmation par SasPay : actualisez dans un instant.");
  } catch (error) {
    showToast(errorMessage(error), "error");
  }
}

async function reglerAbonnement(event) {
  const button = event.currentTarget;
  setButtonLoading(button, true, "Règlement…");
  try {
    const data = await api("/api/facturation/abonnement", { method: "POST", body: {} });
    facturation = { ...facturation, ...data.facturation };
    renderAll();
    showToast("Abonnement du mois réglé depuis le portefeuille.");
  } catch (error) {
    showToast(errorMessage(error), "error");
    setButtonLoading(button, false);
  }
}

async function boot() {
  mountLayout();
  const user = await requireAgency();
  if (!user) return;
  const agency = await initAgencyLayout(user, "abonnement");
  if (!agency) return;
  document.getElementById("refreshAbonnement")?.addEventListener("click", charger);
  document.getElementById("rechargeEnLigneForm")?.addEventListener("submit", rechargerEnLigne);
  try {
    const { configuration } = await api(`/api/paiements?_=${Date.now()}`);
    paiementsEnLigne = configuration || paiementsEnLigne;
  } catch {
    // Paiement en ligne indisponible : le portefeuille reste rechargeable par la console.
  }
  const retour = getQueryParam("paiement");
  if (retour) await verifierRetourPaiement(retour);
  await charger();
}

boot();
