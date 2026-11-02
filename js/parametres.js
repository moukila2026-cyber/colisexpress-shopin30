import { api } from "./api.js";
import { requireAgency } from "./auth.js";
import { agencySidebar, initAgencyLayout, mobileAgencyHeader } from "./layout.js";
import { TRANCHES_DEFAUT, construireAxesCourants, trancheLibelle, validerTarif } from "./metier-tarifs.js";
import { initMarque } from "./parametres-marque.js";
import {
  clearPageMessage,
  errorMessage,
  escapeHTML,
  formatFCFA,
  initPasswordToggles,
  isValidIvorianPhone,
  normalizeIvorianPhone,
  setButtonLoading,
  showPageMessage,
  showToast,
  whatsappShareLink
} from "./utils.js";

const form = document.getElementById("agencyForm");
const message = document.getElementById("pageMessage");
const agentForm = document.getElementById("agentForm");
const teamMessage = document.getElementById("teamMessage");
const agentsList = document.getElementById("agentsList");
const tarifForm = document.getElementById("tarifForm");
const tarifsList = document.getElementById("tarifsList");
const tarifMessage = document.getElementById("tarifMessage");

let currentMember = null;
let tarifs = [];
let tarifEnEdition = null;

function mountLayout() {
  document.getElementById("sidebarMount").innerHTML = agencySidebar();
  document.getElementById("topbarMount").innerHTML = mobileAgencyHeader("Paramètres");
}

/* -------------------------------- équipe ---------------------------------- */

const LABELS_FORFAIT = { gratuit: "Gratuit", pro: "Pro", reseau: "Réseau" };

function roleBadge(agent) {
  if (agent.isOwner) {
    return '<span class="status-badge status-gerant">Gérant fondateur</span>';
  }
  return agent.role === "gerant"
    ? '<span class="status-badge status-gerant">Gérant de point</span>'
    : '<span class="status-badge status-agent">Agent</span>';
}

