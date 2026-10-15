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
import { isValidIvorianPhone, normalizeIvorianPhone, toWhatsAppNumber } from "../js/utils.js";

/**
 * Les transports réels utilisent des identifiants d'env. seulement côté
 * serveur. Le chemin par défaut est WhatsApp Cloud → Orange SMS → simulation.
 */
function valeur(env, ...noms) {
  for (const nom of noms) {
    const resultat = String(env?.[nom] ?? "").trim();
    if (resultat) return resultat;
  }
  return "";
}

function configurationWhatsApp(env = process.env) {
  return {
    token: valeur(env, "WHATSAPP_TOKEN", "WHATSAPP_API_TOKEN"),
    phoneId: valeur(env, "WHATSAPP_PHONE_ID", "WHATSAPP_PHONE_NUMBER_ID"),
    modele: valeur(env, "WHATSAPP_MODELE"),
    version: valeur(env, "WHATSAPP_API_VERSION")
  };
}

function whatsappConfigure(env = process.env) {
  const c = configurationWhatsApp(env);
  return Boolean(
    c.token && /^\d{5,30}$/.test(c.phoneId) && /^[a-z0-9_]{2,120}$/i.test(c.modele) && /^v\d+\.\d+$/.test(c.version)
  );
}

/** Orange attend un senderAddress autorisé en URI tel ou un numéro ivoirien. */
function adresseExpediteurOrange(value = "") {
  const brut = String(value).trim();
  const uri = brut.match(/^tel:\+225(\d{8,10})$/i);
  if (uri) return `tel:+225${uri[1]}`;
  const international = brut.match(/^\+?225(\d{8,10})$/);
  if (international) return `tel:+225${international[1]}`;
  const national = normalizeIvorianPhone(brut);
  if (/^0[1-9]\d{8}$/.test(national)) return `tel:+225${national}`;
  return "";
}

function configurationOrange(env = process.env) {
  return {
    clientId: valeur(env, "ORANGE_SMS_CLIENT_ID"),
    clientSecret: valeur(env, "ORANGE_SMS_CLIENT_SECRET"),
    expediteur: adresseExpediteurOrange(valeur(env, "ORANGE_SMS_NOM_EXPEDITEUR"))
  };
}

function orangeConfigure(env = process.env) {
  const c = configurationOrange(env);
  return Boolean(c.clientId && c.clientSecret && c.expediteur);
}

function erreurTransport(code) {
  const error = new Error("Le transport de notification est indisponible.");
  error.code = code;
  return error;
}

/** Autorise uniquement des codes techniques connus, jamais une valeur libre. */
function codeErreurLog(error) {
  const code = String(error?.code ?? "");
  if (/^(?:E[A-Z0-9_]{1,20}|WHATSAPP_[A-Z0-9_]{1,30}|ORANGE_[A-Z0-9_]{1,30})$/i.test(code)) return code;
  const nom = String(error?.name ?? "");
  return ["Error", "TypeError", "AbortError", "TimeoutError", "FetchError"].includes(nom) ? nom : "erreur";
}

function signalDelai() {
  return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(10_000) : undefined;
}

/** WhatsApp Cloud API : modèle approuvé en français avec deux variables texte. */
export async function envoyerWhatsApp({ destinataire, titre, message }, { env = process.env, fetcher = globalThis.fetch } = {}) {
  const c = configurationWhatsApp(env);
  if (!whatsappConfigure(env)) throw erreurTransport("WHATSAPP_NON_CONFIGURE");
  if (typeof fetcher !== "function") throw erreurTransport("WHATSAPP_RESEAU");
  const numero = normalizeIvorianPhone(destinataire?.phone ?? "");
  if (!isValidIvorianPhone(numero)) throw erreurTransport("WHATSAPP_DESTINATAIRE_INVALIDE");
  const url = `https://graph.facebook.com/${c.version}/${encodeURIComponent(c.phoneId)}/messages`;
  const signal = signalDelai();
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toWhatsAppNumber(numero),
      type: "template",
      template: {
        name: c.modele,
        language: { code: "fr" },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: String(titre ?? "").slice(0, 1024) },
            { type: "text", text: String(message ?? "").slice(0, 1024) }
          ]
        }]
      }
    }),
    ...(signal ? { signal } : {})
  });
  if (!response?.ok) throw erreurTransport(`WHATSAPP_HTTP_${Number(response?.status) || 0}`);
  return { statut: "envoye" };
}

