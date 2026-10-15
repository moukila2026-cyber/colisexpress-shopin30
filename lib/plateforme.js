/*
 * Console plateforme (LOT 6) — vue d'ensemble en LECTURE SEULE pour l'équipe
 * Shopin30 : file des incidents ouverts depuis plus de 7 jours (filePlateforme
 * du LOT 4), litiges, agences (plan, compteur du mois, portefeuille,
 * abonnement) et volumes du réseau. Aucune écriture ici : consulter la console
 * n'ouvre aucune période et ne prélève rien. Les données clients (noms,
 * téléphones, CNI) ne sont pas projetées : seuls les codes de suivi, villes,
 * statuts et agences concernées apparaissent.
 */
import crypto from "node:crypto";

import { query } from "../db/db.js";
import { hashPassword } from "./auth.js";
import { escaladeIncident, libelleEtatIncident, libelleTypeIncident } from "../js/metier-incidents.js";
import { bornesPeriode, clePeriode, conditionsPlan, normaliserPeriode, resumeFacturation } from "../js/metier-plans.js";

function projectionIncident(row, now) {
  const escalade = escaladeIncident({ incident: { state: row.state, openedAtISO: row.opened_at_iso }, now });
  return {
    id: row.id,
    type: row.type,
    libelleType: libelleTypeIncident(row.type),
    state: row.state,
    libelleEtat: libelleEtatIncident(row.state),
    note: row.note ?? "",
    resolution: row.resolution ?? "",
    openedByName: row.opened_by_name ?? "",
    openedAtISO: row.opened_at_iso,
    resolvedAtISO: row.resolved_at_iso ?? null,
    heures: escalade.heures,
    jours: Math.floor(escalade.heures / 24),
    filePlateforme: escalade.filePlateforme,
    parcel: {
      id: row.parcel_id,
      trackingCode: row.tracking_code,
      status: row.parcel_status,
      originCity: row.origin_city,
      destinationCity: row.destination_city
    },
    expediteur: { id: row.owner_id, name: row.owner_agency_name },
    destination: row.destination_agency_id
      ? { id: row.destination_agency_id, name: row.destination_agency_name }
      : { id: null, name: `${row.destination_agency_name || "Agence"} (non inscrite)` }
  };
}

