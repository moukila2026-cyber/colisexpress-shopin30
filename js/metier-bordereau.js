/*
 * Bordereaux d'acheminement (LOT 4) : regrouper 1 à 200 colis expédiés
 * ensemble, avec un transporteur identifié et un contrôle d'arrivée en cases
 * à cocher. Module partagé client/serveur — aucun DOM, aucun réseau,
 * testable avec `node --test`.
 *
 * Le bordereau est une pièce de la chaîne de preuve : jamais de suppression,
 * colis et transporteur immuables après remise.
 */
import { textePropre } from "./metier-colis.js";
import { cleVille } from "./metier-tarifs.js";
import { isValidIvorianPhone, normalizeIvorianPhone } from "./utils.js";

export const STATUTS_BORDEREAU = ["Préparé", "Remis", "En route", "Arrivé", "Contrôlé", "Écart"];

/** Étapes que l'agence émettrice valide elle-même (avant l'arrivée). */
export const ETAPES_EMETTEUR = { "Préparé": "Remis", "Remis": "En route" };

/** Statuts de colis autorisés dans un bordereau en préparation. */
export const STATUTS_COLIS_EMBARQUABLES = ["Enregistré", "Expédié"];

export const MAX_COLIS_BORDEREAU = 200;

const NOM = [2, 120];

function dansLimite(value, [min, max]) {
  return value.length >= min && value.length <= max;
}

/**
 * Contrôle du formulaire de création d'un bordereau.
 * Renvoie `{ error }` ou `{ valeur: { carrierName, carrierPhone, vehicleRef, parcelIds } }`.
 */
export function validerCreationBordereau(input = {}) {
  const carrierName = textePropre(input.carrierName);
  if (!dansLimite(carrierName, NOM)) {
    return { error: "Indiquez le nom du transporteur (2 à 120 caractères)." };
  }
  const carrierPhone = normalizeIvorianPhone(input.carrierPhone ?? "");
  if (!isValidIvorianPhone(carrierPhone)) {
    return { error: "Saisissez un téléphone ivoirien valide pour le transporteur (10 chiffres)." };
  }
  const vehicleRef = textePropre(input.vehicleRef);
  if (vehicleRef.length > 120) {
    return { error: "La référence du véhicule ou de la ligne ne doit pas dépasser 120 caractères." };
  }
  const bruts = Array.isArray(input.parcelIds) ? input.parcelIds : [];
  const parcelIds = [...new Set(bruts.map((id) => textePropre(id)).filter(Boolean))];
  if (!parcelIds.length) {
    return { error: "Sélectionnez au moins un colis à embarquer." };
  }
  if (parcelIds.length > MAX_COLIS_BORDEREAU) {
    return { error: `Un bordereau regroupe au maximum ${MAX_COLIS_BORDEREAU} colis.` };
  }
  return { valeur: { carrierName, carrierPhone, vehicleRef, parcelIds } };
}

/**
 * Les colis d'un bordereau doivent partir ensemble : même agence
 * expéditrice, même destination (agence rattachée identique — ou toutes non
 * rattachées — et même ville d'arrivée), statuts embarquables, et aucun colis
 * déjà parti dans un autre bordereau.
 */
export function validerColisEmbarquables({ parcels = [], agencyId }) {
  if (!parcels.length) return { error: "Sélectionnez au moins un colis à embarquer." };
  const premiers = parcels[0];
  for (const parcel of parcels) {
    if (parcel.ownerId !== agencyId) {
      return { error: `Le colis ${parcel.trackingCode || ""} n'appartient pas à votre agence : seul l'expéditeur borde ses colis.` };
    }
    if (!STATUTS_COLIS_EMBARQUABLES.includes(parcel.status)) {
      return { error: `Le colis ${parcel.trackingCode || ""} (${parcel.status}) ne peut plus être bordé : seuls les colis « Enregistré » ou « Expédié » partent en bordereau.` };
    }
    if (parcel.bordereauId) {
      return { error: `Le colis ${parcel.trackingCode || ""} fait déjà partie d'un bordereau.` };
    }
    if ((parcel.destinationAgencyId ?? null) !== (premiers.destinationAgencyId ?? null)) {
      return { error: "Tous les colis d'un bordereau doivent avoir la même agence de destination (ou aucune : déclarez-les vers la même ville)." };
    }
    if (cleVille(parcel.destinationCity) !== cleVille(premiers.destinationCity)) {
      return { error: "Tous les colis d'un bordereau doivent aller dans la même ville d'arrivée." };
    }
    if (cleVille(parcel.originCity) !== cleVille(premiers.originCity)) {
      return { error: "Tous les colis d'un bordereau doivent partir de la même ville." };
    }
  }
  return {
    destination: {
      toAgencyId: premiers.destinationAgencyId ?? null,
      toAgencyName: textePropre(premiers.destinationAgencyName),
      toCity: textePropre(premiers.destinationCity),
      originCity: textePropre(premiers.originCity)
    }
  };
}

