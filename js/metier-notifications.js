/*
 * Notifications (LOT 5) — module partagé client/serveur, sans DOM ni réseau.
 *
 * Événements notifiés aux DEUX agences concernées (expéditrice et
 * destination du colis, ou émettrice et destinataire du bordereau) :
 *   - incident ouvert (manuel, ou automatique au contrôle d'arrivée) ;
 *   - incident non résolu depuis plus de 24 h (escalade) ;
 *   - bordereau arrivé, écart au contrôle d'arrivée ;
 *   - colis en souffrance (arrivé non retiré depuis plus de 7 jours) ;
 *   - retour à l'expéditeur décidé / reçu ;
 *   - alertes « colis qui dorment » (48 h sans mouvement, 72 h non retiré,
 *     7 jours sans agence de destination rattachée).
 *
 * Règle d'or : un message de notification est destiné à SORTIR de
 * l'application (WhatsApp, SMS, e-mail une fois branchés). Il ne contient
 * donc JAMAIS de donnée personnelle : ni nom, ni téléphone, ni CNI des
 * clients, ni identité des agents, ni note libre (une note d'incident peut
 * citer un client), ni téléphone du transporteur. Seuls circulent : codes de
 * suivi et de bordereau, villes, type d'incident, durées et nombres de colis.
 * Les constructeurs ci-dessous ne lisent QUE ces champs (projections
 * explicites) — aucun objet n'est recopié tel quel.
 */
import { evaluerAlertes } from "./metier-alertes.js";
import { textePropre } from "./metier-colis.js";
import { escaladeIncident, libelleTypeIncident } from "./metier-incidents.js";

export const TYPES_NOTIFICATION = [
  { id: "incident_ouvert", label: "Incident ouvert", famille: "incidents" },
  { id: "incident_escalade", label: "Incident non résolu depuis 24 h", famille: "incidents" },
  { id: "bordereau_arrive", label: "Bordereau arrivé", famille: "bordereaux" },
  { id: "bordereau_ecart", label: "Écart au contrôle d'arrivée", famille: "bordereaux" },
  { id: "colis_souffrance", label: "Colis en souffrance", famille: "souffrance" },
  { id: "retour_decide", label: "Retour à l'expéditeur décidé", famille: "souffrance" },
  { id: "retour_recu", label: "Retour à l'expéditeur reçu", famille: "souffrance" },
  { id: "alerte_sans_mouvement", label: "Sans mouvement depuis 48 h", famille: "dorment" },
  { id: "alerte_non_retire", label: "Non retiré depuis 72 h", famille: "dorment" },
  { id: "alerte_non_rattache", label: "Agence de destination non rattachée", famille: "dorment" }
];

export const FAMILLES_NOTIFICATION = [
  { id: "incidents", label: "Incidents" },
  { id: "bordereaux", label: "Bordereaux" },
  { id: "souffrance", label: "Souffrance et retours" },
  { id: "dorment", label: "Colis qui dorment" }
];

/** Canaux connus. Seule la simulation est active tant qu'aucun transport réel n'est configuré. */
export const CANAUX_NOTIFICATION = [
  { id: "simulation", label: "Simulation" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "sms", label: "SMS" },
  { id: "email", label: "E-mail" }
];

export const STATUTS_NOTIFICATION = [
  { id: "en_attente", label: "En attente" },
  { id: "simule", label: "Simulée (aucun envoi réel)" },
  { id: "envoye", label: "Envoyée" },
  { id: "echec", label: "Échec d'envoi" }
];

/** Nombre maximal de codes de colis cités dans un message d'écart. */
export const MAX_CODES_ECART = 10;

export function estTypeNotification(type) {
  return TYPES_NOTIFICATION.some((item) => item.id === type);
}

export function estFamilleNotification(famille) {
  return FAMILLES_NOTIFICATION.some((item) => item.id === famille);
}

export function libelleTypeNotification(type) {
  return TYPES_NOTIFICATION.find((item) => item.id === type)?.label || type;
}

export function familleNotification(type) {
  return TYPES_NOTIFICATION.find((item) => item.id === type)?.famille || null;
}

export function libelleCanalNotification(canal) {
  return CANAUX_NOTIFICATION.find((item) => item.id === canal)?.label || canal;
}

export function libelleStatutNotification(statut) {
  return STATUTS_NOTIFICATION.find((item) => item.id === statut)?.label || statut;
}

