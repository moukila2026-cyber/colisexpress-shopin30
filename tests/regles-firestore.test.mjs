/*
 * Garde-fous sur firestore.rules.
 *
 * Le sandbox n'a ni Firebase, ni Java, ni l'émulateur : ces tests ne remplacent
 * PAS l'exécution des règles par Firestore. Ils vérifiable deux choses mesurables :
 *   1. les invariants de sécurité sont toujours écrits dans firestore.rules ;
 *   2. les écritures produites par l'application (js/metier-colis.js) satisfont ces
 *      invariants, et les tentatives d'abus sont refusées par un oracle qui en est
 *      la traduction fidèle (les listes de clés sont lues dans le fichier de règles,
 *      donc toute divergence entre l'app et les règles casse un test).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  changementsRattachement,
  construireColis,
  construireSuiviPublic,
  resoudreDestination
} from "../js/metier-colis.js";
import { isValidIvorianPhone, normalizeIvorianPhone } from "../js/utils.js";

const RACINE = path.resolve(import.meta.dirname, "..");
const REGLES = readFileSync(path.join(RACINE, "firestore.rules"), "utf8");

function parseListe(contenu) {
  return contenu.split(",").map((item) => item.trim().replace(/^'|'$/g, "")).filter(Boolean);
}

const HAS_ONLY = [...REGLES.matchAll(/hasOnly\(\[([\s\S]*?)\]\)/g)].map((match) => parseListe(match[1]));
const HAS_ALL = [...REGLES.matchAll(/hasAll\(\[([\s\S]*?)\]\)/g)].map((match) => parseListe(match[1]));
const listeContenant = (cle) => HAS_ONLY.find((liste) => liste.includes(cle));

const CLES_AGENCE = listeContenant("phone");
const CLES_SUIVI = listeContenant("lastUpdatedAtISO");
const CLES_PROGRESSION = listeContenant("collectedBy");
const CLES_RATTACHEMENT = listeContenant("destinationAgencyAttachedAt");
const CLES_CREATEUR = HAS_ALL[0];

const PHONE_REGLES = /matches\('([^']+)'\)/.exec(REGLES)[1];
const PHONE = new RegExp(PHONE_REGLES);

/* --------------------------- structure des règles --------------------------- */

test("firestore.rules reste en version 2 et refuse tout suppress", () => {
  assert.match(REGLES, /^rules_version = '2';/m);
  assert.match(REGLES, /service cloud\.Firestore|service cloud\.firestore/);
  assert.equal(REGLES.split("").filter((c) => c === "{").length, REGLES.split("").filter((c) => c === "}").length, "accolles déséquilibrées");
  assert.doesNotMatch(REGLES, /allow\s+delete:\s+if\s+(?!false)/, "un delete autorisé s'est glissé");
  assert.doesNotMatch(REGLES, /allow\s+write:/, "allow write ouvre create+update+delete d'un coup");
  for (const collection of ["agences", "colis", "suivis"]) {
    const bloc = new RegExp(`match /${collection}/\\{[^}]+\\} \\{([\\s\\S]*?)\\n    \\}`).exec(REGLES);
    assert.ok(bloc, `bloc manquant pour /${collection}`);
    assert.match(bloc[1], /allow delete: if false;/);
  }
});

test("aucun document privé n'est lisible par le public", () => {
  const blocColis = /match \/colis\/\{parcelId\} \{([\s\S]*?)\n    \}/.exec(REGLES)[1];
  assert.doesNotMatch(blocColis, /allow (get|list|read): if true/);
  const blocAgences = /match \/agences\/\{agencyId\} \{([\s\S]*?)\n    \}/.exec(REGLES)[1];
  assert.doesNotMatch(blocAgences, /allow (get|list|read): if true/);
  assert.match(blocAgences, /allow get, list: if signedIn\(\);/);
  assert.match(blocAgences, /allow update: if signedIn\(\) && request\.auth\.uid == agencyId/);
  assert.match(blocAgences, /hasOnly\(\[[^\]]*'name'[^\]]*'city'[^\]]*'phone'[^\]]*\]\)/);
});

test("le suivi public reste ouvert en lecture mais verrouillé en écriture", () => {
  const bloc = /match \/suivis\/\{code\} \{([\s\S]*?)\n    \}/.exec(REGLES)[1];
  assert.match(bloc, /allow read: if true;/);
  assert.match(bloc, /allow create: if signedIn\(\) &&\s*isValidPublicTracking/);
  assert.match(bloc, /allow update: if signedIn\(\) &&\s*resource\.data\.colisId == request\.resource\.data\.colisId/);
  assert.match(bloc, /trackingMatchesParcel\(request\.resource\.data, code\)/);
});

