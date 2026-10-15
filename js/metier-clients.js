/*
 * Carnet de clients (LOT 3) : expéditeurs et destinataires mémorisés par
 * agence. Module partagé client/serveur — aucune dépendance DOM ni réseau,
 * testable avec `node --test`.
 *
 * Règles :
 *   - le carnet appartient à l'agence : jamais de visibilité croisée ;
 *   - la clé pratique est le téléphone ivoirien (recherche au guichet) ;
 *   - la CNI n'est mémorisée que pour un expéditeur ;
 *   - aucune suppression : un client connu reste connu (upsert).
 */
import { textePropre } from "./metier-colis.js";
import { isValidCni, isValidIvorianPhone, normalizeIvorianPhone } from "./utils.js";

export const TYPES_CLIENT = [
  { id: "expediteur", label: "Expéditeur" },
  { id: "destinataire", label: "Destinataire" }
];

const NOM = [1, 60];

export function estTypeClient(kind) {
  return TYPES_CLIENT.some((item) => item.id === kind);
}

function dansLimite(value, [min, max]) {
  return value.length >= min && value.length <= max;
}

/** Ligne SQL (ou objet mêlé) → objet métier camelCase. */
export function normaliserClient(row = {}) {
  return {
    id: row.id,
    agencyId: row.agency_id ?? row.agencyId,
    kind: row.kind,
    firstName: textePropre(row.first_name ?? row.firstName),
    lastName: textePropre(row.last_name ?? row.lastName),
    phone: normalizeIvorianPhone(row.phone ?? ""),
    cni: textePropre(row.cni ?? "").toUpperCase() || null,
    city: textePropre(row.city ?? ""),
    notes: textePropre(row.notes ?? ""),
    createdAtISO: row.created_at_iso ?? row.createdAtISO ?? null,
    updatedAtISO: row.updated_at_iso ?? row.updatedAtISO ?? null
  };
}

/** Nom complet affiché dans les listes et le pré-remplissage. */
export function nomClient(client = {}) {
  return textePropre(`${client.firstName || ""} ${client.lastName || ""}`);
}

/**
 * Contrôle d'une fiche client. Renvoie `{ error }` ou `{ valeur }`.
 * La CNI est facultative pour un expéditeur, interdite pour un destinataire.
 */
export function validerClient(input = {}) {
  const kind = textePropre(input.kind);
  if (!estTypeClient(kind)) {
    return { error: "Choisissez le rôle du client : expéditeur ou destinataire." };
  }
  const firstName = textePropre(input.firstName);
  const lastName = textePropre(input.lastName);
  if (!dansLimite(firstName, NOM) || !dansLimite(lastName, NOM)) {
    return { error: "Renseignez le prénom et le nom du client (60 caractères maximum chacun)." };
  }
  const phone = normalizeIvorianPhone(input.phone ?? "");
  if (!isValidIvorianPhone(phone)) {
    return { error: "Saisissez un téléphone ivoirien valide (10 chiffres) : c'est la clé du carnet." };
  }
  let cni = null;
  if (kind === "expediteur") {
    const brut = textePropre(input.cni);
    if (brut) {
      if (!isValidCni(brut)) {
        return { error: "Le numéro CNI doit contenir 8 à 25 caractères et au moins un chiffre." };
      }
      cni = brut.toUpperCase();
    }
  }
  const city = textePropre(input.city);
  if (city.length > 60) {
    return { error: "La ville ne doit pas dépasser 60 caractères." };
  }
  const notes = textePropre(input.notes);
  if (notes.length > 500) {
    return { error: "La note ne doit pas dépasser 500 caractères." };
  }
  return { valeur: { kind, firstName, lastName, phone, cni, city, notes } };
}

/**
 * Mémorisation automatique depuis un colis enregistré : l'expéditeur (avec sa
 * CNI et la ville de départ) et le destinataire (ville d'arrivée) entrent
 * dans le carnet de l'agence expéditrice. Renvoie les deux fiches à upserter.
 */
export function clientsDepuisColis(parcel = {}) {
  const fiches = [];
  const sender = parcel.sender || {};
  const recipient = parcel.recipient || {};
  if (isValidIvorianPhone(sender.phone)) {
    fiches.push({
      kind: "expediteur",
      firstName: textePropre(sender.firstName),
      lastName: textePropre(sender.lastName),
      phone: normalizeIvorianPhone(sender.phone),
      cni: textePropre(sender.cni).toUpperCase() || null,
      city: textePropre(parcel.originCity),
      notes: ""
    });
  }
  if (isValidIvorianPhone(recipient.phone)) {
    fiches.push({
      kind: "destinataire",
      firstName: textePropre(recipient.firstName),
      lastName: textePropre(recipient.lastName),
      phone: normalizeIvorianPhone(recipient.phone),
      cni: null,
      city: textePropre(parcel.destinationCity),
      notes: ""
    });
  }
  return fiches.filter((fiche) => fiche.firstName && fiche.lastName);
}

/**
 * Recherche dans le carnet : par téléphone (correspondance sur les chiffres
 * normalisés) ou par nom (insensible à la casse/accents sur le début du mot).
 * Liste vide = aucun filtre.
 */
export function rechercherClients({ clients = [], recherche = "", kind = "" }) {
  const brut = textePropre(recherche);
  const chiffres = normalizeIvorianPhone(brut);
  const terme = brut
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return clients
    .filter((client) => !kind || client.kind === kind)
    .filter((client) => {
      if (!brut) return true;
      if (chiffres.length >= 2 && client.phone.includes(chiffres)) return true;
      const nom = nomClient(client)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
      return terme.length >= 2 && nom.includes(terme);
    })
    .sort((a, b) => nomClient(a).localeCompare(nomClient(b), "fr", { sensitivity: "base" }));
}
