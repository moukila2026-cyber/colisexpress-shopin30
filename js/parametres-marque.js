/*
 * Paramètres > Personnalisation du suivi (LOT 7). Le gérant choisit le nom
 * affiché, les couleurs et le logo de la page de suivi public de SES colis.
 * Le logo est redimensionné dans le navigateur (256 px) puis contrôlé par le
 * serveur (type réel, 300 Ko maximum). Garde serveur : gérant uniquement.
 */
import { api } from "./api.js";
import {
  COULEUR_ACCENT_DEFAUT,
  COULEUR_DEFAUT,
  MAX_LOGO_OCTETS,
  TYPES_LOGO,
  validerMarque,
  variablesMarque
} from "./metier-marque.js";
import { clearPageMessage, errorMessage, escapeHTML, setButtonLoading, showPageMessage, showToast } from "./utils.js";

const TAILLE_LOGO_PX = 256;

let etat = { marque: null, peutModifier: false, nomAgence: "", logoLocal: null, apercuCode: null };

function champs() {
  return {
    form: document.getElementById("marqueForm"),
    message: document.getElementById("marqueMessage"),
    apercu: document.getElementById("marqueApercu"),
    active: document.getElementById("marqueActive"),
    nom: document.getElementById("marqueNom"),
    couleur: document.getElementById("marqueCouleur"),
    couleur2: document.getElementById("marqueCouleur2"),
    logo: document.getElementById("marqueLogo"),
    retirer: document.getElementById("marqueRetirerLogo"),
    voir: document.getElementById("marqueVoir"),
    bouton: document.getElementById("saveMarqueButton")
  };
}

function valeursSaisies() {
  const c = champs();
  return { active: c.active.checked, nom: c.nom.value, couleur: c.couleur.value, couleur2: c.couleur2.value };
}

/** Aperçu en direct du bandeau tel qu'il apparaîtra sur le suivi public. */
function renderApercu() {
  const c = champs();
  const controle = validerMarque(valeursSaisies(), { nomAgence: etat.nomAgence });
  if (controle.error) return;
  const marque = controle.valeur;
  const source = c.retirer.checked ? null : etat.logoLocal || (etat.marque?.logo ? `/api/marque?logo=1&v=${encodeURIComponent(etat.marque.majISO || "")}` : null);
  const logo = source
    ? `<img class="tracking-brand-logo" src="${escapeHTML(source)}" alt="" width="52" height="52">`
    : `<span class="tracking-brand-initiale" aria-hidden="true">${escapeHTML(marque.nom.charAt(0).toUpperCase())}</span>`;
  c.apercu.innerHTML = `
    <p class="muted-note">Aperçu ${marque.active ? "" : "(personnalisation désactivée : le suivi garde les couleurs COLIS EXPRESS)"}</p>
    <div class="tracking-card tracking-card-marque marque-apercu-carte" style="${variablesMarque(marque)}">
      <div class="tracking-brand">${logo}<div><small>Colis confié à</small><strong>${escapeHTML(marque.nom)}</strong></div></div>
      <div class="marque-apercu-bas"><span class="status-badge status-en-transit">En transit</span><span class="marque-apercu-accent">Suivi en direct</span></div>
    </div>`;
}

/** Redimensionne le logo (256 px) et l'encode en PNG, ou WebP/JPEG si trop lourd. */
async function preparerLogo(fichier) {
  if (!TYPES_LOGO.includes(fichier.type)) throw new Error("Le logo doit être une image PNG, JPEG ou WebP.");
  const image = await createImageBitmap(fichier);
  const echelle = Math.min(1, TAILLE_LOGO_PX / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * echelle));
  canvas.height = Math.max(1, Math.round(image.height * echelle));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  for (const [type, qualite] of [["image/png"], ["image/webp", 0.86], ["image/jpeg", 0.86]]) {
    const dataUrl = canvas.toDataURL(type, qualite);
    if (!dataUrl.startsWith(`data:${type}`)) continue; // format non pris en charge par ce navigateur
    const donnees = dataUrl.split(",")[1];
    if (donnees.length * 0.75 <= MAX_LOGO_OCTETS) return { type, donnees, apercu: dataUrl };
  }
  throw new Error("Le logo est trop lourd, même compressé (300 Ko maximum).");
}

async function enregistrer(event) {
  event.preventDefault();
  const c = champs();
  clearPageMessage(c.message);
  const controle = validerMarque(valeursSaisies(), { nomAgence: etat.nomAgence });
  if (controle.error) {
    showPageMessage(c.message, controle.error);
    return;
  }
  const corps = { ...controle.valeur };
  setButtonLoading(c.bouton, true, "Enregistrement…");
  try {
    if (c.retirer.checked) {
      corps.logo = null;
    } else if (c.logo.files?.[0]) {
      const logo = await preparerLogo(c.logo.files[0]);
      corps.logo = { type: logo.type, donnees: logo.donnees };
    }
    const data = await api("/api/marque", { method: "PUT", body: corps });
    etat = { ...etat, marque: data.marque, logoLocal: null };
    c.logo.value = "";
    c.retirer.checked = false;
    remplir();
    showToast(data.marque.active ? "Personnalisation enregistrée : elle s'affiche sur le suivi de vos colis." : "Personnalisation enregistrée (désactivée).");
  } catch (error) {
    showPageMessage(c.message, errorMessage(error));
  } finally {
    setButtonLoading(c.bouton, false);
  }
}

function remplir() {
  const c = champs();
  const marque = etat.marque || {};
  c.active.checked = marque.active === true;
  c.nom.value = marque.nom || etat.nomAgence;
  c.couleur.value = marque.couleur || COULEUR_DEFAUT;
  c.couleur2.value = marque.couleur2 || COULEUR_ACCENT_DEFAUT;
  c.retirer.disabled = !marque.logo;
  if (etat.apercuCode) c.voir.href = `suivi.html?code=${encodeURIComponent(etat.apercuCode)}`;
  renderApercu();
}

export async function initMarque({ member, agency }) {
  const c = champs();
  if (!c.form) return;
  etat.nomAgence = agency?.name || "";
  try {
    const data = await api(`/api/marque?_=${Date.now()}`);
    etat = { ...etat, marque: data.marque, peutModifier: data.peutModifier, apercuCode: data.apercuCode };
  } catch (error) {
    showPageMessage(c.message, errorMessage(error));
    return;
  }
  remplir();
  const peutModifier = etat.peutModifier && member?.role === "gerant";
  for (const element of c.form.querySelectorAll("input, button[type=submit]")) element.disabled = !peutModifier;
  if (!peutModifier) {
    c.form.insertAdjacentHTML("beforeend", '<p class="muted-note">Seul le gérant de l\'agence peut personnaliser le suivi.</p>');
    return;
  }
  c.retirer.disabled = !etat.marque?.logo;
  for (const element of [c.active, c.nom, c.couleur, c.couleur2, c.retirer]) {
    element.addEventListener("input", renderApercu);
    element.addEventListener("change", renderApercu);
  }
  c.logo.addEventListener("change", async () => {
    clearPageMessage(c.message);
    const fichier = c.logo.files?.[0];
    if (!fichier) {
      etat.logoLocal = null;
      renderApercu();
      return;
    }
    try {
      etat.logoLocal = (await preparerLogo(fichier)).apercu;
      c.retirer.checked = false;
      renderApercu();
    } catch (error) {
      c.logo.value = "";
      showPageMessage(c.message, errorMessage(error));
    }
  });
  c.form.addEventListener("submit", enregistrer);
}