test("la création exige le compte de l'appelant et une destination déclarée ou inscrite", () => {
  const bloc = /match \/colis\/\{parcelId\} \{([\s\S]*?)\n    \}/.exec(REGLES)[1];
  assert.match(bloc, /allow create: if signedIn\(\) &&/);
  assert.match(bloc, /request\.resource\.data\.ownerId == request\.auth\.uid/);
  assert.match(bloc, /request\.resource\.data\.status == 'Enregistré'/, "un colis doit démarrer à « Enregistré »");
  assert.match(bloc, /request\.resource\.data\.history is list && size\(request\.resource\.data\.history\) >= 1/);
  assert.match(bloc, /agencyExists\(request\.resource\.data\.destinationAgencyId\)/);
  assert.match(bloc, /request\.resource\.data\.destinationAgencyId != request\.auth\.uid/);
  assert.match(bloc, /request\.resource\.data\.destinationAgencyId == null/);
  assert.match(bloc, /isValidDeclaredAgency\(request\.resource\.data\.unregisteredDestinationAgency\)/);
  assert.match(bloc, /!\('unregisteredDestinationAgency' in request\.resource\.data\)/, "une agence inscrite ne doit pas traîner une déclaration");
  // Les coordonnées déclarées sont contrôlées côté serveur, pas seulement dans le formulaire.
  assert.match(REGLES, /agency\.name is string && size\(agency\.name\) >= 2 && size\(agency\.name\) <= 120/);
  assert.match(REGLES, /agency\.city is string && size\(agency\.city\) >= 2 && size\(agency\.city\) <= 60/);
  assert.match(REGLES, /agency\.phone is string && agency\.phone\.matches/);
});

test("le rattachement reste réservé à l'expéditeur, une fois, vers une agence inscrite", () => {
  const attach = /function isAttachmentUpdate\(before, after\) \{([\s\S]*?)\n      \}/.exec(REGLES)[1];
  assert.match(attach, /before\.ownerId == request\.auth\.uid/, "seul l'expéditeur rattache");
  assert.match(attach, /destinationIdOf\(before\) == null/, "rattachement unique");
  assert.match(attach, /agencyExists\(after\.destinationAgencyId\)/, "uniquement une agence inscrite");
  assert.match(attach, /after\.destinationAgencyId != request\.auth\.uid/, "jamais vers soi-même");
  assert.match(attach, /after\.status == before\.status/, "le rattachement ne fait pas avancer le colis");
  assert.match(attach, /after\.ownerId == before\.ownerId/);
  assert.match(attach, /after\.trackingCode == before\.trackingCode/);
  assert.match(attach, /after\.unregisteredDestinationAgency == before\.unregisteredDestinationAgency/, "la déclaration d'origine reste consultable");
  assert.ok(CLES_RATTACHEMENT, "liste de clés du rattachement introuvable");
  assert.deepEqual(CLES_RATTACHEMENT.filter((cle) => cle === "sender" || cle === "recipient" || cle === "collectedBy"), []);
  // L'accès au colis après update reste conditionné par la lecture : pas d'écriture aveugle.
  assert.match(REGLES, /allow update: if canReadParcel\(resource\.data\) &&/);
});

test("la progression normale ne touche ni propriétaire, ni code, ni agences", () => {
  const progression = /function isProgressUpdate\(before, after\) \{([\s\S]*?)\n      \}/.exec(REGLES)[1];
  assert.match(progression, /hasOnly\(\['status', 'history', 'updatedAt', 'collectedBy'\]\)/);
  assert.match(progression, /after\.ownerId == before\.ownerId/);
  assert.match(progression, /after\.trackingCode == before\.trackingCode/);
  assert.match(progression, /destinationIdOf\(after\) == destinationIdOf\(before\)/);
  assert.ok(CLES_PROGRESSION.includes("collectedBy") && CLES_PROGRESSION.length === 4);
});