function renderQuotaGerants(quotaGerants, points = []) {
  const banner = document.getElementById("gerantsQuotaBanner");
  const roleSelect = document.getElementById("agentRole");
  const optionGerant = document.getElementById("agentRoleGerantOption");
  if (!banner || !quotaGerants) return;

  const planNom = LABELS_FORFAIT[quotaGerants.plan] || quotaGerants.plan || "Gratuit";
  const maxTexte = quotaGerants.quotaGerants === null
    ? `${quotaGerants.gerantsActifs} gérant${quotaGerants.gerantsActifs > 1 ? "s" : ""} invité${quotaGerants.gerantsActifs > 1 ? "s" : ""} · Illimité (Forfait Réseau)`
    : `${quotaGerants.gerantsActifs} / ${quotaGerants.quotaGerants} gérant${quotaGerants.quotaGerants > 1 ? "s" : ""} invité${quotaGerants.quotaGerants > 1 ? "s" : ""} (Forfait ${planNom})`;

  const pointsHtml = points.length
    ? points.map((p) => `<span class="point-chip">${escapeHTML(p.city)}${p.isHeadquarters ? " (Siège)" : ""} · ${p.gerantsCount} gérant${p.gerantsCount > 1 ? "s" : ""}${p.agentsCount ? `, ${p.agentsCount} agent${p.agentsCount > 1 ? "s" : ""}` : ""}</span>`).join("")
    : "";

  const peutInviter = Boolean(currentMember?.isOwner && quotaGerants.peutInviterGerant);
  if (optionGerant && roleSelect) {
    if (!currentMember?.isOwner) {
      optionGerant.disabled = true;
      optionGerant.textContent = "Gérant de point (réservé au créateur de l'agence)";
      roleSelect.value = "agent";
    } else if (!quotaGerants.peutInviterGerant) {
      optionGerant.disabled = true;
      optionGerant.textContent = `Gérant de point (limite ${quotaGerants.gerantsActifs}/${quotaGerants.quotaGerants} atteinte sur ${planNom})`;
      roleSelect.value = "agent";
    } else {
      optionGerant.disabled = false;
      const reste = quotaGerants.restants === null ? "illimité" : `${quotaGerants.restants} place${quotaGerants.restants > 1 ? "s" : ""} disponible${quotaGerants.restants > 1 ? "s" : ""}`;
      optionGerant.textContent = `Gérant de point / Co-gérant (${reste})`;
    }
  }

  banner.hidden = false;
  banner.className = `gerants-quota-banner${!peutInviter && currentMember?.isOwner ? " gerants-quota-plein" : ""}`;
  banner.innerHTML = `
    <div class="gerants-quota-head">
      <div>
        <strong>Quota de gérants centralisé : ${escapeHTML(maxTexte)}</strong>
        <p>${
          quotaGerants.peutInviterGerant
            ? "Tous vos points d'envoi et de réception en Côte d'Ivoire partagent le forfait, le portefeuille et la traçabilité de l'agence."
            : escapeHTML(quotaGerants.messageQuota || "La limite de gérants de votre forfait actuel est atteinte.")
        }</p>
      </div>
      ${
        quotaGerants.quotaGerants !== null
          ? `<a class="button button-small ${quotaGerants.peutInviterGerant ? "button-outline" : "button-orange"}" href="abonnement.html#plansSection">${
              quotaGerants.plan === "gratuit" ? "Passer au Pro (5 gérants) ou Réseau (illimité)" : "Passer au Réseau (gérants illimités)"
            }</a>`
          : ""
      }
    </div>
    ${pointsHtml ? `<div class="gerants-points-row"><small>Points d'envoi &amp; réception actifs en CI :</small><div class="gerants-points-list">${pointsHtml}</div></div>` : ""}
  `;
}

function renderAgents(agents) {
  const peutGerer = currentMember?.role === "gerant";
  const estFondateur = currentMember?.isOwner === true;
  const villeAgence = document.getElementById("settingsCity")?.value?.trim() || "—";
  agentsList.innerHTML = `<div class="table-wrap"><table class="parcel-table agents-table">
    <thead><tr><th>Nom</th><th>Point / Ville (CI)</th><th>Contact</th><th>Rôle</th><th>Statut</th>${peutGerer ? "<th></th>" : ""}</tr></thead>
    <tbody>${agents.map((agent) => {
      const estFondateurLigne = Boolean(agent.isOwner);
      const peutBasculer = !estFondateurLigne && (estFondateur || (peutGerer && agent.role === "agent"));
      const villeMembre = agent.city || villeAgence;
      return `<tr>
        <td><strong>${escapeHTML(agent.name)}</strong>${estFondateurLigne ? '<br><small class="muted-note">Créateur &amp; compte principal de l\'agence</small>' : ""}</td>
        <td><span class="route-cell">${escapeHTML(villeMembre)}</span></td>
        <td>${escapeHTML(agent.email)}${agent.phone ? `<br><small>${escapeHTML(agent.phone)}</small>` : ""}</td>
        <td>${roleBadge(agent)}</td>
        <td>${agent.active ? '<span class="status-badge status-actif">Actif</span>' : '<span class="status-badge status-inactif">Inactif</span>'}</td>
        ${peutGerer ? `<td>${peutBasculer ? `<button class="button button-outline button-small" type="button" data-agent-toggle="${escapeHTML(agent.id)}" data-agent-role="${escapeHTML(agent.role)}" data-agent-active="${agent.active}">${agent.active ? "Désactiver" : "Réactiver"}</button>` : ""}</td>` : ""}
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

async function chargerEquipe() {
  try {
    const { agents, quotaGerants, points } = await api("/api/agents");
    renderQuotaGerants(quotaGerants, points || []);
    renderAgents(agents);
  } catch (error) {
    showPageMessage(teamMessage, errorMessage(error));
  }
}

async function inviterAgent(event) {
  event.preventDefault();
  clearPageMessage(teamMessage);
  const values = Object.fromEntries(new FormData(agentForm));
  const name = (values.name || "").trim();
  const email = (values.email || "").trim().toLowerCase();
  const phone = normalizeIvorianPhone(values.phone || "");
  const password = values.password || "";
  const role = values.role === "gerant" ? "gerant" : "agent";
  const city = (values.city || "").trim() || document.getElementById("settingsCity")?.value?.trim() || "";
  const labelRole = role === "gerant" ? "gérant" : "agent";

  if (name.length < 2) {
    showPageMessage(teamMessage, `Le nom du ${labelRole} doit contenir au moins 2 caractères.`);
    return;
  }
  if (city && city.length < 2) {
    showPageMessage(teamMessage, "Indiquez la ville du point d'envoi/réception (au moins 2 caractères).");
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showPageMessage(teamMessage, "L'adresse e-mail saisie n'est pas valide.");
    return;
  }
  if ((values.phone || "").trim() && !isValidIvorianPhone(phone)) {
    showPageMessage(teamMessage, "Saisissez un téléphone ivoirien valide (10 chiffres), ou laissez vide.");
    return;
  }
  if (password.length < 6) {
    showPageMessage(teamMessage, "Le mot de passe provisoire doit contenir au moins 6 caractères.");
    return;
  }

  const button = document.getElementById("saveAgentButton");
  setButtonLoading(button, true, "Invitation…");
  try {
    await api("/api/agents", {
      method: "POST",
      body: { name, email, phone: (values.phone || "").trim(), password, role, city }
    });
    agentForm.reset();
    const cityInput = document.getElementById("agentCity");
    if (cityInput) cityInput.value = document.getElementById("settingsCity")?.value?.trim() || "";
    const loginUrl = new URL("connexion.html", window.location.href).href;
    const agencyName = document.getElementById("settingsName")?.value?.trim() || "votre agence";
    const pointInfo = city ? ` (point ${city})` : "";
    const waText = `Bonjour ${name}, votre compte ${labelRole} COLIS EXPRESS pour l'agence ${agencyName}${pointInfo} est prêt. Connectez-vous sur ${loginUrl} avec l'e-mail ${email} et le mot de passe provisoire : ${password}`;
    const waHref = whatsappShareLink(phone, waText);
    if (teamMessage) {
      teamMessage.className = "page-message page-message-success agent-credentials-banner";
      teamMessage.innerHTML = `<span>${role === "gerant" ? "Gérant" : "Agent"} <strong>${escapeHTML(name)}</strong>${city ? ` (${escapeHTML(city)})` : ""} ajouté à l'équipe (${escapeHTML(email)}).</span><span class="agent-credentials-actions"><a class="button button-whatsapp button-small" target="_blank" rel="noopener noreferrer" href="${escapeHTML(waHref)}">◉ Envoyer ses accès sur WhatsApp</a></span>`;
      teamMessage.hidden = false;
    }
    showToast(`${role === "gerant" ? "Gérant" : "Agent"} ${name} ajouté à l'équipe.`);
    await chargerEquipe();
  } catch (error) {
    showPageMessage(teamMessage, errorMessage(error));
  } finally {
    setButtonLoading(button, false);
  }
}

async function basculerAgent(button) {
  const agentId = button.dataset.agentToggle;
  const role = button.dataset.agentRole === "gerant" ? "Gérant" : "Agent";
  const actif = button.dataset.agentActive === "true";
  clearPageMessage(teamMessage);
  setButtonLoading(button, true, actif ? "Désactivation…" : "Réactivation…");
  try {
    await api(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      body: { active: !actif }
    });
    showToast(actif ? `${role} désactivé : il ne peut plus se connecter.` : `${role} réactivé.`);
    await chargerEquipe();
  } catch (error) {
    showPageMessage(teamMessage, errorMessage(error));
    setButtonLoading(button, false);
  }
}

