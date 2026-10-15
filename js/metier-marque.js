/*
 * Suivi personnalisé par agence (LOT 7) — règles partagées client/serveur.
 *
 * Une agence peut habiller la page de suivi public de SES colis (agence
 * expéditrice) : nom affiché, couleur principale, couleur d'accent, logo.
 * La personnalisation est facultative et désactivée par défaut ; elle
 * n'ajoute aucune donnée personnelle au suivi public (identité commerciale
 * de l'agence seulement). Couleurs strictement « #rrggbb » (aucune injection
 * CSS possible) ; logos PNG, JPEG ou WebP vérifiés sur leurs octets (jamais de
 * SVG : un SVG peut embarquer du script).
 */

export const COULEUR_DEFAUT = "#0b5d46";
export const COULEUR_ACCENT_DEFAUT = "#f27622";
export const TYPES_LOGO = Object.freeze(["image/png", "image/jpeg", "image/webp"]);
export const MAX_LOGO_OCTETS = 300 * 1024;
export const LONGUEUR_NOM = Object.freeze({ min: 2, max: 60 });

function texte(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function estCouleurHex(value) {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

export function normaliserCouleur(value) {
  return estCouleurHex(value) ? value.trim().toLowerCase() : null;
}

function canal(valeur) {
  const c = valeur / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Luminance relative WCAG d'une couleur « #rrggbb ». */
export function luminance(hex) {
  const couleur = normaliserCouleur(hex) ?? COULEUR_DEFAUT;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(couleur.slice(i, i + 2), 16));
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}

export function contraste(hexA, hexB) {
  const [clair, fonce] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a);
  return (clair + 0.05) / (fonce + 0.05);
}

/** Couleur du texte posé sur `hex` : blanc ou quasi-noir, la plus lisible. */
export function couleurTexteSur(hex) {
  return contraste(hex, "#ffffff") >= contraste(hex, "#111111") ? "#ffffff" : "#111111";
}

/**
 * Validation des réglages saisis par le gérant (Paramètres). Le nom affiché
 * vaut par défaut le nom de l'agence ; les couleurs absentes reprennent les
 * couleurs COLIS EXPRESS.
 */
export function validerMarque(input = {}, { nomAgence = "" } = {}) {
  const active = input.active === true;
  const nom = texte(input.nom) || texte(nomAgence);
  if (nom.length < LONGUEUR_NOM.min || nom.length > LONGUEUR_NOM.max) {
    return { error: `Le nom affiché doit contenir ${LONGUEUR_NOM.min} à ${LONGUEUR_NOM.max} caractères.` };
  }
  for (const [champ, libelle] of [["couleur", "principale"], ["couleur2", "d'accent"]]) {
    const brute = input[champ];
    if (brute !== undefined && brute !== null && texte(brute) !== "" && !estCouleurHex(brute)) {
      return { error: `La couleur ${libelle} doit être au format #RRGGBB (ex. #0B5D46).` };
    }
  }
  return {
    valeur: {
      active,
      nom,
      couleur: normaliserCouleur(input.couleur) ?? COULEUR_DEFAUT,
      couleur2: normaliserCouleur(input.couleur2) ?? COULEUR_ACCENT_DEFAUT
    }
  };
}

/** Type d'image réel d'après les premiers octets (PNG, JPEG, WebP), sinon null. */
export function typeImageDepuisOctets(octets) {
  if (!octets || octets.length < 12) return null;
  const o = (i) => octets[i];
  if (o(0) === 0x89 && o(1) === 0x50 && o(2) === 0x4e && o(3) === 0x47 && o(4) === 0x0d && o(5) === 0x0a && o(6) === 0x1a && o(7) === 0x0a) return "image/png";
  if (o(0) === 0xff && o(1) === 0xd8 && o(2) === 0xff) return "image/jpeg";
  if (o(0) === 0x52 && o(1) === 0x49 && o(2) === 0x46 && o(3) === 0x46 && o(8) === 0x57 && o(9) === 0x45 && o(10) === 0x42 && o(11) === 0x50) return "image/webp";
  return null;
}

/**
 * Contrôle d'un logo téléversé : type déclaré autorisé, octets conformes au
 * type déclaré, taille maximale. `octets` : Buffer/Uint8Array décodé.
 */
export function validerLogo({ type, octets }) {
  if (!TYPES_LOGO.includes(type)) return { error: "Le logo doit être une image PNG, JPEG ou WebP." };
  if (!octets || !octets.length) return { error: "Le fichier du logo est vide." };
  if (octets.length > MAX_LOGO_OCTETS) return { error: "Le logo est trop lourd (300 Ko maximum)." };
  if (typeImageDepuisOctets(octets) !== type) return { error: "Le fichier ne correspond pas à une image PNG, JPEG ou WebP valide." };
  return { valeur: { type } };
}

/**
 * Projection publique de la marque d'une agence (ligne SQL `agencies`) pour
 * le suivi : uniquement si la personnalisation est active. Ni e-mail, ni
 * téléphone, ni identifiant de stockage.
 */
export function marquePublique(row = {}) {
  if (!row || row.marque_active !== true) return null;
  const couleur = normaliserCouleur(row.marque_couleur) ?? COULEUR_DEFAUT;
  return {
    nom: texte(row.marque_nom) || texte(row.name),
    couleur,
    couleur2: normaliserCouleur(row.marque_couleur_2) ?? COULEUR_ACCENT_DEFAUT,
    couleurTexte: couleurTexteSur(couleur),
    logo: Boolean(row.marque_logo_cle),
    version: row.marque_maj_iso || ""
  };
}

/** Variables CSS de la marque (valeurs revalidées : jamais de texte libre dans le style). */
export function variablesMarque(marque) {
  if (!marque) return "";
  const couleur = normaliserCouleur(marque.couleur) ?? COULEUR_DEFAUT;
  const couleur2 = normaliserCouleur(marque.couleur2) ?? COULEUR_ACCENT_DEFAUT;
  return `--marque:${couleur};--marque-2:${couleur2};--marque-texte:${couleurTexteSur(couleur)}`;
}