/** Destinataires : agences distinctes, sans valeur vide (destination non rattachée = une seule agence). */
export function destinatairesNotification(...agencyIds) {
  return [...new Set(agencyIds.flat().map((id) => textePropre(id)).filter(Boolean))];
}

/**
 * Agences concernées par un événement : les deux agences du colis, sinon
 * celles du bordereau. Jamais d'autre destinataire (aucun client, aucun tiers).
 */
export function agencesConcernees(evenement = {}) {
  const parcel = evenement.parcel;
  if (parcel) {
    return destinatairesNotification(parcel.ownerId ?? parcel.owner_id, parcel.destinationAgencyId ?? parcel.destination_agency_id);
  }
  const bordereau = evenement.bordereau;
  if (bordereau) {
    return destinatairesNotification(bordereau.fromAgencyId ?? bordereau.from_agency_id, bordereau.toAgencyId ?? bordereau.to_agency_id);
  }
  return [];
}

/**
 * Clé de dédoublonnage : un même événement n'est notifié qu'UNE fois à une
 * même agence. `depuis` distingue deux épisodes successifs d'une même alerte
 * (ex. un colis qui redort après avoir bougé).
 */
export function cleNotification({ type, refId, agencyId, depuis = "" }) {
  return [type, refId, textePropre(depuis), agencyId].filter(Boolean).join(":");
}

/* ------------------- projections sans donnée personnelle ------------------ */

function colisSur(parcel = {}) {
  return {
    id: textePropre(parcel.id),
    code: textePropre(parcel.trackingCode ?? parcel.tracking_code),
    origine: textePropre(parcel.originCity ?? parcel.origin_city),
    destination: textePropre(parcel.destinationCity ?? parcel.destination_city),
    statut: textePropre(parcel.status)
  };
}

function bordereauSur(bordereau = {}) {
  return {
    id: textePropre(bordereau.id),
    code: textePropre(bordereau.code),
    origine: textePropre(bordereau.fromCity ?? bordereau.from_city),
    destination: textePropre(bordereau.toCity ?? bordereau.to_city),
    colis: Math.max(0, Math.floor(Number(bordereau.parcelCount ?? bordereau.parcel_count) || 0))
  };
}

function incidentSur(incident = {}) {
  return {
    id: textePropre(incident.id),
    type: textePropre(incident.type),
    automatique: incident.automatique === true
  };
}

function trajet(origine, destination) {
  return origine && destination ? ` (${origine} → ${destination})` : "";
}

function pluriel(n, singulier, plurielTexte = `${singulier}s`) {
  return `${n} ${n > 1 ? plurielTexte : singulier}`;
}

/**
 * Construit le message d'un événement. Renvoie `null` si le type est inconnu
 * ou si une pièce indispensable manque (l'appelant ignore alors l'événement).
 * Résultat : `{ type, titre, message, lien, parcelId, bordereauId,
 * incidentId, refId }` — texte en français, sans donnée personnelle.
 */
