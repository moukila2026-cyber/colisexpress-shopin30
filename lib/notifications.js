/*
 * Notifications (LOT 5) — fonction d'envoi UNIQUE, transports et journal.
 *
 *   notifier(evenement)                    calcule destinataires + messages
 *                                          (js/metier-notifications.js) puis
 *                                          passe chaque notification à :
 *   envoyerNotification(notification)      LA fonction d'envoi : dédoublonnage
 *                                          (clé unique), transport, journal ;
 *   balayerEcheances({ agencyId, parcels }) échéances (escalade 24 h,
 *                                          souffrance, colis qui dorment),
 *                                          idempotent ;
 *   configurationNotifications()           canal effectif + raison (jamais
 *                                          de secret, jamais de valeur
 *                                          d'environnement renvoyée).
 *
 * MODE SIMULATION PAR DÉFAUT : sans configuration explicite, aucun message ne
 * sort de l'application — chaque notification est journalisée (table
 * `notifications`, statut « simule ») et consultable par l'agence
 * destinataire (page Notifications). Les transports réels sont branchés au
 * LOT 12 ; le canal reste en simulation tant qu'aucun n'est configuré.
 *
 * Destinataires : uniquement les deux agences concernées (coordonnées
 * professionnelles de l'agence, lues au moment de l'envoi réel). Les
 * messages ne contiennent aucune donnée personnelle (voir le module métier).
 *
 * Une notification ne bloque JAMAIS l'opération qui la déclenche : toute
 * erreur est absorbée et signalée dans les journaux serveur sans donnée
 * personnelle ni secret.
 */
import crypto from "node:crypto";

import { query } from "../db/db.js";
import { normaliserIncident } from "../js/metier-incidents.js";
import { evenementsEcheance, notificationsPourAgences } from "../js/metier-notifications.js";

/**
 * Registre des transports. `variables` : noms des variables d'environnement
 * requises (jamais leurs valeurs dans le code). `envoyer({ destinataire,
 * titre, message, lien })` : null = pas encore branché.
 */
export const TRANSPORTS = {
  simulation: {
    label: "Simulation",
    variables: [],
    async envoyer() {
      // Aucun appel externe : le journal EST la trace de la notification.
      return { statut: "simule" };
    }
  },
  whatsapp: {
    label: "WhatsApp",
    variables: ["WHATSAPP_API_URL", "WHATSAPP_API_TOKEN"],
    envoyer: null
  },
  sms: {
    label: "SMS",
    variables: ["SMS_API_URL", "SMS_API_KEY"],
    envoyer: null
  },
  email: {
    label: "E-mail",
    variables: ["EMAIL_API_URL", "EMAIL_API_KEY", "EMAIL_FROM"],
    envoyer: null
  }
};

const CANAL_LISIBLE = /^[a-z][a-z_-]{0,19}$/;

/**
 * Canal effectif. Simulation sauf si NOTIFICATIONS_CANAL désigne un
 * transport branché (fonction `envoyer`) dont toutes les variables sont
 * définies. Ne renvoie jamais la valeur d'une variable d'environnement.
 */
export function configurationNotifications(env = process.env, transports = TRANSPORTS) {
  const brut = String(env?.NOTIFICATIONS_CANAL ?? "").trim().toLowerCase() || "simulation";
  const demande = CANAL_LISIBLE.test(brut) ? brut : "inconnu";
  const simulation = (raison) => ({ canal: "simulation", demande, simulation: true, raison });

  if (demande === "simulation") {
    return simulation("Mode simulation (par défaut) : aucun message n'est envoyé hors de l'application, chaque notification est journalisée ici.");
  }
  const transport = transports[demande];
  if (!transport) {
    return simulation(`Canal « ${demande} » inconnu : repli sur la simulation.`);
  }
  if (typeof transport.envoyer !== "function") {
    return simulation(`Le transport ${transport.label} n'est pas encore branché : repli sur la simulation.`);
  }
  const manquantes = (transport.variables || []).filter((nom) => !String(env?.[nom] ?? "").trim());
  if (manquantes.length) {
    return simulation(`Le transport ${transport.label} n'est pas configuré : repli sur la simulation.`);
  }
  return { canal: demande, demande, simulation: false, raison: `Envoi réel via ${transport.label}.` };
}

/** Coordonnées professionnelles de l'agence destinataire (envoi réel uniquement). */
async function coordonneesAgence(agencyId) {
  const { rows } = await query("SELECT id, name, phone, email FROM agencies WHERE id = $1", [agencyId]);
  const agence = rows[0];
  return agence ? { id: agence.id, name: agence.name, phone: agence.phone, email: agence.email } : null;
}

/**
 * LA fonction d'envoi : toute notification passe par ici.
 *   1. réserve la clé de dédoublonnage (INSERT … ON CONFLICT DO NOTHING) :
 *      un même événement n'est jamais notifié deux fois à la même agence,
 *      même si deux requêtes concurrentes le détectent ;
 *   2. confie le message au transport du canal effectif (simulation par
 *      défaut) ;
 *   3. journalise le résultat (statut simule / envoye / echec).
 * Renvoie `{ id, canal, statut }`, ou `null` si la notification existait déjà.
 */
