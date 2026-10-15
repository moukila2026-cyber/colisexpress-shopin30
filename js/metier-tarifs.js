/*
 * Grille tarifaire : axes (ville départ → ville arrivée ou « toutes
 * destinations ») × tranches de poids → prix FCFA, plus les listes
 * d'options alimentant le menu déroulant du formulaire « nouveau colis ».
 *
 * Aucun import de DOM ni d'accès réseau : testable avec `node --test`.
 * Partagé client/serveur — le serveur recalcule toujours le prix depuis
 * cette grille (autorité serveur), le menu déroulant n'est qu'un affichage.
 */
import { textePropre } from "./metier-colis.js";

/** Tranches proposées par défaut dans l'interface (libellé = texte affiché). */
export const TRANCHES_DEFAUT = [
  { cle: "0-2", label: "0 – 2 kg", minKg: 0, maxKg: 2 },
  { cle: "2-5", label: "2 – 5 kg", minKg: 2, maxKg: 5 },
  { cle: "5-10", label: "5 – 10 kg", minKg: 5, maxKg: 10 },
  { cle: "10+", label: "+ 10 kg", minKg: 10, maxKg: null }
];

/** Modes d'encaissement de la caisse. */
export const MODES_ENCAISSEMENT = [
  { id: "especes", label: "Espèces" },
  { id: "mobile_money", label: "Mobile Money" }
];

export function estModeEncaissement(mode) {
  return MODES_ENCAISSEMENT.some((item) => item.id === mode);
}

/** Clé de comparaison d'une ville (sans casse, espaces réduits). */
export function cleVille(ville) {
  return textePropre(ville).toLowerCase();
}

/** Libellé d'une tranche de poids. */
export function trancheLibelle(minKg, maxKg) {
  const min = Number(minKg);
  if (maxKg === null || maxKg === undefined || maxKg === "") return `+ ${formatKg(min)} kg`;
  return `${formatKg(min)} – ${formatKg(Number(maxKg))} kg`;
}

function formatKg(valeur) {
  return Number.isInteger(valeur) ? String(valeur) : String(valeur).replace(".", ",");
}

/** Normalisation d'une ligne de grille (SQL → objet métier). */
export function normaliserTarif(row = {}) {
  return {
    id: row.id,
    agencyId: row.agency_id ?? row.agencyId,
    originCity: textePropre(row.origin_city ?? row.originCity),
    destinationCity: textePropre(row.destination_city ?? row.destinationCity),
    weightMinKg: Number(row.weight_min_kg ?? row.weightMinKg),
    weightMaxKg: row.weight_max_kg ?? row.weightMaxKg ?? null,
    priceFCFA: Math.round(Number(row.price_fcfa ?? row.priceFCFA)),
    active: (row.active ?? true) === true,
    createdAtISO: row.created_at_iso ?? row.createdAtISO ?? null
  };
}

/**
 * Contrôle d'une ligne de grille. Renvoie `{ error }` ou `{ valeur }`.
 * `destinationCity` vide = toutes destinations (autorisé et voulu).
 */
export function validerTarif(input = {}) {
  const originCity = textePropre(input.originCity);
  const destinationCity = textePropre(input.destinationCity);
  if (originCity.length < 2 || originCity.length > 60) {
    return { error: "La ville de départ du tarif doit contenir 2 à 60 caractères." };
  }
  if (destinationCity.length > 60) {
    return { error: "La ville d'arrivée du tarif ne doit pas dépasser 60 caractères." };
  }
  const minKg = Number(input.weightMinKg);
  const brutMax = input.weightMaxKg;
  const maxKg = brutMax === null || brutMax === undefined || brutMax === "" ? null : Number(brutMax);
  if (!Number.isFinite(minKg) || minKg < 0) {
    return { error: "Le poids minimum de la tranche doit être un nombre positif (0 kg minimum)." };
  }
  if (maxKg !== null && (!Number.isFinite(maxKg) || maxKg <= minKg)) {
    return { error: "Le poids maximum de la tranche doit être supérieur au poids minimum." };
  }
  const priceFCFA = Number(input.priceFCFA);
  if (!Number.isFinite(priceFCFA) || priceFCFA < 0 || !Number.isInteger(Math.round(priceFCFA))) {
    return { error: "Le prix du tarif doit être un montant entier en FCFA." };
  }
  return {
    valeur: {
      originCity,
      destinationCity,
      weightMinKg: minKg,
      weightMaxKg: maxKg,
      priceFCFA: Math.round(priceFCFA)
    }
  };
}

/** Le poids tombe dans la tranche [min ; max[ (max null = sans limite). */
export function poidsDansTranche(poids, tarif) {
  const kg = Number(poids);
  if (!Number.isFinite(kg)) return false;
  if (kg < Number(tarif.weightMinKg)) return false;
  if (tarif.weightMaxKg === null || tarif.weightMaxKg === undefined) return true;
  return kg < Number(tarif.weightMaxKg);
}

