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
  const { periode, resume, portefeuille, plan, planSuivant, prixNegocieFCFA } = facturation;
  document.getElementById("planActuel").textContent = libellePlan(plan);
  document.getElementById("planDetail").textContent = planSuivant
    ? `Passage au plan ${libellePlan(planSuivant)} le 1er ${libellePeriode(periodeSuivante(periode.cle))}`
    : plan === "reseau" && prixNegocieFCFA !== null
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

const RANG_PLAN = { gratuit: 0, pro: 1, reseau: 2 };

function boutonPlan(plan) {
  const { plan: actuel, planSuivant, peutModifier, prixNegocieFCFA } = facturation;
  if (plan.id === actuel) {
    if (planSuivant && peutModifier) {
      return `<button class="button button-outline" type="button" data-plan="${escapeHTML(plan.id)}">Garder le plan ${escapeHTML(plan.label)}</button>`;
    }
    return '<span class="plan-current">Plan actuel</span>';
  }
  if (plan.surDevis) {
    return `<a class="button button-outline" href="${LIEN_DEVIS_RESEAU}" target="_blank" rel="noopener noreferrer">Demander un devis</a>`;
  }
  if (actuel === "reseau" && prixNegocieFCFA !== null) return '<span class="muted-note">Plan géré par Shopin30</span>';
  if (planSuivant === plan.id) return '<span class="plan-current">Programmé le mois prochain</span>';
  if (!peutModifier) return '<span class="muted-note">Réservé au gérant</span>';
  const estMontee = (RANG_PLAN[plan.id] ?? 0) > (RANG_PLAN[actuel] ?? 0);
  const libelle = estMontee ? `Passer au ${plan.label}` : `Revenir au ${plan.label} le mois prochain`;
  return `<button class="button ${estMontee ? "button-primary" : "button-outline"}" type="button" data-plan="${escapeHTML(plan.id)}">${escapeHTML(libelle)}</button>`;
}

const AVANTAGES_PLAN = {
  gratuit: [
    "50 colis expédiés inclus chaque mois",
    "Réception de colis 100 % gratuite et illimitée",
    "100 FCFA / colis supplémentaire sur le portefeuille",
    "Reçu QR, ticket 58 mm, caisse et bordereaux"
  ],
  pro: [
    "400 colis expédiés inclus chaque mois (25 FCFA/colis)",
    "Activation immédiate en 1 clic (délai de paiement 7 jours)",
    "Comptes multi-agents nominatifs & suivi personnalisé (logo)",
    "Relevé comptable PDF mensuel & 100 FCFA/colis hors forfait"
  ],
  reseau: [
    "1 000 colis expédiés inclus chaque mois (15 FCFA/colis)",
    "Activation immédiate en 1 clic (15 000 FCFA/mois)",
    "Déploiement multi-gares & compagnies de transport",
    "Relevé PDF mensuel, 100 FCFA/colis hors forfait & support prioritaire"
  ]
};

