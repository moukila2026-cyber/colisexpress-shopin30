import { api } from "./api.js";
import { requireAgency } from "./auth.js";
import { agencySidebar, initAgencyLayout, mobileAgencyHeader } from "./layout.js";
import {
  clearPageMessage,
  errorMessage,
  isValidIvorianPhone,
  normalizeIvorianPhone,
  setButtonLoading,
  showPageMessage,
  showToast
} from "./utils.js";

const form = document.getElementById("agencyForm");
const message = document.getElementById("pageMessage");

function mountLayout() {
  document.getElementById("sidebarMount").innerHTML = agencySidebar();
  document.getElementById("topbarMount").innerHTML = mobileAgencyHeader("Paramètres");
}

async function boot() {
  mountLayout();
  const user = await requireAgency();
  if (!user) return;
  const agency = await initAgencyLayout(user, "parametres");
  if (!agency) return;

  form.elements.name.value = agency.name || "";
  form.elements.city.value = agency.city || "";
  form.elements.phone.value = agency.phone || "";
  form.elements.email.value = agency.email || "";

  form.addEventListener("submit", saveAgency);
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