export async function vuePlateforme(now = new Date()) {
  const cle = clePeriode(now);
  const { debutISO } = bornesPeriode(cle);

  const { rows: agencesRows } = await query(
    `SELECT a.id, a.name, a.city, a.phone, a.email, a.created_at_iso, a.plan, a.plan_suivant,
            a.quota_negocie, a.prix_negocie_fcfa, a.portefeuille_fcfa,
            f.periode, f.plan AS periode_plan, f.quota, f.colis_comptes, f.colis_depassement,
            f.abonnement_fcfa, f.abonnement_statut, f.echeance_iso, f.paye_le_iso
     FROM agencies a
     LEFT JOIN facturation_periodes f ON f.agency_id = a.id AND f.periode = $1
     ORDER BY a.created_at_iso, a.id`,
    [cle]
  );
  const { rows: envoyes } = await query(
    `SELECT owner_id AS id, count(*)::int AS total, count(*) FILTER (WHERE created_at_iso >= $1)::int AS mois
     FROM parcels GROUP BY owner_id`,
    [debutISO]
  );
  const { rows: recus } = await query(
    `SELECT destination_agency_id AS id, count(*)::int AS total, count(*) FILTER (WHERE created_at_iso >= $1)::int AS mois
     FROM parcels WHERE destination_agency_id IS NOT NULL GROUP BY destination_agency_id`,
    [debutISO]
  );
  const { rows: ouverts } = await query(
    `SELECT p.owner_id, p.destination_agency_id FROM incidents i JOIN parcels p ON p.id = i.parcel_id WHERE i.state <> 'resolu'`
  );
  const parId = (rows) => new Map(rows.map((row) => [row.id, row]));
  const envoyesParId = parId(envoyes);
  const recusParId = parId(recus);

  const agences = agencesRows.map((row) => {
    const ouverte = Boolean(row.periode);
    // Période pas encore ouverte (aucune activité ce mois) : conditions du plan,
    // compteur à zéro — la console ne crée rien.
    const conditions = conditionsPlan({ plan: row.plan, quotaNegocie: row.quota_negocie, prixNegocieFCFA: row.prix_negocie_fcfa });
    const periode = normaliserPeriode(
      ouverte
        ? { ...row, plan: row.periode_plan }
        : { periode: cle, plan: conditions.plan, quota: conditions.quota, colis_comptes: 0, colis_depassement: 0, abonnement_fcfa: 0, abonnement_statut: "sans_frais" },
      now
    );
    const soldeFCFA = Number(row.portefeuille_fcfa ?? 0);
    return {
      id: row.id,
      name: row.name,
      city: row.city,
      phone: row.phone,
      email: row.email,
      createdAtISO: row.created_at_iso,
      plan: row.plan,
      planSuivant: row.plan_suivant ?? null,
      quotaNegocie: row.quota_negocie ?? null,
      prixNegocieFCFA: row.prix_negocie_fcfa ?? null,
      portefeuilleFCFA: soldeFCFA,
      periodeOuverte: ouverte,
      periode,
      resume: resumeFacturation({ periode, soldeFCFA }),
      volumes: {
        envoyesMois: envoyesParId.get(row.id)?.mois ?? 0,
        envoyesTotal: envoyesParId.get(row.id)?.total ?? 0,
        recusMois: recusParId.get(row.id)?.mois ?? 0,
        recusTotal: recusParId.get(row.id)?.total ?? 0
      },
      incidentsOuverts: ouverts.filter((i) => i.owner_id === row.id || i.destination_agency_id === row.id).length
    };
  });

  const { rows: parMois } = await query(
    `SELECT substring(created_at_iso from 1 for 7) AS periode, count(*)::int AS colis
     FROM parcels GROUP BY 1 ORDER BY 1 DESC LIMIT 6`
  );
  const { rows: parStatut } = await query("SELECT status, count(*)::int AS colis FROM parcels GROUP BY status ORDER BY 2 DESC");

  const { rows: incidentsRows } = await query(
    `SELECT i.*, p.tracking_code, p.status AS parcel_status, p.origin_city, p.destination_city,
            p.owner_id, p.owner_agency_name, p.destination_agency_id, p.destination_agency_name
     FROM incidents i JOIN parcels p ON p.id = i.parcel_id
     WHERE i.state <> 'resolu' OR i.type = 'conteste'
     ORDER BY i.opened_at_iso, i.id`
  );
  const incidents = incidentsRows.map((row) => projectionIncident(row, now));
  const fileIncidents = incidents.filter((incident) => incident.filePlateforme);
  const litiges = incidents
    .filter((incident) => incident.type === "conteste")
    .sort((a, b) => Number(a.state === "resolu") - Number(b.state === "resolu"));

  return {
    periode: cle,
    indicateurs: {
      agences: agences.length,
      colisMois: agences.reduce((somme, agence) => somme + agence.volumes.envoyesMois, 0),
      colisTotal: agences.reduce((somme, agence) => somme + agence.volumes.envoyesTotal, 0),
      incidentsFile: fileIncidents.length,
      litigesOuverts: litiges.filter((incident) => incident.state !== "resolu").length,
      abonnementsDus: agences.filter((agence) => agence.periode.abonnement.statut === "du").length,
      abonnementsEnRetard: agences.filter((agence) => agence.periode.abonnement.enRetard).length,
      portefeuillesFCFA: agences.reduce((somme, agence) => somme + agence.portefeuilleFCFA, 0)
    },
    agences,
    volumes: { parMois, parStatut },
    fileIncidents,
    litiges
  };
}

/* ------------------- amorçage du premier administrateur (LOT 8) ------------------- */
// Sans terminal : si AUCUN administrateur actif n'existe ET que
// PLATEFORME_PREMIER_ADMIN_JETON (≥ 32 caractères) est définie dans Vercel,
// /plateforme.html propose « Créer le premier administrateur ». Le jeton est
// comparé en temps constant ; la création est atomique (ligne unique dans
// plateforme_amorcage) ; ensuite l'amorçage est fermé pour toujours et la
// variable doit être supprimée.