test("le téléphone accepté par les règles est exactement celui du formulaire", () => {
  const echantillons = [
    "0700000009", "0102030405", "070000000", "07000000090", "1234567890", "0012345678",
    "+225 07-00-00-00-09", "07 00 00 00 09", "070000000a", "", "07000000091"
  ];
  for (const echantillon of echantillons) {
    const attendu = isValidIvorianPhone(echantillon);
    assert.equal(PHONE.test(normalizeIvorianPhone(echantillon)), attendu, `désaccord sur « ${echantillon} »`);
  }
});

/* ------------------------- contrat client -> règles ------------------------- */

const EXPEDITRICE = { id: "uid-1", name: "Shopin30 Abidjan", city: "Abidjan" };
const INSCRITE = { id: "uid-2", name: "Acces Bouake", city: "Bouaké" };

function valeurs(partial = {}) {
  return {
    senderFirstName: "Awa", senderLastName: "Traore", senderPhone: "0700000001", senderCni: "ci12345678",
    recipientFirstName: "Ibrahim", recipientLastName: "Kone", recipientPhone: "0500000002",
    packageNature: "Vêtements", weightKg: "2.5", priceFCFA: "3500",
    originCity: "Abidjan", destinationCity: "Bouaké", destinationAgencyId: INSCRITE.id,
    declaredAgencyName: "Flash Koloko", declaredAgencyCity: "Korhogo", declaredAgencyPhone: "0700000009",
    ...partial
  };
}

function colisCree({ agencyNotRegistered }) {
  const values = agencyNotRegistered ? valeurs({ destinationAgencyId: "" }) : valeurs({
    declaredAgencyName: "", declaredAgencyCity: "", declaredAgencyPhone: ""
  });
  const destination = resoudreDestination({
    values,
    agencies: [EXPEDITRICE, INSCRITE],
    currentAgencyId: EXPEDITRICE.id,
    agencyNotRegistered
  }).destination;
  const { parcel, publicTracking } = construireColis({
    values, currentAgency: EXPEDITRICE, destination, parcelId: "colis-1",
    trackingCode: "CLI-ABC234", nowISO: "2026-10-14T09:00:00.000Z"
  });
  return { ...parcel, createdAt: null, updatedAt: null };
}

test("les clés exigées à la création sont toutes produites par l'app", () => {
  for (const agencyNotRegistered of [false, true]) {
    const parcel = colisCree({ agencyNotRegistered });
    for (const cle of CLES_CREATEUR) {
      assert.ok(cle in parcel, `« ${cle} » manque au colis (${agencyNotRegistered ? "agence non inscrite" : "agence inscrite"})`);
    }
    assert.ok("createdAt" in parcel && "updatedAt" in parcel, "les horodatages serveur sont ajoutés par js/nouveau-colis.js");
    assert.equal(parcel.destinationAgencyId === null, agencyNotRegistered);
  }
});

test("le document public contient exactement les 7 clés autorisées", () => {
  const parcel = colisCree({ agencyNotRegistered: true });
  const suivi = construireSuiviPublic(parcel, "2026-10-14T09:00:00.000Z");
  assert.deepEqual(Object.keys(suivi).sort(), [...CLES_SUIVI].sort());
  assert.deepEqual(Object.keys(parcel.unregisteredDestinationAgency).sort(), ["city", "name", "phone"]);
});

test("le rattachement n'écrit que des clés autorisées par les règles", () => {
  const parcel = colisCree({ agencyNotRegistered: true });
  const changes = changementsRattachement({
    parcel, agency: INSCRITE, ownerAgency: EXPEDITRICE, now: "2026-10-15T08:30:00.000Z"
  });
  const ecritures = [...Object.keys(changes), "updatedAt"];
  assert.deepEqual(ecritures.filter((cle) => !CLES_RATTACHEMENT.includes(cle)), [], `clés refusées par firestore.rules : ${ecritures}`);
});

test("un changement de statut n'écrit que des clés autorisées", () => {
  const parcel = colisCree({ agencyNotRegistered: false });
  const changes = {
    status: "Expédié",
    history: [...parcel.history, { status: "Expédié", date: "2026-10-14T10:00:00.000Z" }],
    collectedBy: { name: "Ibrahim Kone", cni: "CI12345678", date: "2026-10-14T10:00:00.000Z" },
    updatedAt: null
  };
  assert.deepEqual(Object.keys(changes).filter((cle) => !CLES_PROGRESSION.includes(cle)), []);
});

/* --------------------------------- oracle --------------------------------- */