agentsList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-agent-toggle]");
  if (button) basculerAgent(button);
});

/* ----------------------------- grille tarifaire ---------------------------- */

function renderTarifs() {
  const peutGerer = currentMember?.role === "gerant";
  if (!tarifs.length) {
    tarifsList.innerHTML = '<div class="empty-inline">Votre grille est vide : le formulaire « nouveau colis » accepte alors la saisie libre du prix. Ajoutez une ligne ci-dessous pour standardiser vos tarifs.</div>';
    return;
  }
  tarifsList.innerHTML = `<div class="table-wrap"><table class="parcel-table tarifs-table">
    <thead><tr><th>Axe</th><th>Tranche</th><th>Prix</th><th>Statut</th>${peutGerer ? "<th></th>" : ""}</tr></thead>
    <tbody>${tarifs.map((tarif) => `<tr class="${tarif.active ? "" : "tarif-inactif"}">
      <td><strong>${escapeHTML(tarif.originCity)}</strong> → ${escapeHTML(tarif.destinationCity || "toutes destinations")}</td>
      <td>${escapeHTML(trancheLibelle(tarif.weightMinKg, tarif.weightMaxKg))}</td>
      <td><strong>${escapeHTML(formatFCFA(tarif.priceFCFA))}</strong></td>
      <td>${tarif.active ? '<span class="status-badge status-actif">Actif</span>' : '<span class="status-badge status-inactif">Hors grille</span>'}</td>
      ${peutGerer ? `<td class="tarif-actions">
        <button class="button button-outline button-small" type="button" data-tarif-edit="${escapeHTML(tarif.id)}">Modifier</button>
        <button class="button button-outline button-small" type="button" data-tarif-toggle="${escapeHTML(tarif.id)}" data-tarif-active="${tarif.active}">${tarif.active ? "Désactiver" : "Réactiver"}</button>
      </td>` : ""}
    </tr>`).join("")}</tbody>
  </table></div>`;
}

