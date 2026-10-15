/*
 * Alertes « colis qui dorment » (LOT 4) : trois signaux calculés sans
 * service externe, à partir du colis lui-même — le système appelle l'agence,
 * pas l'inverse. Module partagé client/serveur, sans DOM ni réseau.
 *
 *   - sans mouvement : « Expédié »/« En transit » sans mise à jour depuis 48 h
 *   - non retiré     : « Arrivé à l'agence de destination » depuis plus de 72 h
 *   - non rattaché   : aucune agence de destination rattachée depuis 7 jours
 *   - en souffrance  : arrivé non retiré depuis plus de 7 jours (retour possible)
 */
import { textePropre } from "./metier-colis.js";

export const SEUIL_SANS_MOUVEMENT_H = 48;
export const SEUIL_NON_RETIRE_H = 72;
export const SEUIL_NON_RATTACHE_J = 7;
export const SEUIL_SOUFFRANCE_J = 7;

export const LIBELLES_ALERTES = {
  sans_mouvement: "Sans mouvement depuis plus de 48 h",
  non_retire: "Arrivé, non retiré depuis plus de 72 h",
  non_rattache: "Agence de destination non rattachée depuis plus de 7 jours",
  souffrance: "En souffrance : arrivé non retiré depuis plus de 7 jours"
};

const STATUT_ARRIVE = "Arrivé à l'agence de destination";

function heuresDepuis(iso, now) {
  const date = new Date(iso ?? now);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, (now.getTime() - date.getTime()) / 3_600_000);
}

/** Date d'arrivée à l'agence de destination : dernière étape d'historique correspondante. */
export function dateArriveeDestinantion(parcel) {
  const history = Array.isArray(parcel?.history) ? parcel.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.status === STATUT_ARRIVE) return history[index].date ?? null;
  }
  return null;
}

/**
 * Signaux d'alerte d'un colis. `parcel` porte `status`, `createdAtISO`,
 * `updatedAtISO`, `destinationAgencyId`, `history` et (éventuel)
 * `retourStatus`. Renvoie une liste (vide = rien à signaler) :
 * `[{ cle, sinceISO, heures }]`.
 */
export function evaluerAlertes(parcel, now = new Date()) {
  if (!parcel) return [];
  const alertes = [];
  const statut = textePropre(parcel.status);

  if (["Expédié", "En transit"].includes(statut)) {
    const heures = heuresDepuis(parcel.updatedAtISO ?? parcel.createdAtISO, now);
    if (heures >= SEUIL_SANS_MOUVEMENT_H) {
      alertes.push({ cle: "sans_mouvement", sinceISO: parcel.updatedAtISO ?? parcel.createdAtISO, heures: Math.floor(heures) });
    }
  }

  if (statut === STATUT_ARRIVE && parcel.retourStatus !== "termine") {
    const arrivee = dateArriveeDestinantion(parcel) ?? parcel.updatedAtISO ?? parcel.createdAtISO;
    const heures = heuresDepuis(arrivee, now);
    if (heures >= SEUIL_NON_RETIRE_H) {
      alertes.push({ cle: "non_retire", sinceISO: arrivee, heures: Math.floor(heures) });
    }
    if (heures >= SEUIL_SOUFFRANCE_J * 24) {
      alertes.push({ cle: "souffrance", sinceISO: arrivee, heures: Math.floor(heures) });
    }
  }

  if ((parcel.destinationAgencyId ?? null) === null) {
    const heures = heuresDepuis(parcel.createdAtISO, now);
    if (heures >= SEUIL_NON_RATTACHE_J * 24) {
      alertes.push({ cle: "non_rattache", sinceISO: parcel.createdAtISO, heures: Math.floor(heures) });
    }
  }

  return alertes;
}

/** Regroupe les alertes d'une liste de colis par signal (cartes « À traiter »). */
export function alertesParSignal(parcels = [], now = new Date()) {
  const groupes = { sans_mouvement: [], non_retire: [], non_rattache: [], souffrance: [] };
  for (const parcel of parcels) {
    for (const alerte of evaluerAlertes(parcel, now)) {
      groupes[alerte.cle].push({
        id: parcel.id,
        trackingCode: parcel.trackingCode,
        status: parcel.status,
        originCity: parcel.originCity,
        destinationCity: parcel.destinationCity,
        destinationAgencyName: parcel.destinationAgencyName ?? "",
        sinceISO: alerte.sinceISO,
        heures: alerte.heures
      });
    }
  }
  for (const cle of Object.keys(groupes)) {
    groupes[cle].sort((a, b) => b.heures - a.heures);
  }
  return groupes;
}

/** Le colis est-il « en souffrance » (arrivé non retiré depuis > 7 jours) ? */
export function estEnSouffrance(parcel, now = new Date()) {
  return evaluerAlertes(parcel, now).some((alerte) => alerte.cle === "souffrance");
}

/** Jours écoulés depuis une date ISO (0 si date invalide). */
export function joursDepuis(iso, now = new Date()) {
  return Math.floor(heuresDepuis(iso, now) / 24);
}