function clefsModifiees(before, after) {
  const avant = new Set(Object.keys(before));
  const apres = new Set(Object.keys(after));
  const modifiees = new Set();
  for (const cle of apres) {
    if (!avant.has(cle) || JSON.stringify(before[cle]) !== JSON.stringify(after[cle])) modifiees.add(cle);
  }
  for (const cle of avant) if (!apres.has(cle)) modifiees.add(cle);
  return modifiees;
}

function annuaireContient(annuaire, id) {
  return typeof id === "string" && id !== "" && annuaire.includes(id);
}

function declarationValide(agency) {
  return Boolean(agency) && typeof agency === "object" && !Array.isArray(agency)
    && typeof agency.name === "string" && [...agency.name].length >= 2 && [...agency.name].length <= 120
    && typeof agency.city === "string" && [...agency.city].length >= 2 && [...agency.city].length <= 60
    && typeof agency.phone === "string" && PHONE.test(agency.phone);
}

const destinationIdDe = (data) => ("destinationAgencyId" in data ? data.destinationAgencyId : null);
const peutLire = (data, auth) => Boolean(auth) && (data.ownerId === auth || (destinationIdDe(data) != null && destinationIdDe(data) === auth));

function present(data, cle) {
  return cle in data && data[cle] !== undefined && data[cle] !== null;
}

function createColis(data, { auth, annuaire }) {
  if (!auth) return false;
  for (const cle of CLES_CREATEUR) if (cle !== "destinationAgencyId" && !present(data, cle)) return false;
  if (!("destinationAgencyId" in data) || data.destinationAgencyId === undefined) return false;
  if (data.ownerId !== auth) return false;
  if (typeof data.trackingCode !== "string") return false;
  if (typeof data.destinationAgencyName !== "string" || typeof data.destinationAgencyCity !== "string") return false;
  if (data.status !== "Enregistré") return false;
  if (!Array.isArray(data.history) || data.history.length < 1) return false;
  for (const cle of ["originCity", "destinationCity"]) {
    const ville = data[cle];
    if (typeof ville !== "string" || [...ville].length < 2 || [...ville].length > 60) return false;
  }
  if (annuaireContient(annuaire, data.destinationAgencyId) && data.destinationAgencyId !== auth && !("unregisteredDestinationAgency" in data)) return true;
  return data.destinationAgencyId === null && declarationValide(data.unregisteredDestinationAgency);
}

function updateColis(before, after, { auth, annuaire }) {
  if (!peutLire(before, auth)) return false;
  const modifiees = clefsModifiees(before, after);
  const progression = [...modifiees].every((cle) => CLES_PROGRESSION.includes(cle))
    && after.ownerId === before.ownerId && after.trackingCode === before.trackingCode
    && destinationIdDe(after) === destinationIdDe(before);
  const attach = before.ownerId === auth && destinationIdDe(before) === null
    && annuaireContient(annuaire, after.destinationAgencyId) && after.destinationAgencyId !== auth
    && typeof after.destinationAgencyName === "string" && typeof after.destinationAgencyCity === "string"
    && after.status === before.status && after.ownerId === before.ownerId && after.trackingCode === before.trackingCode
    && after.unregisteredDestinationAgency === before.unregisteredDestinationAgency
    && typeof after.destinationCity === "string" && [...after.destinationCity].length >= 2 && [...after.destinationCity].length <= 60
    && [...modifiees].every((cle) => CLES_RATTACHEMENT.includes(cle));
  return progression || attach;
}

function suiviEstFidele(tracking, code, parcelApres, { auth, annuaire }) {
  if (!auth) return false;
  if (Object.keys(tracking).some((cle) => !CLES_SUIVI.includes(cle))) return false;
  if (Object.keys(tracking).length !== CLES_SUIVI.length) return false;
  if (tracking.code !== code || typeof tracking.colisId !== "string") return false;
  if (typeof tracking.status !== "string" || !Array.isArray(tracking.history)) return false;
  if (typeof tracking.originCity !== "string" || typeof tracking.destinationCity !== "string") return false;
  if (typeof tracking.lastUpdatedAtISO !== "string") return false;
  if (!suiviConformeAuColis(tracking, parcelApres)) return false;
  if (parcelApres.ownerId !== auth && destinationIdDe(parcelApres) !== auth) return false;
  return true;
}

function suiviConformeAuColis(tracking, parcel) {
  return parcel.trackingCode === tracking.code && parcel.status === tracking.status
    && JSON.stringify(parcel.history) === JSON.stringify(tracking.history)
    && parcel.originCity === tracking.originCity && parcel.destinationCity === tracking.destinationCity;
}

