/*
 * Page de paiement SIMULÉE (LOT 7) : remplace la page hébergée SasPay tant
 * qu'aucune clé n'est configurée. Le résultat choisi passe par le serveur
 * (POST /api/paiements/simulation, refusé dès qu'une clé SasPay existe), qui
 * applique le paiement par le même chemin de vérification qu'en réel.
 */
import { api } from "./api.js";
import { libelleObjetPaiement, libelleStatutPaiement } from "./metier-paiements.js";
import { errorMessage, escapeHTML, formatFCFA, getQueryParam, redirectToLogin, setButtonLoading, showPageMessage } from "./utils.js";

const message = document.getElementById("pageMessage");
const details = document.getElementById("simulationDetails");
const actions = document.getElementById("simulationActions");
const retourLien = document.getElementById("retourLien");
const id = getQueryParam("id");
let paiement = null;

function retourInterne(chemin) {
  // Seuls les chemins internes construits par le serveur sont suivis.
  return /^\/(colis|abonnement)\.html\?[A-Za-z0-9=&%._-]+$/.test(chemin || "") ? chemin.slice(1) : "dashboard.html";
}

function render() {
  details.innerHTML = `
    <div><dt>Objet</dt><dd>${escapeHTML(libelleObjetPaiement(paiement.objet))}</dd></div>
    <div><dt>Détail</dt><dd>${escapeHTML(paiement.libelle)}</dd></div>
    <div><dt>Montant</dt><dd><strong>${escapeHTML(formatFCFA(paiement.montantFCFA))}</strong></dd></div>
    <div><dt>Statut</dt><dd>${escapeHTML(libelleStatutPaiement(paiement.statut))}</dd></div>`;
  retourLien.href = retourInterne(paiement.retour);
  actions.hidden = !["en_attente", "echec"].includes(paiement.statut);
}

async function simuler(resultat, bouton) {
  setButtonLoading(bouton, true, "Traitement…");
  try {
    const data = await api("/api/paiements/simulation", { method: "POST", body: { id, resultat } });
    paiement = data.paiement;
    window.location.href = retourInterne(paiement.retour);
  } catch (error) {
    showPageMessage(message, errorMessage(error));
    setButtonLoading(bouton, false);
  }
}

async function boot() {
  if (!id) {
    showPageMessage(message, "Aucun paiement n'est indiqué.");
    return;
  }
  try {
    const data = await api(`/api/paiements?id=${encodeURIComponent(id)}`);
    paiement = data.paiement;
    if (paiement.mode !== "simulation") {
      showPageMessage(message, "Ce paiement n'est pas une simulation : utilisez la page de paiement SasPay.");
      return;
    }
    render();
  } catch (error) {
    if (error.status === 401) {
      redirectToLogin();
      return;
    }
    showPageMessage(message, errorMessage(error));
  }
  document.getElementById("simulerSucces").addEventListener("click", (event) => simuler("succes", event.currentTarget));
  document.getElementById("simulerEchec").addEventListener("click", (event) => simuler("echec", event.currentTarget));
}

boot();