function estDestinationValide(tarif, destinationCity) {
  const cible = cleVille(destinationCity);
  if (cleVille(tarif.destinationCity) === cible) return "exacte";
  if (!textePropre(tarif.destinationCity)) return "toutes";
  return null;
}

/**
 * Lignes de grille applicables à un envoi, TRIÉES du plus spécifique au moins
 * spécifique : destination exacte avant « toutes destinations », tranche la
 * plus étroite d'abord, ancienneté croissante en dernier recours.
 */
export function tarifsApplicables({ tarifs = [], originCity, destinationCity, weightKg }) {
  const origine = cleVille(originCity);
  const matches = (Array.isArray(tarifs) ? tarifs : [])
    .map((tarif) => (tarif.originCity !== undefined ? tarif : normaliserTarif(tarif)))
    .filter((tarif) => tarif.active !== false)
    .filter((tarif) => cleVille(tarif.originCity) === origine)
    .map((tarif) => ({ tarif, destination: estDestinationValide(tarif, destinationCity) }))
    .filter((item) => item.destination !== null)
    .filter((item) => poidsDansTranche(weightKg, item.tarif));

  matches.sort((a, b) => {
    if (a.destination !== b.destination) return a.destination === "exacte" ? -1 : 1;
    const largeurA = a.tarif.weightMaxKg === null || a.tarif.weightMaxKg === undefined
      ? Number.POSITIVE_INFINITY
      : Number(a.tarif.weightMaxKg) - Number(a.tarif.weightMinKg);
    const largeurB = b.tarif.weightMaxKg === null || b.tarif.weightMaxKg === undefined
      ? Number.POSITIVE_INFINITY
      : Number(b.tarif.weightMaxKg) - Number(b.tarif.weightMinKg);
    if (largeurA !== largeurB) return largeurA - largeurB;
    return String(a.tarif.createdAtISO || "").localeCompare(String(b.tarif.createdAtISO || ""));
  });
  return matches.map((item) => item.tarif);
}

/** Prix à appliquer pour un envoi, ou `null` quand la grille ne couvre pas l'axe. */
export function trouverTarif({ tarifs = [], originCity, destinationCity, weightKg }) {
  return tarifsApplicables({ tarifs, originCity, destinationCity, weightKg })[0] ?? null;
}

/**
 * Devis public (LOT 3) : à partir des grilles ACTIVES de toutes les agences,
 * calcule les offres applicables à un axe (ville départ → ville arrivée) et
 * un poids. Chaque ligne de `tarifs` porte l'agence normalisée
 * (`{ name, city, phone }`) — jamais d'identifiant interne ni de donnée
 * personnelle en sortie. Offres triées par prix croissant ; liste vide =
 * aucune agence ne couvre cet axe dans sa grille.
 */
export function estimerDevis({ tarifs = [], originCity, destinationCity, weightKg }) {
  const parAgence = new Map();
  for (const brut of Array.isArray(tarifs) ? tarifs : []) {
    const tarif = brut.originCity !== undefined ? brut : normaliserTarif(brut);
    const agence = tarif.agence ?? brut.agence ?? null;
    if (!agence?.name) continue;
    const cle = `${agence.name}|${agence.city}|${agence.phone}`;
    if (!parAgence.has(cle)) parAgence.set(cle, { agence, tarifs: [] });
    parAgence.get(cle).tarifs.push(tarif);
  }
  const offres = [];
  for (const { agence, tarifs: grille } of parAgence.values()) {
    const tarif = trouverTarif({ tarifs: grille, originCity, destinationCity, weightKg });
    if (!tarif) continue;
    offres.push({
      priceFCFA: tarif.priceFCFA,
      tranche: trancheLibelle(tarif.weightMinKg, tarif.weightMaxKg),
      destination: textePropre(tarif.destinationCity) || "toutes destinations",
      agence: {
        name: textePropre(agence.name),
        city: textePropre(agence.city),
        phone: textePropre(agence.phone)
      }
    });
  }
  offres.sort((a, b) => a.priceFCFA - b.priceFCFA || a.agence.name.localeCompare(b.agence.name, "fr"));
  return offres;
}

/**
 * Options du menu déroulant « prix » : une option par ligne applicable,
 * la plus spécifique en premier (c'est celle appliquée par défaut).
 * Liste vide = grille non applicable → saisie libre autorisée (repli).
 */
export function optionsPrix({ tarifs = [], originCity, destinationCity, weightKg }) {
  return tarifsApplicables({ tarifs, originCity, destinationCity, weightKg }).map((tarif) => ({
    tarifId: tarif.id,
    priceFCFA: tarif.priceFCFA,
    tranche: trancheLibelle(tarif.weightMinKg, tarif.weightMaxKg),
    destination: textePropre(tarif.destinationCity) || "toutes destinations",
    label: `${new Intl.NumberFormat("fr-CI", { maximumFractionDigits: 0 }).format(tarif.priceFCFA)} FCFA — ${trancheLibelle(tarif.weightMinKg, tarif.weightMaxKg)}`
  }));
}