export const LONGUEUR_MIN_JETON_AMORCAGE = 32;
export const LONGUEUR_MIN_MOT_DE_PASSE_ADMIN = 12;
const CLE_AMORCAGE = "premier-admin";
const EMAIL_SIMPLE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function jetonAmorcage(env = process.env) {
  const valeur = String(env.PLATEFORME_PREMIER_ADMIN_JETON ?? "").trim();
  return valeur.length >= LONGUEUR_MIN_JETON_AMORCAGE ? valeur : "";
}

/**
 * État de l'amorçage : { disponible, motif } où motif ∈ ouvert | ferme
 * (un administrateur existe déjà ou l'amorçage a déjà servi) | jeton_absent
 * (aucune variable valide). Jamais la valeur du jeton.
 */
export async function etatAmorcage(env = process.env) {
  const { rows } = await query(
    `SELECT (SELECT count(*)::int FROM plateforme_admins WHERE active = TRUE) AS actifs,
            (SELECT count(*)::int FROM plateforme_amorcage WHERE cle = $1) AS utilise`,
    [CLE_AMORCAGE]
  );
  const ferme = rows[0].actifs > 0 || rows[0].utilise > 0;
  if (ferme) return { disponible: false, motif: "ferme" };
  if (!jetonAmorcage(env)) return { disponible: false, motif: "jeton_absent" };
  return { disponible: true, motif: "ouvert" };
}

function jetonsEgaux(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y) && String(a).length === String(b).length;
}

/**
 * Crée le premier administrateur. Renvoie { admin } ou { error, status }.
 * Atomique : la ligne `plateforme_amorcage` (clé fixe) ne peut être insérée
 * qu'une fois ; l'administrateur n'est inséré que dans la même instruction,
 * et seulement s'il n'existe toujours aucun administrateur actif.
 */
export async function creerPremierAdmin({ jeton, email, nom, password } = {}, env = process.env) {
  const attendu = jetonAmorcage(env);
  const etat = await etatAmorcage(env);
  const refus = { error: "L'amorçage de la console est fermé : un administrateur existe déjà ou le jeton n'est pas configuré.", status: 409 };
  if (!etat.disponible || !attendu) return refus;
  if (!jetonsEgaux(String(jeton ?? "").trim(), attendu)) return { error: "Jeton d'amorçage incorrect.", status: 403 };
  const mail = String(email ?? "").trim().toLowerCase();
  const nomPropre = String(nom ?? "").replace(/\s+/g, " ").trim();
  if (!EMAIL_SIMPLE.test(mail) || mail.length > 254) return { error: "L'adresse e-mail saisie n'est pas valide.", status: 400 };
  if (nomPropre.length < 2 || nomPropre.length > 80) return { error: "Le nom doit contenir 2 à 80 caractères.", status: 400 };
  if (typeof password !== "string" || password.length < LONGUEUR_MIN_MOT_DE_PASSE_ADMIN) {
    return { error: `Le mot de passe doit contenir au moins ${LONGUEUR_MIN_MOT_DE_PASSE_ADMIN} caractères.`, status: 400 };
  }
  const id = crypto.randomUUID();
  const nowISO = new Date().toISOString();
  let rows;
  try {
    ({ rows } = await query(
      `WITH verrou AS (
         INSERT INTO plateforme_amorcage (cle, admin_id, created_at_iso) VALUES ($1, $2, $3)
         ON CONFLICT (cle) DO NOTHING RETURNING cle
       )
       INSERT INTO plateforme_admins (id, email, name, password_hash, active, created_at_iso)
       SELECT $2, $4, $5, $6, TRUE, $3 FROM verrou
       WHERE NOT EXISTS (SELECT 1 FROM plateforme_admins WHERE active = TRUE)
       RETURNING id, email, name`,
      [CLE_AMORCAGE, id, nowISO, mail, nomPropre, hashPassword(password)]
    ));
  } catch (error) {
    if (/unique|duplicate|foreign/i.test(String(error?.code) + String(error?.message))) return refus;
    throw error;
  }
  if (!rows.length) return refus;
  return { admin: { id: rows[0].id, email: rows[0].email, name: rows[0].name } };
}
