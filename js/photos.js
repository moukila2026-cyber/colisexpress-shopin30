/*
 * Photos de preuve (LOT 4) — côté navigateur : compression avant upload.
 * Objectif réseau 3G : ~200 Ko par photo, 1 024 px de large maximum, JPEG.
 * Le contenu n'est jamais stocké en base : l'API le confie à lib/photos.js
 * (disque local ou Vercel Blob), Postgres ne garde que les métadonnées.
 */

export const ETAPES_PHOTO = [
  { id: "prise_en_charge", label: "Prise en charge" },
  { id: "arrivee", label: "Arrivée" }
];

export const MAX_PHOTOS_PAR_ETAPE = 2;
export const CIBLE_OCTETS = 200_000;
export const MAX_DIMENSION = 1024;
export const MAX_OCTETS_UPLOAD = 2 * 1024 * 1024; // garde-fou serveur : 2 Mo

export function libelleEtapePhoto(etape) {
  return ETAPES_PHOTO.find((item) => item.id === etape)?.label || etape;
}

/** Taille en octets du contenu binaire d'une data URL base64. */
export function tailleDataUrl(dataUrl = "") {
  const base64 = String(dataUrl).split(",")[1] || "";
  return Math.floor((base64.length * 3) / 4);
}

function chargerImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Ce fichier n'est pas une image lisible."));
    };
    image.src = url;
  });
}

/**
 * Compresse une image côté navigateur : redimensionnée à `maxDim` px maximum,
 * ré-encodée en JPEG avec une qualité décroissante jusqu'à passer sous
 * `cibleOctets`. Renvoie une data URL `image/jpeg`.
 */
export async function compresserImage(file, { maxDim = MAX_DIMENSION, cibleOctets = CIBLE_OCTETS } = {}) {
  if (!file || !String(file.type || "").startsWith("image/")) {
    throw new Error("Choisissez un fichier image (JPEG, PNG ou WebP).");
  }
  if (file.size > 12 * 1024 * 1024) {
    throw new Error("Cette image dépasse 12 Mo : prenez-la avec l'appareil photo du téléphone.");
  }
  const { image, url } = await chargerImage(file);
  try {
    const ratio = Math.min(1, maxDim / Math.max(image.width || maxDim, image.height || maxDim));
    const largeur = Math.max(1, Math.round((image.width || maxDim) * ratio));
    const hauteur = Math.max(1, Math.round((image.height || maxDim) * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = largeur;
    canvas.height = hauteur;
    const contexte = canvas.getContext("2d");
    contexte.fillStyle = "#ffffff";
    contexte.fillRect(0, 0, largeur, hauteur);
    contexte.drawImage(image, 0, 0, largeur, hauteur);

    let dataUrl = "";
    for (const qualite of [0.82, 0.7, 0.55, 0.4, 0.3]) {
      dataUrl = canvas.toDataURL("image/jpeg", qualite);
      if (tailleDataUrl(dataUrl) <= cibleOctets) break;
    }
    if (tailleDataUrl(dataUrl) > MAX_OCTETS_UPLOAD) {
      throw new Error("Cette image reste trop lourde après compression. Reprenez-la de plus près.");
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * L'agence connectée peut-elle téléverser une photo de cette étape ?
 * (Garde d'interface — la vraie autorisation est appliquée par le serveur.)
 */
export function peutPhotographierCoteClient({ parcel, agencyId, etape }) {
  if (!parcel || !agencyId) return false;
  const owner = parcel.ownerId === agencyId;
  const destination = parcel.destinationAgencyId === agencyId;
  if (etape === "prise_en_charge") return owner;
  return destination || (owner && parcel.destinationAgencyId === null);
}