/**
 * L'agence qui arrive : l'agence de destination rattachée, sinon l'agence
 * expéditrice (même logique que la progression des colis).
 */
export function agenceDeControle(bordereau) {
  return bordereau?.toAgencyId ?? bordereau?.fromAgencyId ?? null;
}

/**
 * Prochaine étape du bordereau que `agencyId` est autorisée à valider, ou
 * `null`. « Contrôlé »/« Écart » passent par le contrôle d'arrivée (cases à
 * cocher) et ne sont pas une simple étape suivante.
 */
export function prochaineEtapeBordereau({ bordereau, agencyId }) {
  if (!bordereau || !agencyId) return null;
  const isFrom = bordereau.fromAgencyId === agencyId;
  const isControleur = agenceDeControle(bordereau) === agencyId;
  if (["Remis", "En route"].includes(ETAPES_EMETTEUR[bordereau.status])) {
    return isFrom ? ETAPES_EMETTEUR[bordereau.status] : null;
  }
  if (bordereau.status === "En route") return isControleur ? "Arrivé" : null;
  return null;
}

/** L'agence peut-elle faire le contrôle d'arrivée (cases à cocher) ? */
export function peutControler({ bordereau, agencyId }) {
  return Boolean(bordereau) && bordereau.status === "Arrivé" && agenceDeControle(bordereau) === agencyId;
}

/**
 * Résultat d'un contrôle d'arrivée : la liste présente est le complément des
 * absents déclarés. Tout absent → statut « Écart » et incident automatique
 * côté serveur ; aucun absent → « Contrôlé ».
 */
export function resoudreControle({ bordereau, parcelIds = [], absentParcelIds = [] }) {
  const tous = [...new Set(parcelIds.map(String))];
  const absents = [...new Set(absentParcelIds.map(String))].filter((id) => tous.includes(id));
  const presents = tous.filter((id) => !absents.includes(id));
  if (!presents.length && !absents.length) {
    return { error: "Aucun colis à contrôler dans ce bordereau." };
  }
  return {
    status: absents.length ? "Écart" : "Contrôlé",
    presents,
    absents
  };
}

/** Projection publique d'un bordereau : aucune donnée personnelle (ni expéditeur, ni destinataire, ni téléphone du transporteur). */
export function bordereauPublic(bordereau, parcels = [], lastUpdatedAtISO) {
  return {
    code: bordereau.code,
    status: bordereau.status,
    parcelCount: bordereau.parcelCount ?? parcels.length,
    originCity: bordereau.fromCity,
    destinationCity: bordereau.toCity,
    carrierName: bordereau.carrierName,
    vehicleRef: bordereau.vehicleRef,
    parcels: parcels.map((parcel) => ({
      trackingCode: parcel.trackingCode,
      status: parcel.status,
      ...(bordereau.checkedAt ? { present: !(bordereau.missingParcelIds || []).includes(parcel.id) } : {})
    })),
    ...(bordereau.checkedAt ? { checkedAtISO: bordereau.checkedAt } : {}),
    lastUpdatedAtISO
  };
}

/** Ligne SQL → bordereau métier (camelCase). */
export function normaliserBordereau(row = {}, parcelIds = null) {
  if (!row) return null;
  let missing = row.missing_parcel_ids ?? row.missingParcelIds ?? [];
  if (typeof missing === "string") {
    try { missing = JSON.parse(missing); } catch { missing = []; }
  }
  return {
    id: row.id,
    code: row.code,
    fromAgencyId: row.from_agency_id ?? row.fromAgencyId,
    fromAgencyName: row.from_agency_name ?? row.fromAgencyName,
    fromCity: row.from_city ?? row.fromCity,
    toAgencyId: row.to_agency_id ?? row.toAgencyId ?? null,
    toAgencyName: row.to_agency_name ?? row.toAgencyName,
    toCity: row.to_city ?? row.toCity,
    carrierName: row.carrier_name ?? row.carrierName,
    carrierPhone: row.carrier_phone ?? row.carrierPhone ?? "",
    vehicleRef: row.vehicle_ref ?? row.vehicleRef ?? "",
    parcelCount: row.parcel_count ?? row.parcelCount,
    status: row.status,
    handedOverAt: row.handed_over_at ?? row.handedOverAt ?? null,
    handedOverBy: row.handed_over_by ?? row.handedOverBy ?? null,
    departedAt: row.departed_at ?? row.departedAt ?? null,
    arrivedAt: row.arrived_at ?? row.arrivedAt ?? null,
    arrivedBy: row.arrived_by ?? row.arrivedBy ?? null,
    checkedAt: row.checked_at ?? row.checkedAt ?? null,
    checkedBy: row.checked_by ?? row.checkedBy ?? null,
    missingParcelIds: Array.isArray(missing) ? missing : [],
    parcelIds: parcelIds ?? undefined,
    createdAtISO: row.created_at_iso ?? row.createdAtISO
  };
}