const ANNUAIRE = [EXPEDITRICE.id, INSCRITE.id, "uid-tierce"];

test("oracle : les créations légitimes passent", () => {
  const contextes = { auth: EXPEDITRICE.id, annuaire: ANNUAIRE };
  assert.equal(createColis(colisCree({ agencyNotRegistered: false }), contextes), true);
  assert.equal(createColis(colisCree({ agencyNotRegistered: true }), contextes), true);
  assert.equal(peutLire(colisCree({ agencyNotRegistered: true }), EXPEDITRICE.id), true);
});

test("oracle : les créations abusives sont refusées", () => {
  const contexte = { auth: EXPEDITRICE.id, annuaire: ANNUAIRE };
  const inscrit = colisCree({ agencyNotRegistered: false });
  const horsReseau = colisCree({ agencyNotRegistered: true });

  assert.equal(createColis(inscrit, { auth: "uid-tierce", annuaire: ANNUAIRE }), false, "usurper un autre expéditeur");
  assert.equal(createColis({ ...inscrit, destinationAgencyId: "uid-inexistante" }, contexte), false, "destination hors annuaire");
  assert.equal(createColis({ ...inscrit, destinationAgencyId: EXPEDITRICE.id }, contexte), false, "s'envoyer un colis à soi-même");
  assert.equal(createColis({ ...inscrit, unregisteredDestinationAgency: { name: "Flash", city: "Korhogo", phone: "0700000009" } }, contexte), false, "déclaration parasite sur une agence inscrite");
  assert.equal(createColis({ ...horsReseau, unregisteredDestinationAgency: undefined }, contexte), false, "null sans coordonnées");
  assert.equal(createColis({ ...horsReseau, unregisteredDestinationAgency: { name: "Flash", city: "Korhogo", phone: "0700" } }, contexte), false, "téléphone invalide");
  assert.equal(createColis({ ...horsReseau, unregisteredDestinationAgency: { name: "F", city: "Korhogo", phone: "0700000009" } }, contexte), false, "nom d'une seule lettre");
  assert.equal(createColis({ ...horsReseau, unregisteredDestinationAgency: { name: "Flash", city: "K", phone: "0700000009" } }, contexte), false, "ville d'une seule lettre");
  assert.equal(createColis({ ...horsReseau, history: undefined }, contexte), false, "historique absent");
  assert.equal(createColis({ ...horsReseau, history: [] }, contexte), false, "historique vide");
  assert.equal(createColis({ ...horsReseau, status: "Retiré" }, contexte), false, "créer un colis déjà retiré");
  assert.equal(createColis({ ...horsReseau, destinationCity: "B" }, contexte), false, "ville d'une lettre");
  assert.equal(createColis({ ...horsReseau, destinationAgencyId: undefined }, contexte), false, "destination non fournie du tout");
  assert.equal(createColis(inscrit, { auth: null, annuaire: ANNUAIRE }), false, "utilisateur non connecté");
});