async function chargerTarifs() {
  try {
    const data = await api("/api/tarifs");
    tarifs = data.tarifs || [];
    renderTarifs();
  } catch (error) {
    showPageMessage(tarifMessage, errorMessage(error));
  }
}

function reinitialiserFormulaireTarif() {
  tarifEnEdition = null;
  tarifForm.reset();
  document.getElementById("tarifFormTitle").textContent = "Ajouter un tarif";
  document.getElementById("tarifSubmitButton").textContent = "Ajouter à la grille";
  document.getElementById("tarifCancelButton").hidden = true;
  document.getElementById("tarifCustomBand").hidden = document.getElementById("tarifBand").value !== "libre";
}

function lireTarifFormulaire() {
  const originCity = document.getElementById("tarifOriginCity").value;
  const toutesDestinations = document.getElementById("tarifAllDestinations").checked;
  const destinationCity = toutesDestinations ? "" : document.getElementById("tarifDestinationCity").value;
  const bande = document.getElementById("tarifBand").value;
  let weightMinKg;
  let weightMaxKg;
  if (bande === "libre") {
    weightMinKg = document.getElementById("tarifWeightMin").value;
    weightMaxKg = document.getElementById("tarifWeightMax").value;
  } else {
    const tranche = TRANCHES_DEFAUT.find((item) => item.cle === bande);
    weightMinKg = tranche.minKg;
    weightMaxKg = tranche.maxKg;
  }
  return {
    originCity,
    destinationCity,
    weightMinKg,
    weightMaxKg,
    priceFCFA: document.getElementById("tarifPrice").value
  };
}

