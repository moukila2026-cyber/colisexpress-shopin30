/*
 * Incidents (LOT 4) : état LATÉRAL du colis — un colis peut être perdu puis
 * retrouvé, la chaîne des 5 statuts ne doit donc pas absorber ces états.
 * Module partagé client/serveur, sans DOM ni réseau.
 *
 * Visibilité : les deux agences du colis. Côté suivi public : uniquement un
 * bandeau sobre (« une vérification est en cours »), jamais le type, la note
 * ou l'identité de l'agence qui a ouvert l'incident.
 */
import { textePropre } from "./metier-colis.js";

export const TYPES_INCIDENT = [
  { id: "perdu", label: "Perdu" },
  { id: "endommage", label: "Endommagé" },
  { id: "retard", label: "Retard" },
  { id: "conteste", label: "Contesté" },
  { id: "bloque", label: "Bloqué" }
];

export const ETATS_INCIDENT = [
  { id: "ouvert", label: "Ouvert" },
  { id: "recherches", label: "En recherches" },
  { id: "resolu", label: "Résolu" }
];

/** Seuils d'escalade (heures) : rappel aux deux agences, puis file plateforme. */
export const SEUIL_ALERTE_24H = 24;
export const SEUIL_FILE_PLATEFORME_JOURS = 7;

export const BANDEAU_PUBLIC_INCIDENT = "Une vérification est en cours sur ce colis.";

export function estTypeIncident(type) {
  return TYPES_INCIDENT.some((item) => item.id === type);
}

export function estEtatIncident(state) {
  return ETATS_INCIDENT.some((item) => item.id === state);
}

export function libelleTypeIncident(type) {
  return TYPES_INCIDENT.find((item) => item.id === type)?.label || type;
}

export function libelleEtatIncident(state) {
  return ETATS_INCIDENT.find((item) => item.id === state)?.label || state;
}

/** Contrôle de l'ouverture d'un incident : `{ error }` ou `{ valeur }`. */
export function validerOuvertureIncident(input = {}) {
  const type = textePropre(input.type);
  if (!estTypeIncident(type)) {
    return { error: "Choisissez le type d'incident : perdu, endommagé, retard, contesté ou bloqué." };
  }
  const note = textePropre(input.note);
  if (note.length < 2) {
    return { error: "Décrivez l'incident en quelques mots (2 caractères minimum)." };
  }
  if (note.length > 2000) {
    return { error: "La description ne doit pas dépasser 2000 caractères." };
  }
  return { valeur: { type, note } };
}

/**
 * Transition d'état autorisée : ouvert → recherches → résolu (ouvert → résolu
 * permis). Un incident résolu est immuable — il reste dans l'historique.
 */
export function validerTransitionIncident({ incident, state, resolution = "" }) {
  if (!incident) return { error: "Cet incident est introuvable." };
  if (incident.state === "resolu") {
    return { error: "Cet incident est déjà résolu : il ne peut plus être modifié." };
  }
  if (!estEtatIncident(state)) {
    return { error: "Choisissez un état valide : ouvert, en recherches ou résolu." };
  }
  if (state === "ouvert") {
    return { error: "Un incident ne revient jamais à « ouvert » : passez-le en recherches ou résolvez-le." };
  }
  const texte = textePropre(resolution);
  if (state === "resolu") {
    if (texte.length < 2) {
      return { error: "Expliquez comment l'incident a été résolu (2 caractères minimum)." };
    }
    if (texte.length > 2000) {
      return { error: "La résolution ne doit pas dépasser 2000 caractères." };
    }
  }
  return { valeur: { state, resolution: texte } };
}

/**
 * Escalade d'un incident non résolu : ouvert > 24 h → rappel aux deux
 * agences ; > 7 jours → file d'arbitrage plateforme (lot 6).
 */
export function escaladeIncident({ incident, now = new Date() }) {
  if (!incident || incident.state === "resolu") {
    return { heures: 0, alerte24h: false, filePlateforme: false };
  }
  const ouvert = new Date(incident.openedAtISO ?? incident.opened_at_iso ?? now);
  const heures = Math.max(0, (now.getTime() - ouvert.getTime()) / 3_600_000);
  return {
    heures: Math.floor(heures),
    alerte24h: heures >= SEUIL_ALERTE_24H,
    filePlateforme: heures >= SEUIL_FILE_PLATEFORME_JOURS * 24
  };
}

/**
 * Bandeau du suivi public : texte SOBRE et fixe dès qu'un incident non résolu
 * existe — jamais de type, de note, ni d'agence (aucune donnée privée).
 */
export function bandeauPublicIncident(incidents = []) {
  const actif = (Array.isArray(incidents) ? incidents : []).some((incident) => incident.state !== "resolu");
  return actif ? BANDEAU_PUBLIC_INCIDENT : null;
}

/** Ligne SQL → incident métier (camelCase). */
export function normaliserIncident(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    parcelId: row.parcel_id ?? row.parcelId,
    bordereauId: row.bordereau_id ?? row.bordereauId ?? null,
    type: row.type,
    state: row.state,
    note: row.note ?? "",
    resolution: row.resolution ?? "",
    openedByAgencyId: row.opened_by_agency_id ?? row.openedByAgencyId,
    openedById: row.opened_by_id ?? row.openedById ?? null,
    openedByName: row.opened_by_name ?? row.openedByName ?? "",
    openedAtISO: row.opened_at_iso ?? row.openedAtISO,
    updatedByName: row.updated_by_name ?? row.updatedByName ?? "",
    resolvedAtISO: row.resolved_at_iso ?? row.resolvedAtISO ?? null,
    ...escaladeIncident({ incident: { state: row.state, openedAtISO: row.opened_at_iso ?? row.openedAtISO } })
  };
}