let cacheJetonOrange = null;

async function obtenirJetonOrange({ env, fetcher }) {
  const c = configurationOrange(env);
  const signature = crypto.createHash("sha256").update(`${c.clientId}\u0000${c.clientSecret}`).digest("hex");
  if (fetcher === globalThis.fetch && cacheJetonOrange?.signature === signature && cacheJetonOrange.expire > Date.now()) {
    return cacheJetonOrange.jeton;
  }
  const signal = signalDelai();
  const response = await fetcher("https://api.orange.com/oauth/v3/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials",
    ...(signal ? { signal } : {})
  });
  if (!response?.ok) throw erreurTransport(`ORANGE_OAUTH_HTTP_${Number(response?.status) || 0}`);
  let data;
  try { data = await response.json(); } catch { throw erreurTransport("ORANGE_OAUTH_REPONSE_INVALIDE"); }
  if (!data?.access_token) throw erreurTransport("ORANGE_OAUTH_JETON_ABSENT");
  const jeton = String(data.access_token);
  const expireDans = Math.max(0, Number(data.expires_in || 1800) * 1000 - 30_000);
  if (fetcher === globalThis.fetch) {
    cacheJetonOrange = { signature, jeton, expire: Date.now() + expireDans };
  }
  return jeton;
}

/** Orange SMS API : l'expéditeur doit être approuvé pour le compte CI. */
export async function envoyerSmsOrange({ destinataire, titre, message }, { env = process.env, fetcher = globalThis.fetch } = {}) {
  const c = configurationOrange(env);
  if (!orangeConfigure(env)) throw erreurTransport("ORANGE_NON_CONFIGURE");
  if (typeof fetcher !== "function") throw erreurTransport("ORANGE_RESEAU");
  const numero = normalizeIvorianPhone(destinataire?.phone ?? "");
  if (!isValidIvorianPhone(numero)) throw erreurTransport("ORANGE_DESTINATAIRE_INVALIDE");
  const token = await obtenirJetonOrange({ env, fetcher });
  const address = `tel:+225${numero}`;
  const url = `https://api.orange.com/smsmessaging/v1/outbound/${encodeURIComponent(c.expediteur)}/requests`;
  const signal = signalDelai();
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      outboundSMSMessageRequest: {
        address,
        senderAddress: c.expediteur,
        outboundSMSTextMessage: { message: `${String(titre ?? "").trim()} — ${String(message ?? "").trim()}`.slice(0, 1600) }
      }
    }),
    ...(signal ? { signal } : {})
  });
  if (!response?.ok) {
    if (response?.status === 401 && fetcher === globalThis.fetch) cacheJetonOrange = null;
    throw erreurTransport(`ORANGE_SMS_HTTP_${Number(response?.status) || 0}`);
  }
  return { statut: "envoye" };
}

/** Registre : e-mail reste inactif ; les transports actifs sont WhatsApp et Orange SMS. */
export const TRANSPORTS = {
  simulation: {
    label: "Simulation",
    variables: [],
    async envoyer() { return { statut: "simule" }; }
  },
  whatsapp: {
    label: "WhatsApp Cloud",
    variables: ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_MODELE", "WHATSAPP_API_VERSION"],
    configured: whatsappConfigure,
    envoyer: envoyerWhatsApp
  },
  sms: {
    label: "Orange SMS Côte d'Ivoire",
    variables: ["ORANGE_SMS_CLIENT_ID", "ORANGE_SMS_CLIENT_SECRET", "ORANGE_SMS_NOM_EXPEDITEUR"],
    configured: orangeConfigure,
    envoyer: envoyerSmsOrange
  },
  email: {
    label: "E-mail",
    variables: ["EMAIL_API_URL", "EMAIL_API_KEY", "EMAIL_FROM"],
    configured: () => false,
    envoyer: null
  }
};

const CANAUX_DEMANDE = new Set(["auto", "whatsapp", "sms", "simulation"]);

