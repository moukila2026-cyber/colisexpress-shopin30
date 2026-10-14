/*
 * Règles de gestion des colis : validation, construction du document, étapes
 * de progression et rattachement d'une agence de destination.
 *
 * Aucun import de DOM ni d'accès réseau ici : ce module est volontairement
 * testable avec `node --test tests/`. Les fonctions renvoient toujours de
 * nouvelles données (elles ne modifient jamais l'objet reçu).
 */
import {
  STATUTS,
  isValidCni,
  isValidIvorianPhone,
  normalizeIvorianPhone
} from "./utils.js";

/** Étapes que l'agence expéditrice peut valider elle-même. */
export const ETAPES_EXPEDITEUR = ["Expédié", "En transit"];
/** Étapes normalement validées par l'agence de destination. */
export const ETAPES_DESTINATION = ["Arrivé à l'agence de destination", "Retiré"];

/** Statut ajouté à l'historique lorsqu'une agence de destination est rattachée. */
export const STATUT_RATTACHEMENT = "Agence de retrait confirmée";

const NOM_AGENCE = [2, 120];
const VILLE = [2, 60];
const NATURE = [2, 120];

export function textePropre(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function dansLimite(value, [min, max]) {
  return value.length >= min && value.length <= max;
}

function comparerParNom(a, b) {
  return `${a.name || ""}`.localeCompare(`${b.name || ""}`, "fr", { sensitivity: "base" });
}

/** Coordonnées de l'agence de destination saisies à la main (agence non inscrite). */
export function lireAgenceDeclaree(values = {}) {
  return {
    name: textePropre(values.declaredAgencyName),
    city: textePropre(values.declaredAgencyCity),
    phone: normalizeIvorianPhone(values.declaredAgencyPhone ?? "")
  };
}

/**
 * Contrôle du formulaire « nouveau colis ». Renvoie le premier message d'erreur
 * à afficher, ou `null` quand tout est valide.
 */
export function validerColis({ values, agencyNotRegistered = false }) {
  if (!textePropre(values.senderFirstName) || !textePropre(values.senderLastName)) {
    return "Renseignez le nom complet de l'expéditeur.";
  }
  if (!isValidIvorianPhone(values.senderPhone)) {
    return "Saisissez un téléphone ivoirien valide pour l'expéditeur (10 chiffres).";
  }
  if (!isValidCni(values.senderCni)) {
    return "Le numéro CNI de l'expéditeur doit contenir 8 à 25 caractères et au moins un chiffre.";
  }
  if (!textePropre(values.recipientFirstName) || !textePropre(values.recipientLastName)) {
    return "Renseignez le nom complet du destinataire.";
  }
  if (!isValidIvorianPhone(values.recipientPhone)) {
    return "Saisissez un téléphone ivoirien valide pour le destinataire (10 chiffres).";
  }
  if (!dansLimite(textePropre(values.packageNature), NATURE)) {
    return "Indiquez la nature du colis (2 caractères minimum).";
  }
  if (!Number.isFinite(Number(values.weightKg)) || Number(values.weightKg) <= 0) {
    return "Le poids doit être supérieur à 0 kg.";
  }
  if (!Number.isFinite(Number(values.priceFCFA)) || Number(values.priceFCFA) < 0) {
    return "Le prix doit être un montant valide.";
  }
  const originCity = textePropre(values.originCity);
  const destinationCity = textePropre(values.destinationCity);
  if (!dansLimite(originCity, VILLE) || !dansLimite(destinationCity, VILLE)) {
    return "Indiquez les villes de départ et de destination (2 à 60 caractères).";
  }

  if (agencyNotRegistered) {
    const declared = lireAgenceDeclaree(values);
    if (!dansLimite(declared.name, NOM_AGENCE)) {
      return `Indiquez le nom de l'agence de destination (${NOM_AGENCE[0]} à ${NOM_AGENCE[1]} caractères).`;
    }
    if (!dansLimite(declared.city, VILLE)) {
      return `Indiquez la ville de l'agence de destination (${VILLE[0]} à ${VILLE[1]} caractères).`;
    }
    if (!isValidIvorianPhone(declared.phone)) {
      return "Saisissez le téléphone ivoirien de l'agence de destination (10 chiffres).";
    }
    return null;
  }

  if (!textePropre(values.destinationAgencyId)) {
    return "Sélectionnez une agence de destination, ou cochez « mon agence de destination n'est pas encore inscrite ».";
  }
  return null;
}

/**
 * Détermine les champs de destination du colis.
 *
 * - Agence inscrite : `destinationAgencyId` = uid de l'agence (contrôlé par les règles).
 * - Agence non inscrite : `destinationAgencyId` = `null` et les coordonnées
 *   déclarées sont stockées dans `unregisteredDestinationAgency`.
 *
 * Renvoie `{ ok: false, error }` si la destination n'est pas recevable.
 */
export function resoudreDestination({ values, agencies = [], currentAgencyId = null, agencyNotRegistered = false }) {
  if (agencyNotRegistered) {
    const declared = lireAgenceDeclaree(values);
    const invalid =
      !dansLimite(declared.name, NOM_AGENCE) ||
      !dansLimite(declared.city, VILLE) ||
      !isValidIvorianPhone(declared.phone);
    if (invalid) return { ok: false, error: "Complétez le nom, la ville et le téléphone de l'agence de destination." };
    return {
      ok: true,
      destination: {
        destinationAgencyId: null,
        destinationAgencyName: declared.name,
        destinationAgencyCity: declared.city,
        unregisteredDestinationAgency: declared
      }
    };
  }

  const agency = agencies.find((item) => item.id === textePropre(values.destinationAgencyId));
  if (!agency) {
    return { ok: false, error: "L'agence de destination choisie n'est plus disponible. Actualisez la page." };
  }
  if (agency.id === currentAgencyId) {
    return { ok: false, error: "L'agence de destination doit être différente de l'agence expéditrice." };
  }
  return {
    ok: true,
    destination: {
      destinationAgencyId: agency.id,
      destinationAgencyName: textePropre(agency.name),
      destinationAgencyCity: textePropre(agency.city)
    }
  };
}

/** Document public de suivi : exactement les 7 champs exposés par l'API (aucune donnée personnelle). */
export function construireSuiviPublic(parcel, nowISO) {
  return {
    code: parcel.trackingCode,
    colisId: parcel.id,
    status: parcel.status,
    history: Array.isArray(parcel.history) ? parcel.history : [],
    originCity: parcel.originCity,
    destinationCity: parcel.destinationCity,
    lastUpdatedAtISO: nowISO
  };
}

/**
 * Construit le document `colis` et son document public `suivis/{code}`.
 * Les horodatages serveur (`created_at`, `updated_at`) sont gérés par la base.
 */
export function construireColis({ values, currentAgency, destination, parcelId, trackingCode, nowISO }) {
  const originCity = textePropre(values.originCity);
  const destinationCity = textePropre(values.destinationCity);
  const history = [{
    status: "Enregistré",
    date: nowISO,
    agencyName: currentAgency.name,
    city: originCity
  }];
  const parcel = {
    id: parcelId,
    trackingCode,
    ownerId: currentAgency.id,
    ownerAgencyName: currentAgency.name,
    ownerAgencyCity: currentAgency.city,
    destinationAgencyId: destination.destinationAgencyId,
    destinationAgencyName: destination.destinationAgencyName,
    destinationAgencyCity: destination.destinationAgencyCity,
    ...(destination.unregisteredDestinationAgency
      ? { unregisteredDestinationAgency: destination.unregisteredDestinationAgency }
      : {}),
    sender: {
      firstName: textePropre(values.senderFirstName),
      lastName: textePropre(values.senderLastName),
      phone: normalizeIvorianPhone(values.senderPhone),
      cni: textePropre(values.senderCni).toUpperCase()
    },
    recipient: {
      firstName: textePropre(values.recipientFirstName),
      lastName: textePropre(values.recipientLastName),
      phone: normalizeIvorianPhone(values.recipientPhone)
    },
    packageNature: textePropre(values.packageNature),
    weightKg: Number(values.weightKg),
    priceFCFA: Math.round(Number(values.priceFCFA)),
    originCity,
    destinationCity,
    status: "Enregistré",
    history,
    createdAtISO: nowISO
  };
  return { parcel, publicTracking: construireSuiviPublic(parcel, nowISO) };
}

/** Le colis attend encore le rattachement d'une agence de destination. */
export function attendUnRattachement(parcel) {
  return Boolean(parcel) && (parcel.destinationAgencyId ?? null) === null;
}

/** L'agence expéditrice peut-elle rattacher une agence sur ce colis ? */
export function peutRattacher({ parcel, agencyId }) {
  if (!parcel || !agencyId) return false;
  return parcel.ownerId === agencyId && attendUnRattachement(parcel);
}

/** Agences inscrites proposées au rattachement, sans l'agence expéditrice. */
export function agencesRattachables({ parcel, agencies = [], currentAgencyId = null }) {
  if (!peutRattacher({ parcel, agencyId: currentAgencyId })) return [];
  return agencies
    .filter((agency) => agency.id !== currentAgencyId)
    .sort(comparerParNom);
}

/**
 * Écritures à envoyer pour rattacher une agence de destination.
 * `agency` est lu dans la transaction : le nom et la ville viennent donc du
 * profil de l'agence, pas d'une saisie. Le statut n'est jamais modifié ici
 * (les règles l'interdisent) et la déclaration d'origine est conservée.
 */
export function changementsRattachement({ parcel, agency, ownerAgency, now, destinationCity = null }) {
  const finalCity = textePropre(destinationCity) || parcel.destinationCity || agency.city || "";
  const history = Array.isArray(parcel.history) ? [...parcel.history] : [];
  history.push({
    status: STATUT_RATTACHEMENT,
    date: now,
    agencyName: ownerAgency?.name || "Agence COLIS EXPRESS",
    city: finalCity,
    note: `Retrait confirmé à ${agency.name}${finalCity ? ` — ${finalCity}` : ""}`
  });
  return {
    destinationAgencyId: agency.id,
    destinationAgencyName: agency.name,
    destinationAgencyCity: agency.city,
    destinationAgencyAttachedAt: now,
    destinationAgencyAttachedBy: ownerAgency?.name || "",
    destinationCity: finalCity,
    history
  };
}

/**
 * Prochaine étape que `agencyId` est autorisée à valider sur ce colis, ou `null`.
 *
 * Tant qu'aucune agence de destination n'est rattachée, l'expéditeur valide les
 * étapes de destination lui-même : sinon le colis resterait bloqué « En transit »
 * et ne pourrait jamais être clôturé.
 */
export function prochaineEtape({ parcel, agencyId }) {
  if (!parcel || !agencyId) return null;
  const index = STATUTS.indexOf(parcel.status);
  if (index < 0) return null;
  const nextStatus = STATUTS[index + 1];
  if (!nextStatus) return null;

  const isOwner = parcel.ownerId === agencyId;
  const isDestination = !attendUnRattachement(parcel) && parcel.destinationAgencyId === agencyId;
  if (ETAPES_EXPEDITEUR.includes(nextStatus)) return isOwner ? nextStatus : null;
  if (ETAPES_DESTINATION.includes(nextStatus)) {
    if (isDestination) return nextStatus;
    return isOwner && attendUnRattachement(parcel) ? nextStatus : null;
  }
  return null;
}

/**
 * L'étape demandée est-elle validée par l'expéditeur seulement parce que
 * l'agence de destination n'est pas encore inscrite ? Sert à l'avertissement
 * affiché sur la fiche colis.
 */
export function etapeValideeParExpediteur({ parcel, agencyId, nextStatus }) {
  if (!parcel || !attendUnRattachement(parcel)) return false;
  if (parcel.ownerId !== agencyId) return false;
  return ETAPES_DESTINATION.includes(nextStatus);
}

/** Coordonnées de l'agence déclarées à la main, ou `null` si elle est inscrite. */
export function agenceDeclaree(parcel) {
  if (!parcel || !attendUnRattachement(parcel)) return null;
  return parcel.unregisteredDestinationAgency || null;
}

/** Ville saisie sur le colis et ville du compte de l'agence rattachée : à signaler, pas à bloquer. */
export function villeDivergente({ parcel, agency }) {
  const declared = textePropre(parcel?.destinationCity).toLowerCase();
  const actual = textePropre(agency?.city).toLowerCase();
  return Boolean(declared) && Boolean(actual) && declared !== actual;
}