export function construireNotification(evenement = {}) {
  const type = textePropre(evenement.type);
  if (!estTypeNotification(type)) return null;

  const colis = evenement.parcel ? colisSur(evenement.parcel) : null;
  const lot = evenement.bordereau ? bordereauSur(evenement.bordereau) : null;
  const incident = evenement.incident ? incidentSur(evenement.incident) : null;
  const heures = Math.max(0, Math.floor(Number(evenement.heures) || 0));
  const jours = Math.max(0, Math.floor(Number(evenement.jours ?? heures / 24) || 0));

  const besoinColis = !["bordereau_arrive", "bordereau_ecart"].includes(type);
  if (besoinColis && !(colis?.id && colis.code)) return null;
  if (!besoinColis && !(lot?.id && lot.code)) return null;
  if (type.startsWith("incident_") && !incident?.id) return null;

  let titre = "";
  let message = "";
  switch (type) {
    case "incident_ouvert": {
      const libelle = libelleTypeIncident(incident.type);
      titre = `Incident ouvert — ${colis.code}`;
      message = incident.automatique && lot
        ? `Incident « ${libelle} » ouvert automatiquement : le colis ${colis.code} était absent au contrôle d'arrivée du bordereau ${lot.code}${trajet(lot.origine, lot.destination)}. Lancez les recherches depuis la fiche du colis.`
        : `Incident « ${libelle} » ouvert sur le colis ${colis.code}${trajet(colis.origine, colis.destination)}. Suivez les recherches depuis la fiche du colis.`;
      break;
    }
    case "incident_escalade": {
      const libelle = libelleTypeIncident(incident.type);
      titre = `Incident non résolu depuis plus de 24 h — ${colis.code}`;
      message = `L'incident « ${libelle} » du colis ${colis.code}${trajet(colis.origine, colis.destination)} est ouvert depuis ${heures >= 48 ? pluriel(Math.floor(heures / 24), "jour") : `${heures} h`}. Relancez les recherches ou résolvez-le : au-delà de 7 jours, il part en arbitrage plateforme.`;
      break;
    }
    case "bordereau_arrive": {
      const details = [
        lot.origine && lot.destination ? `${lot.origine} → ${lot.destination}` : "",
        lot.colis ? pluriel(lot.colis, "colis", "colis") : ""
      ].filter(Boolean).join(", ");
      titre = `Bordereau arrivé — ${lot.code}`;
      message = `Le bordereau ${lot.code}${details ? ` (${details})` : ""} est arrivé à destination. Le contrôle d'arrivée se fait en cases à cocher depuis la page Bordereaux.`;
      break;
    }
    case "bordereau_ecart": {
      const codes = (Array.isArray(evenement.absents) ? evenement.absents : [])
        .map((code) => textePropre(code))
        .filter(Boolean);
      const cites = codes.slice(0, MAX_CODES_ECART).join(", ");
      const nbAbsents = codes.length || Math.max(0, Math.floor(Number(evenement.nbAbsents) || 0));
      titre = `Écart au contrôle d'arrivée — ${lot.code}`;
      message = `Écart au contrôle du bordereau ${lot.code}${trajet(lot.origine, lot.destination)} : ${pluriel(nbAbsents, "colis absent", "colis absents")}${lot.colis ? ` sur ${lot.colis}` : ""}${cites ? ` (${cites}${codes.length > MAX_CODES_ECART ? "…" : ""})` : ""}. Un incident « Perdu » est ouvert automatiquement pour chaque absent.`;
      break;
    }
    case "colis_souffrance":
      titre = `Colis en souffrance — ${colis.code}`;
      message = `Le colis ${colis.code}${trajet(colis.origine, colis.destination)} est arrivé depuis ${pluriel(Math.max(jours, 7), "jour")} sans être retiré : il est en souffrance. Le retour à l'expéditeur se décide depuis la fiche du colis.`;
      break;
    case "retour_decide":
      titre = `Retour à l'expéditeur décidé — ${colis.code}`;
      message = `Le retour à l'expéditeur du colis ${colis.code}${trajet(colis.origine, colis.destination)} est décidé : colis non retiré à destination. L'agence expéditrice confirmera la réception du colis.`;
      break;
    case "retour_recu":
      titre = `Retour à l'expéditeur reçu — ${colis.code}`;
      message = `Le colis ${colis.code}${trajet(colis.origine, colis.destination)} est revenu à l'agence expéditrice : le retour à l'expéditeur est terminé.`;
      break;
    case "alerte_sans_mouvement":
      titre = `Colis sans mouvement — ${colis.code}`;
      message = `Le colis ${colis.code}${trajet(colis.origine, colis.destination)} est « ${colis.statut || "En transit"} » sans mouvement depuis plus de 48 h. Relancez le transporteur.`;
      break;
    case "alerte_non_retire":
      titre = `Colis non retiré — ${colis.code}`;
      message = `Le colis ${colis.code}${trajet(colis.origine, colis.destination)} attend son retrait depuis plus de 72 h. Pensez à relancer le destinataire.`;
      break;
    case "alerte_non_rattache":
      titre = `Agence de destination à rattacher — ${colis.code}`;
      message = `Le colis ${colis.code}${colis.destination ? ` vers ${colis.destination}` : ""} n'a toujours pas d'agence de destination rattachée après ${pluriel(Math.max(jours, 7), "jour")}. Invitez l'agence à créer son compte, puis rattachez-la depuis la fiche du colis.`;
      break;
    default:
      return null;
  }

  const refId = type.startsWith("incident_") ? incident.id : besoinColis ? colis.id : lot.id;
  const lien = besoinColis
    ? `colis.html?id=${encodeURIComponent(colis.id)}`
    : `bordereaux.html?id=${encodeURIComponent(lot.id)}`;
  return {
    type,
    titre,
    message,
    lien,
    parcelId: colis?.id || null,
    bordereauId: lot?.id || null,
    incidentId: incident?.id || null,
    refId
  };
}