function estConfigure(transport, env) {
  if (!transport || typeof transport.envoyer !== "function") return false;
  if (typeof transport.configured === "function") return transport.configured(env);
  return (transport.variables || []).every((nom) => Boolean(String(env?.[nom] ?? "").trim()));
}

/**
 * Ordre par défaut : WhatsApp Cloud → Orange SMS → simulation. La variable
 * `NOTIFICATIONS_CANAL=simulation` permet de forcer le mode sans envoi réel.
 * Les valeurs secrètes ne sont jamais renvoyées.
 */
export function configurationNotifications(env = process.env, transports = TRANSPORTS) {
  const brut = String(env?.NOTIFICATIONS_CANAL ?? "").trim().toLowerCase() || "auto";
  const demande = CANAUX_DEMANDE.has(brut) ? brut : "inconnu";
  const simulation = (raison) => ({ canal: "simulation", demande, simulation: true, raison });

  if (demande === "simulation") {
    return simulation("Mode simulation forcé : aucun message n'est envoyé hors de l'application.");
  }
  let priorite;
  if (demande === "auto" || demande === "whatsapp") priorite = ["whatsapp", "sms"];
  else if (demande === "sms") priorite = ["sms"];
  else return simulation(`Canal « ${demande} » indisponible : repli sur la simulation.`);

  for (const canal of priorite) {
    const transport = transports[canal];
    if (!estConfigure(transport, env)) continue;
    const raison = canal === "whatsapp"
      ? `Envoi réel via ${transport.label} ; Orange SMS sert de repli si l'envoi échoue.`
      : `Envoi réel via ${transport.label}${priorite.includes("whatsapp") ? " (WhatsApp absent ou non configuré)" : ""}.`;
    return { canal, demande, simulation: false, raison };
  }
  const motif = priorite.includes("whatsapp")
    ? "WhatsApp et Orange SMS ne sont pas configurés"
    : "Orange SMS n'est pas configuré";
  return simulation(`${motif} : les notifications restent dans le journal en simulation.`);
}

/** Coordonnées professionnelles de l'agence destinataire (envoi réel uniquement). */
async function coordonneesAgence(agencyId) {
  const { rows } = await query("SELECT id, phone FROM agencies WHERE id = $1", [agencyId]);
  const agence = rows[0];
  return agence ? { id: agence.id, phone: agence.phone } : null;
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

  let canal = config.canal;
  let statut = "simule";
  let erreur = "";
  if (config.simulation) {
    try {
      await (transports.simulation ?? TRANSPORTS.simulation).envoyer({
        destinataire: null,
        titre: notification.titre,
        message: notification.message,
        lien: notification.lien ?? ""
      });
    } catch (error) {
      statut = "echec";
      erreur = "Échec de l'envoi en simulation ; la notification reste consultable dans le journal.";
      console.error(`[notifications] simulation indisponible (${codeErreurLog(error)})`);
    }
  } else {
    const destinataire = await coordonneesAgence(notification.agencyId);
    const ordre = config.canal === "whatsapp" ? ["whatsapp", "sms"] : ["sms"];
    let envoye = false;
    for (const candidat of ordre) {
      const transport = transports[candidat];
      if (!estConfigure(transport, env)) continue;
      try {
        await transport.envoyer({
          destinataire,
          titre: notification.titre,
          message: notification.message,
          lien: notification.lien ?? ""
        }, { env });
        canal = candidat;
        statut = "envoye";
        envoye = true;
        break;
      } catch (error) {
        // Aucun texte d'erreur fournisseur : il peut contenir un numéro, un jeton ou une URL signée.
        console.error(`[notifications] échec d'envoi via ${candidat} (${codeErreurLog(error)})`);
      }
    }
    if (!envoye) {
      canal = "simulation";
      statut = "simule";
      erreur = "WhatsApp/SMS momentanément indisponible ; notification conservée dans le journal.";
    }
  }
  await query("UPDATE notifications SET canal = $1, statut = $2, erreur = $3 WHERE id = $4", [canal, statut, erreur, id]);
  return { id, canal, statut };
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
    console.error(`[notifications] notification ignorée (${codeErreurLog(error)})`);
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
    console.error(`[notifications] balayage ignoré (${codeErreurLog(error)})`);
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