function renderPlans() {
  const target = document.getElementById("plansGrid");
  target.innerHTML = IDS_PLANS.map((id) => {
    const plan = facturation.plans[id];
    const courant = id === facturation.plan;
    const avantages = (AVANTAGES_PLAN[id] || []).map((item) => `<li>${escapeHTML(item)}</li>`).join("");
    return `<article class="plan-card${courant ? " plan-card-current" : ""}">
      <div class="plan-card-head"><h3>${escapeHTML(plan.label)}</h3><strong>${escapeHTML(prixPlan(plan))}</strong></div>
      <p>${escapeHTML(plan.description)}</p>
      <ul class="pricing-features plan-card-features">${avantages}</ul>
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

const MOIS_ANNEE = [
  { code: "01", nom: "Janvier" },
  { code: "02", nom: "Février" },
  { code: "03", nom: "Mars" },
  { code: "04", nom: "Avril" },
  { code: "05", nom: "Mai" },
  { code: "06", nom: "Juin" },
  { code: "07", nom: "Juillet" },
  { code: "08", nom: "Août" },
  { code: "09", nom: "Septembre" },
  { code: "10", nom: "Octobre" },
  { code: "11", nom: "Novembre" },
  { code: "12", nom: "Décembre" }
];

function clePeriodeCourante() {
  const brute = typeof facturation?.periode === "string"
    ? facturation.periode
    : facturation?.periode?.cle || facturation?.periodes?.[0]?.cle || "";
  if (typeof brute === "string" && /^\d{4}-\d{2}$/.test(brute)) return brute;
  return new Date().toISOString().slice(0, 7);
}

function anneesDisponibles() {
  const maintenant = new Date();
  const anneeCourante = Number(clePeriodeCourante().slice(0, 4)) || maintenant.getUTCFullYear();
  const set = new Set([anneeCourante - 2, anneeCourante - 1, anneeCourante, anneeCourante + 1]);
  for (const item of facturation?.periodes || []) {
    const annee = Number(String(item?.cle || "").slice(0, 4));
    if (annee >= 2020 && annee <= 2100) set.add(annee);
  }
  return [...set].sort((a, b) => b - a);
}

function synchroniserReleveDepuisMoisAnnee() {
  const selectMois = document.getElementById("releveMois");
  const selectAnnee = document.getElementById("releveAnnee");
  const selectPeriode = document.getElementById("relevePeriode");
  if (!selectMois || !selectAnnee || !selectPeriode) return;
  const annee = selectAnnee.value;
  const mois = selectMois.value;
  const cible = `${annee}-${mois}`;
  const periodesMap = new Map((facturation?.periodes || []).map((item) => [item.cle, item]));

  selectPeriode.innerHTML = MOIS_ANNEE.map((m) => {
    const cle = `${annee}-${m.code}`;
    const hist = periodesMap.get(cle);
    const detail = hist ? ` (${hist.compteur} colis)` : "";
    return `<option value="${escapeHTML(cle)}">${escapeHTML(libellePeriode(cle))}${escapeHTML(detail)}</option>`;
  }).join("");
  selectPeriode.value = cible;
  renderGrilleDouzeMois(annee, mois, periodesMap);
}

function renderGrilleDouzeMois(annee, moisActif, periodesMap) {
  const grid = document.getElementById("releveMonthsGrid");
  if (!grid) return;
  const periodeCourante = clePeriodeCourante();
  grid.innerHTML = MOIS_ANNEE.map((m) => {
    const cle = `${annee}-${m.code}`;
    const hist = periodesMap.get(cle);
    const estActif = m.code === moisActif;
    const estCourant = cle === periodeCourante;
    const resume = hist
      ? `${hist.compteur} colis · ${libellePlan(hist.plan)}`
      : estCourant
        ? "Mois en cours"
        : "Relevé disponible";
    return `<div class="releve-month-card${estActif ? " releve-month-active" : ""}${hist ? " releve-month-has-data" : ""}" data-select-periode="${escapeHTML(cle)}">
      <div class="releve-month-top">
        <strong>${escapeHTML(m.nom)} ${escapeHTML(annee)}</strong>
        ${estCourant ? '<span class="releve-month-badge">En cours</span>' : hist ? `<span class="releve-month-badge">${hist.compteur} colis</span>` : ""}
      </div>
      <small>${escapeHTML(resume)}</small>
      <div class="releve-month-actions">
        <button class="button button-small ${estActif ? "button-primary" : "button-outline"}" type="button" data-download-periode="${escapeHTML(cle)}">⬇ PDF ${escapeHTML(m.nom)}</button>
      </div>
    </div>`;
  }).join("");
}

function renderReleves() {
  const selectPeriode = document.getElementById("relevePeriode");
  const selectMois = document.getElementById("releveMois");
  const selectAnnee = document.getElementById("releveAnnee");
  const button = document.getElementById("telechargerReleveButton");
  if (!selectPeriode || !button) return;

  const valeurSelect = typeof selectPeriode.value === "string" && /^\d{4}-\d{2}$/.test(selectPeriode.value)
    ? selectPeriode.value
    : "";
  const defautPeriode = valeurSelect || clePeriodeCourante();
  const parties = String(defautPeriode).split("-");
  const defautAnnee = parties[0] || String(new Date().getUTCFullYear());
  const defautMois = parties[1] || "01";
  const annees = anneesDisponibles();

  if (selectMois) {
    selectMois.innerHTML = MOIS_ANNEE.map(
      (m) => `<option value="${escapeHTML(m.code)}">${escapeHTML(m.code)} — ${escapeHTML(m.nom)}</option>`
    ).join("");
    selectMois.value = MOIS_ANNEE.some((m) => m.code === defautMois) ? defautMois : "01";
  }
  if (selectAnnee) {
    selectAnnee.innerHTML = annees.map((a) => `<option value="${a}">${a}</option>`).join("");
    selectAnnee.value = annees.includes(Number(defautAnnee)) ? String(defautAnnee) : String(annees[0]);
  }
  synchroniserReleveDepuisMoisAnnee();
  button.disabled = false;
}

async function telechargerRelevePeriode(periode, boutonSource) {
  const button = boutonSource || document.getElementById("telechargerReleveButton");
  if (!periode) return;
  setButtonLoading(button, true, "Génération…");
  try {
    const response = await fetch(`/api/facturation/releve?periode=${encodeURIComponent(periode)}`, { credentials: "same-origin" });
    if (!response.ok) {
      const donnees = await response.json().catch(() => ({}));
      const error = new Error(donnees.error || "Le relevé n'a pas pu être généré.");
      error.status = response.status;
      throw error;
    }
    const fichier = URL.createObjectURL(await response.blob());
    const lien = document.createElement("a");
    lien.href = fichier;
    lien.download = `releve-colisexpress-${periode}.pdf`;
    document.body.append(lien);
    lien.click();
    lien.remove();
    window.setTimeout(() => URL.revokeObjectURL(fichier), 1000);
    showToast(`Relevé ${libellePeriode(periode)} (${periode}) téléchargé.`);
  } catch (error) {
    showPageMessage(message, errorMessage(error));
  } finally {
    setButtonLoading(button, false);
  }
}

async function telechargerReleve(event) {
  event.preventDefault();
  const periode = document.getElementById("relevePeriode").value;
  await telechargerRelevePeriode(periode, document.getElementById("telechargerReleveButton"));
}

function renderAll() {
  if (!facturation) return;
  renderSynthese();
  renderPlans();
  renderEcheances();
  renderMouvements();
  renderPeriodes();
  renderReleves();
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
  const estMontee = (RANG_PLAN[plan] ?? 0) > (RANG_PLAN[facturation.plan] ?? 0);
  const confirmation = plan === "pro" && estMontee
    ? "Passer au plan Pro : 10 000 FCFA par mois, 400 colis inclus (puis 100 FCFA/colis). L'abonnement de ce mois est prélevé sur le portefeuille dès que le solde le permet (échéance sous 7 jours). Confirmer ?"
    : plan === "reseau" && estMontee
      ? "Passer au plan Réseau : 15 000 FCFA par mois, 1 000 colis inclus (puis 100 FCFA/colis). L'abonnement de ce mois est prélevé sur le portefeuille dès que le solde le permet (échéance sous 7 jours). Confirmer ?"
      : !estMontee && plan !== facturation.plan
        ? `Revenir au plan ${libellePlan(plan)} au 1er du mois prochain ? Le mois en cours reste au plan actuel.`
        : null;
  if (confirmation && !window.confirm(confirmation)) return;
  setButtonLoading(button, true, "Enregistrement…");
  try {
    const data = await api("/api/facturation/plan", { method: "POST", body: { plan } });
    facturation = { ...facturation, ...data.facturation };
    renderAll();
    showToast(
      data.effet === "immediat"
        ? `Votre agence est passée au plan ${libellePlan(plan)}.`
        : data.effet === "annulation"
          ? "Le changement de plan programmé est annulé."
          : `Le passage au plan ${libellePlan(plan)} est programmé pour le mois prochain.`
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
  document.getElementById("releveForm")?.addEventListener("submit", telechargerReleve);
  document.getElementById("releveMois")?.addEventListener("change", synchroniserReleveDepuisMoisAnnee);
  document.getElementById("releveAnnee")?.addEventListener("change", synchroniserReleveDepuisMoisAnnee);
  document.getElementById("relevePeriode")?.addEventListener("change", (event) => {
    const [annee, mois] = String(event.target.value || "").split("-");
    const selectMois = document.getElementById("releveMois");
    const selectAnnee = document.getElementById("releveAnnee");
    if (selectAnnee && annee) selectAnnee.value = annee;
    if (selectMois && mois) selectMois.value = mois;
    synchroniserReleveDepuisMoisAnnee();
  });
  document.getElementById("releveMonthsGrid")?.addEventListener("click", (event) => {
    const downloadBtn = event.target.closest("[data-download-periode]");
    if (downloadBtn) {
      const periode = downloadBtn.dataset.downloadPeriode;
      const [annee, mois] = periode.split("-");
      const selectMois = document.getElementById("releveMois");
      const selectAnnee = document.getElementById("releveAnnee");
      if (selectAnnee && annee) selectAnnee.value = annee;
      if (selectMois && mois) selectMois.value = mois;
      synchroniserReleveDepuisMoisAnnee();
      telechargerRelevePeriode(periode, downloadBtn);
      return;
    }
    const card = event.target.closest("[data-select-periode]");
    if (card) {
      const [annee, mois] = card.dataset.selectPeriode.split("-");
      const selectMois = document.getElementById("releveMois");
      const selectAnnee = document.getElementById("releveAnnee");
      if (selectAnnee && annee) selectAnnee.value = annee;
      if (selectMois && mois) selectMois.value = mois;
      synchroniserReleveDepuisMoisAnnee();
    }
  });
  document.getElementById("rechargeEnLigneForm")?.addEventListener("submit", rechargerEnLigne);
  document.getElementById("quickRechargeAmounts")?.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-quick-recharge]");
    if (!chip) return;
    const input = document.getElementById("rechargeMontant");
    if (input) {
      input.value = chip.dataset.quickRecharge;
      input.focus();
    }
  });
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