/**
 * Une notification par agence destinataire, chacune avec sa clé de
 * dédoublonnage. `agencyIds` absent = agences concernées par l'événement.
 */
export function notificationsPourAgences(evenement = {}, agencyIds = null) {
  const base = construireNotification(evenement);
  if (!base) return [];
  const agences = destinatairesNotification(agencyIds ?? agencesConcernees(evenement));
  return agences.map((agencyId) => ({
    ...base,
    agencyId,
    cle: cleNotification({ type: base.type, refId: base.refId, agencyId, depuis: evenement.depuis })
  }));
}

/* ------------------------------ échéances --------------------------------- */

const TYPE_PAR_ALERTE = {
  sans_mouvement: "alerte_sans_mouvement",
  non_retire: "alerte_non_retire",
  non_rattache: "alerte_non_rattache",
  souffrance: "colis_souffrance"
};

/**
 * Événements d'échéance à l'instant `now` pour une liste de colis (format
 * interface : `ownerId`, `destinationAgencyId`, `status`, `history`…) et
 * leurs incidents (format `normaliserIncident`) : escalade d'incident > 24 h,
 * souffrance > 7 j et colis qui dorment (48 h / 72 h / 7 j), avec les mêmes
 * seuils que les cartes « À traiter » (js/metier-alertes.js). Chaque
 * événement porte ses destinataires et sa date de début d'épisode
 * (`depuis`) : un balayage répété ne notifie jamais deux fois.
 */
export function evenementsEcheance({ parcels = [], incidents = [], now = new Date() } = {}) {
  const evenements = [];
  const parId = new Map();
  for (const parcel of parcels) {
    if (!parcel?.id) continue;
    parId.set(parcel.id, parcel);
    const agences = agencesConcernees({ parcel });
    for (const alerte of evaluerAlertes(parcel, now)) {
      const type = TYPE_PAR_ALERTE[alerte.cle];
      if (!type) continue;
      evenements.push({
        type,
        parcel,
        agences,
        depuis: alerte.sinceISO ?? "",
        heures: alerte.heures,
        jours: Math.floor(alerte.heures / 24)
      });
    }
  }
  for (const incident of incidents) {
    if (!incident || incident.state === "resolu") continue;
    const parcel = parId.get(incident.parcelId);
    if (!parcel) continue;
    const escalade = escaladeIncident({ incident, now });
    if (!escalade.alerte24h) continue;
    evenements.push({
      type: "incident_escalade",
      parcel,
      incident,
      agences: agencesConcernees({ parcel }),
      heures: escalade.heures
    });
  }
  return evenements;
}

/* --------------------------- journal (lecture) ---------------------------- */

/** Ligne SQL → notification du journal (camelCase, sans clé interne). */
export function normaliserNotification(row = {}) {
  if (!row) return null;
  const type = row.type;
  return {
    id: row.id,
    type,
    famille: familleNotification(type),
    titre: row.titre ?? "",
    message: row.message ?? "",
    lien: row.lien ?? "",
    parcelId: row.parcel_id ?? row.parcelId ?? null,
    bordereauId: row.bordereau_id ?? row.bordereauId ?? null,
    incidentId: row.incident_id ?? row.incidentId ?? null,
    canal: row.canal ?? "simulation",
    statut: row.statut ?? "simule",
    erreur: row.erreur ?? "",
    lu: row.lu === true,
    createdAtISO: row.created_at_iso ?? row.createdAtISO
  };
}

/** Filtre du journal (page Notifications) : famille d'événements et/ou non lues. */
export function filtrerNotifications({ notifications = [], famille = "", nonLuesSeulement = false } = {}) {
  return notifications.filter((item) =>
    (!famille || item.famille === famille || familleNotification(item.type) === famille) &&
    (!nonLuesSeulement || item.lu !== true)
  );
}

/** Compteurs du journal : total, non lues, et répartition par famille. */
export function resumeNotifications(notifications = []) {
  const parFamille = Object.fromEntries(FAMILLES_NOTIFICATION.map((item) => [item.id, 0]));
  let nonLues = 0;
  for (const item of notifications) {
    const famille = item.famille || familleNotification(item.type);
    if (famille in parFamille) parFamille[famille] += 1;
    if (item.lu !== true) nonLues += 1;
  }
  return { total: notifications.length, nonLues, parFamille };
}