test("oracle : le rattachement n'est possible que dans les clous", () => {
  const parcel = colisCree({ agencyNotRegistered: true });
  const changes = changementsRattachement({ parcel, agency: INSCRITE, ownerAgency: EXPEDITRICE, now: "2026-10-15T08:30:00.000Z" });
  const apres = { ...parcel, ...changes, updatedAt: "2026-10-15T08:30:00.000Z" };

  assert.equal(updateColis(parcel, apres, { auth: EXPEDITRICE.id, annuaire: ANNUAIRE }), true, "l'expéditeur rattache une agence inscrite");
  assert.equal(peutLire(apres, INSCRITE.id), true, "l'agence rattachée voit le colis");
  const apresSurPlace = { ...apres, status: "En transit", history: [...apres.history, { status: "En transit", date: "2026-10-16T08:00:00.000Z" }] };
  assert.equal(updateColis(apres, apresSurPlace, { auth: INSCRITE.id, annuaire: ANNUAIRE }), true, "une fois rattachée, l'agence de destination fait avancer le colis");
  assert.equal(updateColis(apres, apresSurPlace, { auth: "uid-tierce", annuaire: ANNUAIRE }), false, "une agence sans lien avec le colis ne peut rien écrire");
  assert.equal(updateColis(apres, { ...apresSurPlace, destinationAgencyId: EXPEDITRICE.id }, { auth: INSCRITE.id, annuaire: ANNUAIRE }), false, "l'agence rattachée ne peut pas se re-déclarer expéditrice");
  assert.equal(updateColis(apres, apres, { auth: INSCRITE.id, annuaire: ANNUAIRE }), true, "réécriture strictement identique : sans effet, donc tolérée");
  assert.equal(updateColis(parcel, apres, { auth: "uid-tierce", annuaire: ANNUAIRE }), false, "une agence tierce ne rattache rien");
  assert.equal(updateColis(parcel, { ...apres, destinationAgencyId: "uid-inexistante" }, { auth: EXPEDITRICE.id, annuaire: ANNUAIRE }), false, "rattachement à une agence non inscrite");
  assert.equal(updateColis(parcel, { ...apres, destinationAgencyId: EXPEDITRICE.id }, { auth: EXPEDITRICE.id, annuaire: ANNUAIRE }), false, "rattachement à soi-même");
  assert.equal(updateColis(parcel, { ...apres, status: "En transit" }, { auth: EXPEDITRICE.id, annuaire: ANNUAIRE }), false, "rattachement + avancement en une écriture");
  assert.equal(updateColis(parcel, { ...apres, sender: { ...apres.sender, phone: "0101010101" } }, { auth: EXPEDITRICE.id, annuaire: ANNUAIRE }), false, "profiter du rattachement pour réécrire l'expéditeur");
  assert.equal(updateColis(parcel, { ...apres, unregisteredDestinationAgency: null }, { auth: EXPEDITRICE.id, annuaire: ANNUAIRE }), false, "effacer la trace de la déclaration");
  const dejaRattache = { ...parcel, destinationAgencyId: INSCRITE.id };
  assert.equal(updateColis(dejaRattache, { ...dejaRattache, destinationAgencyId: "uid-tierce" }, { auth: EXPEDITRICE.id, annuaire: ANNUAIRE }), false, "changer d'agence après rattachement");
  assert.equal(updateColis({ ...dejaRattache, history: [] }, { ...dejaRattache, history: [{ status: "Expédié" }] }, { auth: INSCRITE.id, annuaire: ANNUAIRE }), true, "l'agence rattachée peut faire avancer le colis");
  assert.equal(updateColis(parcel, { ...parcel, trackingCode: "CLI-HACK" }, { auth: EXPEDITRICE.id, annuaire: ANNUAIRE }), false, "modifier le code de suivi");
  assert.equal(updateColis(parcel, { ...parcel, ownerId: "uid-tierce" }, { auth: EXPEDITRICE.id, annuaire: ANNUAIRE }), false, "céder la propriété");
});

test("oracle : la lecture d'un colis non rattaché reste privée", () => {
  const parcel = colisCree({ agencyNotRegistered: true });
  assert.equal(peutLire(parcel, EXPEDITRICE.id), true);
  assert.equal(peutLire(parcel, "uid-tierce"), false);
  assert.equal(peutLire(parcel, null), false, "pas d'accès anonyme au colis privé");
  // Personne d'autre que l'expéditeur, même avec un compte agence.
  assert.equal(peutLire({ ...parcel, destinationAgencyId: null }, INSCRITE.id), false);
});

test("oracle : le suivi public ne peut pas mentir ni déborder", () => {
  const parcel = colisCree({ agencyNotRegistered: true });
  const suivi = construireSuiviPublic(parcel, "2026-10-14T09:00:00.000Z");
  const contexte = { auth: EXPEDITRICE.id, annuaire: ANNUAIRE };

  assert.equal(suiviEstFidele(suivi, parcel.trackingCode, parcel, contexte), true);
  assert.equal(suiviEstFidele({ ...suivi, sender: parcel.sender }, parcel.trackingCode, parcel, contexte), false, "fuite de données personnelles");
  assert.equal(suiviEstFidele({ ...suivi, status: "Retiré" }, parcel.trackingCode, parcel, contexte), false, "statut public non conforme au colis");
  assert.equal(suiviEstFidele(suivi, "CLI-AUTRE", parcel, contexte), false, "code du document different du contenu");
  assert.equal(suiviEstFidele(suivi, parcel.trackingCode, parcel, { auth: "uid-tierce", annuaire: ANNUAIRE }), false, "agence sans lien avec le colis");
  assert.equal(suiviEstFidele(suivi, parcel.trackingCode, parcel, { auth: null, annuaire: ANNUAIRE }), false, "écriture anonyme");
});
