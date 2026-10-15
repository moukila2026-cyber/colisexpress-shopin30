import { api } from "./api.js";
import { requireAgency } from "./auth.js";
import { agencySidebar, initAgencyLayout, mobileAgencyHeader } from "./layout.js";
import {
  clearPageMessage,
  errorMessage,
  escapeHTML,
  isValidIvorianPhone,
  normalizeIvorianPhone,
  setButtonLoading,
  showPageMessage,
  showToast
} from "./utils.js";

const form = document.getElementById("agencyForm");
const message = document.getElementById("pageMessage");
const agentForm = document.getElementById("agentForm");
const teamMessage = document.getElementById("teamMessage");
const agentsList = document.getElementById("agentsList");

let currentMember = null;

function mountLayout() {
  document.getElementById("sidebarMount").innerHTML = agencySidebar();
  document.getElementById("topbarMount").innerHTML = mobileAgencyHeader("Paramètres");
}

/* -------------------------------- équipe ---------------------------------- */

function roleBadge(agent) {
  return agent.role === "gerant"
    ? '<span class="status-badge status-gerant">Gérant</span>'
    : '<span class="status-badge status-agent">Agent</span>';
}

function renderAgents(agents) {
  const peutGerer = currentMember?.role === "gerant";
  agentsList.innerHTML = `<div class="table-wrap"><table class="parcel-table agents-table">
    <thead><tr><th>Nom</th><th>Contact</th><th>Rôle</th><th>Statut</th>${peutGerer ? "<th></th>" : ""}</tr></thead>
    <tbody>${agents.map((agent) => {
      const estCompteGerant = agent.role === "gerant";
      return `<tr>
        <td><strong>${escapeHTML(agent.name)}</strong>${estCompteGerant ? '<br><small class="muted-note">Compte principal de l\'agence</small>' : ""}</td>
        <td>${escapeHTML(agent.email)}${agent.phone ? `<br><small>${escapeHTML(agent.phone)}</small>` : ""}</td>
        <td>${roleBadge(agent)}</td>
        <td>${agent.active ? '<span class="status-badge status-actif">Actif</span>' : '<span class="status-badge status-inactif">Inactif</span>'}</td>
        ${peutGerer && !estCompteGerant ? `<td><button class="button button-outline button-small" type="button" data-agent-toggle="${escapeHTML(agent.id)}" data-agent-active="${agent.active}">${agent.active ? "Désactiver" : "Réactiver"}</button></td>` : ""}
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

async function chargerEquipe() {
  try {
    const { agents } = await api("/api/agents");
    renderAgents(agents);
  } catch (error) {
    showPageMessage(teamMessage, errorMessage(error));
  }
}

async function inviterAgent(event) {
  event.preventDefault();
  clearPageMessage(teamMessage);
  const values = Object.fromEntries(new FormData(agentForm));
  const name = values.name.trim();
  const email = values.email.trim().toLowerCase();
  const phone = normalizeIvorianPhone(values.phone || "");
  const password = values.password;

  if (name.length < 2) {
    showPageMessage(teamMessage, "Le nom de l'agent doit contenir au moins 2 caractères.");
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showPageMessage(teamMessage, "L'adresse e-mail saisie n'est pas valide.");
    return;
  }
  if (values.phone.trim() && !isValidIvorianPhone(phone)) {
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
    await api("/api/agents", { method: "POST", body: { name, email, phone: values.phone.trim(), password } });
    agentForm.reset();
    showToast(`Agent ${name} ajouté à l'équipe. Transmettez-lui ses identifiants.`);
    await chargerEquipe();
  } catch (error) {
    showPageMessage(teamMessage, errorMessage(error));
  } finally {
    setButtonLoading(button, false);
  }
}

async function basculerAgent(button) {
  const agentId = button.dataset.agentToggle;
  const actif = button.dataset.agentActive === "true";
  clearPageMessage(teamMessage);
  setButtonLoading(button, true, actif ? "Désactivation…" : "Réactivation…");
  try {
    await api(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      body: { active: !actif }
    });
    showToast(actif ? "Agent désactivé : il ne peut plus se connecter." : "Agent réactivé.");
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

/* ------------------------------ profil agence ----------------------------- */

async function boot() {
  mountLayout();
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
    agentForm.addEventListener("submit", inviterAgent);
  } else {
    agentsList.insertAdjacentHTML(
      "beforeend",
      '<p class="muted-note">Seul le gérant de l\'agence peut inviter ou désactiver des agents.</p>'
    );
  }
  await chargerEquipe();
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