async function sauvegarderTarif(event) {
  event.preventDefault();
  clearPageMessage(tarifMessage);
  const brut = lireTarifFormulaire();
  const controle = validerTarif(brut);
  if (controle.error) {
    showPageMessage(tarifMessage, controle.error);
    return;
  }
  const button = document.getElementById("tarifSubmitButton");
  setButtonLoading(button, true, tarifEnEdition ? "Mise à jour…" : "Ajout…");
  try {
    if (tarifEnEdition) {
      await api(`/api/tarifs/${encodeURIComponent(tarifEnEdition)}`, { method: "PATCH", body: controle.valeur });
      showToast("Tarif mis à jour.");
    } else {
      await api("/api/tarifs", { method: "POST", body: controle.valeur });
      showToast("Tarif ajouté à la grille.");
    }
    reinitialiserFormulaireTarif();
    await chargerTarifs();
  } catch (error) {
    showPageMessage(tarifMessage, errorMessage(error));
  } finally {
    setButtonLoading(button, false);
  }
}

function editerTarif(id) {
  const tarif = tarifs.find((item) => item.id === id);
  if (!tarif) return;
  tarifEnEdition = id;
  document.getElementById("tarifOriginCity").value = tarif.originCity;
  document.getElementById("tarifAllDestinations").checked = !tarif.destinationCity;
  document.getElementById("tarifDestinationCity").value = tarif.destinationCity;
  document.getElementById("tarifDestinationCity").disabled = !tarif.destinationCity;
  document.getElementById("tarifPrice").value = String(tarif.priceFCFA);
  const predefinie = TRANCHES_DEFAUT.find(
    (item) => item.minKg === tarif.weightMinKg && item.maxKg === (tarif.weightMaxKg ?? null)
  );
  if (predefinie) {
    document.getElementById("tarifBand").value = predefinie.cle;
    document.getElementById("tarifCustomBand").hidden = true;
  } else {
    document.getElementById("tarifBand").value = "libre";
    document.getElementById("tarifCustomBand").hidden = false;
    document.getElementById("tarifWeightMin").value = String(tarif.weightMinKg);
    document.getElementById("tarifWeightMax").value = tarif.weightMaxKg === null || tarif.weightMaxKg === undefined ? "" : String(tarif.weightMaxKg);
  }
  document.getElementById("tarifFormTitle").textContent = "Modifier un tarif";
  document.getElementById("tarifSubmitButton").textContent = "Mettre à jour";
  document.getElementById("tarifCancelButton").hidden = false;
  tarifForm.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function basculerTarif(button) {
  const id = button.dataset.tarifToggle;
  const actif = button.dataset.tarifActive === "true";
  clearPageMessage(tarifMessage);
  setButtonLoading(button, true, actif ? "Désactivation…" : "Réactivation…");
  try {
    await api(`/api/tarifs/${encodeURIComponent(id)}`, { method: "PATCH", body: { active: !actif } });
    showToast(actif ? "Tarif retiré de la grille (le prix reste sur les colis enregistrés)." : "Tarif réactivé dans la grille.");
    await chargerTarifs();
  } catch (error) {
    showPageMessage(tarifMessage, errorMessage(error));
    setButtonLoading(button, false);
  }
}

tarifsList?.addEventListener("click", (event) => {
  const edit = event.target.closest("[data-tarif-edit]");
  if (edit) return editerTarif(edit.dataset.tarifEdit);
  const toggle = event.target.closest("[data-tarif-toggle]");
  if (toggle) basculerTarif(toggle);
});

async function preRemplirAxesCourants() {
  const button = document.getElementById("seedDefaultTarifsButton");
  if (!button) return;
  clearPageMessage(tarifMessage);
  const originCity = document.getElementById("settingsCity")?.value?.trim() || document.getElementById("tarifOriginCity")?.value?.trim() || "Daloa";
  const aCreer = construireAxesCourants({ originCity, existingTarifs: tarifs });
  if (!aCreer.length) {
    showToast(`Tous les axes courants au départ de ${originCity} figurent déjà dans votre grille.`, "info");
    return;
  }
  setButtonLoading(button, true, "Création des tarifs…");
  try {
    let ajoutes = 0;
    for (const ligne of aCreer) {
      await api("/api/tarifs", { method: "POST", body: ligne });
      ajoutes += 1;
    }
    showToast(`${ajoutes} lignes tarifaires ajoutées au départ de ${originCity}. Vous pouvez ajuster chaque prix.`);
    await chargerTarifs();
  } catch (error) {
    showPageMessage(tarifMessage, errorMessage(error));
  } finally {
    setButtonLoading(button, false);
  }
}

tarifForm?.addEventListener("submit", sauvegarderTarif);
document.getElementById("seedDefaultTarifsButton")?.addEventListener("click", preRemplirAxesCourants);
document.getElementById("tarifCancelButton")?.addEventListener("click", reinitialiserFormulaireTarif);
document.getElementById("tarifBand")?.addEventListener("change", (event) => {
  document.getElementById("tarifCustomBand").hidden = event.target.value !== "libre";
});
document.getElementById("tarifAllDestinations")?.addEventListener("change", (event) => {
  const champ = document.getElementById("tarifDestinationCity");
  champ.disabled = event.target.checked;
  if (event.target.checked) champ.value = "";
});

/* ------------------------------ profil agence ----------------------------- */

async function boot() {
  mountLayout();
  initPasswordToggles();
  const user = await requireAgency();
  if (!user) return;
  currentMember = user.member || null;
  const agency = await initAgencyLayout(user, "parametres");
  if (!agency) return;

  form.elements.name.value = agency.name || "";
  form.elements.city.value = agency.city || "";
  form.elements.phone.value = agency.phone || "";
  form.elements.email.value = agency.email || "";

  form.addEventListener("submit", saveAgency);

  // Seul le gérant invite/désactive : le serveur applique la même règle.
  if (currentMember?.role === "gerant") {
    agentForm.hidden = false;
    const cityInput = document.getElementById("agentCity");
    if (cityInput && !cityInput.value) {
      cityInput.value = currentMember?.city || agency.city || "";
    }
    agentForm.addEventListener("submit", inviterAgent);
    tarifForm.hidden = false;
    const quickBar = document.getElementById("tarifsQuickBar");
    if (quickBar) quickBar.hidden = false;
  } else {
    agentsList.insertAdjacentHTML(
      "beforeend",
      '<p class="muted-note">Seul le gérant de l\'agence peut inviter ou désactiver des agents.</p>'
    );
    document.getElementById("tarifsList").insertAdjacentHTML(
      "beforeend",
      '<p class="muted-note">Seul le gérant de l\'agence peut modifier la grille tarifaire.</p>'
    );
  }
  await chargerEquipe();
  await chargerTarifs();
  // LOT 7 — personnalisation du suivi public (gérant ; garde serveur).
  await initMarque({ member: currentMember, agency });
}

async function saveAgency(event) {
  event.preventDefault();
  clearPageMessage(message);
  const values = Object.fromEntries(new FormData(form));
  const name = values.name.trim();
  const city = values.city.trim();
  const phone = normalizeIvorianPhone(values.phone);
  if (name.length < 2 || city.length < 2) {
    showPageMessage(message, "Le nom de l'agence et la ville sont obligatoires.");
    return;
  }
  if (!isValidIvorianPhone(phone)) {
    showPageMessage(message, "Saisissez un numéro ivoirien valide (10 chiffres, ex. 0700000000).");
    return;
  }

  const button = document.getElementById("saveAgencyButton");
  setButtonLoading(button, true, "Enregistrement…");
  try {
    await api("/api/me", { method: "PATCH", body: { name, city, phone } });
    document.querySelectorAll("[data-agency-name]").forEach((element) => { element.textContent = name; });
    document.querySelectorAll("[data-agency-city]").forEach((element) => { element.textContent = city; });
    document.querySelectorAll("[data-agency-initial]").forEach((element) => { element.textContent = name.charAt(0).toUpperCase(); });
    showToast("Informations de l'agence mises à jour.");
  } catch (error) {
    showPageMessage(message, errorMessage(error));
  } finally {
    setButtonLoading(button, false);
  }
}

boot();