export async function envoyerNotification(notification, { env = process.env, transports = TRANSPORTS } = {}) {
  const config = configurationNotifications(env, transports);
  const id = crypto.randomUUID();
  const nowISO = new Date().toISOString();
  const { rows } = await query(
    `INSERT INTO notifications (id, agency_id, type, titre, message, lien, parcel_id, bordereau_id, incident_id,
       canal, statut, dedup_key, created_at_iso)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'en_attente', $11, $12)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING id`,
    [
      id, notification.agencyId, notification.type, notification.titre, notification.message,
      notification.lien ?? "", notification.parcelId ?? null, notification.bordereauId ?? null,
      notification.incidentId ?? null, config.canal, notification.cle, nowISO
    ]
  );
  if (!rows.length) return null;

  const transport = transports[config.canal] ?? TRANSPORTS.simulation;
  let statut = config.simulation ? "simule" : "envoye";
  let erreur = "";
  try {
    const destinataire = config.simulation ? null : await coordonneesAgence(notification.agencyId);
    await transport.envoyer({
      destinataire,
      titre: notification.titre,
      message: notification.message,
      lien: notification.lien ?? ""
    });
  } catch (error) {
    statut = "echec";
    erreur = `Échec de l'envoi via ${transport.label}. La notification reste consultable ici.`;
    // Jamais le message d'erreur brut : il pourrait contenir une URL signée ou un jeton.
    console.error(`[notifications] échec d'envoi via ${config.canal} (${error?.code || error?.name || "erreur"})`);
  }
  await query("UPDATE notifications SET statut = $1, erreur = $2 WHERE id = $3", [statut, erreur, id]);
  return { id, canal: config.canal, statut };
}

/**
 * Notifie un événement aux agences concernées (ou à `evenement.agences`).
 * Ne lève jamais d'erreur : l'opération métier qui l'appelle continue.
 */
export async function notifier(evenement, options = {}) {
  try {
    const resultats = [];
    for (const notification of notificationsPourAgences(evenement, evenement?.agences ?? null)) {
      const envoi = await envoyerNotification(notification, options);
      if (envoi) resultats.push(envoi);
    }
    return resultats;
  } catch (error) {
    console.error(`[notifications] notification ignorée (${error?.code || error?.name || "erreur"})`);
    return [];
  }
}

/**
 * Balayage des échéances pour les colis d'une agence (expéditrice ou
 * destination) : escalade d'incident > 24 h, souffrance, colis qui dorment.
 * Pas de tâche planifiée (plan Vercel Hobby) : le balayage est déclenché au
 * fil de l'eau par la consultation du tableau de bord ou du journal, par
 * l'une OU l'autre des deux agences — et notifie toujours les deux.
 * Idempotent : une seule requête écarte les clés déjà journalisées, la
 * contrainte UNIQUE couvre les balayages concurrents. Renvoie le nombre de
 * nouvelles notifications. Ne lève jamais d'erreur.
 */
export async function balayerEcheances({ agencyId = null, toutesAgences = false, parcels = [], now = new Date(), options = {}, propagerErreur = false } = {}) {
  try {
    if ((!agencyId && !toutesAgences) || !parcels.length) return 0;
    const incidentRows = toutesAgences
      ? (await query("SELECT * FROM incidents WHERE state <> 'resolu'")).rows
      : (await query(
        `SELECT i.* FROM incidents i
         JOIN parcels p ON p.id = i.parcel_id
         WHERE (p.owner_id = $1 OR p.destination_agency_id = $1) AND i.state <> 'resolu'`,
        [agencyId]
      )).rows;
    const evenements = evenementsEcheance({ parcels, incidents: incidentRows.map(normaliserIncident), now });
    const candidates = evenements.flatMap((evenement) => notificationsPourAgences(evenement, evenement.agences));
    if (!candidates.length) return 0;

    const cles = [...new Set(candidates.map((item) => item.cle))];
    const placeholders = cles.map((_, index) => `$${index + 1}`).join(", ");
    const { rows: connues } = await query(`SELECT dedup_key FROM notifications WHERE dedup_key IN (${placeholders})`, cles);
    const deja = new Set(connues.map((row) => row.dedup_key));

    let nouvelles = 0;
    for (const notification of candidates) {
      if (deja.has(notification.cle)) continue;
      deja.add(notification.cle);
      if (await envoyerNotification(notification, options)) nouvelles += 1;
    }
    return nouvelles;
  } catch (error) {
    console.error(`[notifications] balayage ignoré (${error?.code || error?.name || "erreur"})`);
    if (propagerErreur) throw error;
    return 0;
  }
}

/** Nombre de notifications non lues d'une agence. */
export async function compterNonLues(agencyId) {
  const { rows } = await query(
    "SELECT count(*)::int AS n FROM notifications WHERE agency_id = $1 AND lu = FALSE",
    [agencyId]
  );
  return Number(rows[0]?.n ?? 0);
}
