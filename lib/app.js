/*
 * API COLIS EXPRESS — Express + Postgres (Neon).
 *
 * Toute l'autorisation est appliquée côté serveur :
 *   - un colis n'est lisible que par son agence expéditrice ou l'agence de destination ;
 *   - le rattachement est réservé à l'expéditeur, une seule fois, vers une agence inscrite ;
 *   - la progression suit les étapes de js/metier-colis.js ;
 *   - le suivi public ne contient aucune donnée personnelle ;
 *   - aucune suppression n'est exposée.
 * La logique métier (validation, construction, étapes) est importée depuis
 * js/metier-colis.js : le serveur et l'interface partagent exactement les mêmes règles.
 */
import crypto from "node:crypto";
import express from "express";
import { deplierRequeteVercel } from "./vercel-depliage.js";

import { query } from "../db/db.js";
import {
  ErreurConfigurationSession,
  clearPlatformCookie,
  clearSessionCookie,
  createPlatformToken,
  createSessionToken,
  getPlatformCharge,
  getSessionCharge,
  hashPassword,
  setPlatformCookie,
  setSessionCookie,
  verifierSecretSession,
  verifyPassword
} from "./auth.js";
import {
  changementsRattachement,
  construireColis,
  etapePublique,
  etatApresEncaissement,
  peutRattacher,
  prochaineEtape,
  resoudreDestination,
  resteAPayer,
  textePropre,
  validerColis,
  validerPaiement
} from "../js/metier-colis.js";
import {
  estModeEncaissement,
  estimerDevis,
  normaliserTarif,
  optionsPrix,
  validerTarif
} from "../js/metier-tarifs.js";
import {
  clientsDepuisColis,
  normaliserClient,
  rechercherClients,
  validerClient
} from "../js/metier-clients.js";
import {
  agenceDeControle,
  bordereauPublic,
  normaliserBordereau,
  peutControler,
  prochaineEtapeBordereau,
  resoudreControle,
  validerColisEmbarquables,
  validerCreationBordereau
} from "../js/metier-bordereau.js";
import {
  bandeauPublicIncident,
  normaliserIncident,
  validerOuvertureIncident,
  validerTransitionIncident
} from "../js/metier-incidents.js";
import { alertesParSignal, dateArriveeDestinantion, estEnSouffrance, joursDepuis } from "../js/metier-alertes.js";
import { normaliserNotification } from "../js/metier-notifications.js";
import { backendPhotos, lireObjet, stockerObjet } from "./photos.js";
import { balayerEcheances, compterNonLues, configurationNotifications, notifier } from "./notifications.js";
import { PLANS, normaliserPeriode, validerPlanPlateforme, validerRecharge } from "../js/metier-plans.js";
import {
  changerPlanGerant,
  changerPlanPlateforme,
  etatFacturation,
  ouvrirPeriode,
  rechargerPortefeuille,
  reglerAbonnement,
  reserverCreation
} from "./facturation.js";
import { creerPremierAdmin, etatAmorcage, vuePlateforme } from "./plateforme.js";
import { diagnosticMiseEnService } from "./mise-en-service.js";
import { marquePublique, validerLogo, validerMarque } from "../js/metier-marque.js";
import { validerDemandePaiement } from "../js/metier-paiements.js";
import {
  ErreurPaiement,
  configurationPaiements,
  confirmerPaiement,
  creerPaiement,
  projectionPaiement,
  traiterWebhook,
  verifierSignatureWebhook
} from "./paiements.js";
import { isValidCni, isValidIvorianPhone, normalizeIvorianPhone } from "../js/utils.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOM_AGENCE = [2, 120];
const VILLE = [2, 60];
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Jour courant au format AAAA-MM-JJ sur le fuseau de la Côte d'Ivoire. */
function jourCle(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Abidjan",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

/** Date du jour pour la caisse : paramètre `date` valide, sinon aujourd'hui. */
function resoudreDateCaisse(value) {
  const brut = textePropre(value);
  if (!brut) return jourCle();
  return DATE_KEY.test(brut) ? brut : null;
}

function dansLimite(value, [min, max]) {
  return value.length >= min && value.length <= max;
}

function json(value, repli = null) {
  if (value == null) return repli;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return repli; }
  }
  return value;
}

/** Ligne SQL → colis tel que l'interface l'utilise (camelCase). */
function toParcel(row) {
  if (!row) return null;
  return {
    id: row.id,
    trackingCode: row.tracking_code,
    ownerId: row.owner_id,
    ownerAgencyName: row.owner_agency_name,
    ownerAgencyCity: row.owner_agency_city,
    destinationAgencyId: row.destination_agency_id,
    destinationAgencyName: row.destination_agency_name,
    destinationAgencyCity: row.destination_agency_city,
    ...(json(row.unregistered_destination_agency) ? { unregisteredDestinationAgency: json(row.unregistered_destination_agency) } : {}),
    sender: json(row.sender, {}),
    recipient: json(row.recipient, {}),
    packageNature: row.package_nature,
    weightKg: row.weight_kg,
    priceFCFA: row.price_fcfa,
    originCity: row.origin_city,
    destinationCity: row.destination_city,
    status: row.status,
    history: json(row.history, []),
    ...(json(row.collected_by) ? { collectedBy: json(row.collected_by) } : {}),
    ...(row.destination_agency_attached_at
      ? {
          destinationAgencyAttachedAt: row.destination_agency_attached_at,
          destinationAgencyAttachedBy: row.destination_agency_attached_by
        }
      : {}),
    createdAtISO: row.created_at_iso,
    updatedAtISO: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    ...(row.payment_status ? { paymentStatus: row.payment_status } : {}),
    ...(row.paid_amount_fcfa !== null && row.paid_amount_fcfa !== undefined
      ? { paidAmountFCFA: row.paid_amount_fcfa }
      : {}),
    // LOT 4 — chaîne de preuve (champs privés, jamais dans le suivi public).
    ...(row.bordereau_id !== undefined ? { bordereauId: row.bordereau_id } : {}),
    ...(row.retour_status ? { retourStatus: row.retour_status } : {}),
    ...(row.retour_started_at ? { retourStartedAt: row.retour_started_at } : {}),
    ...(row.retour_completed_at ? { retourCompletedAt: row.retour_completed_at } : {})
  };
}

function toAgency(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, city: row.city, phone: row.phone, email: row.email };
}

function toAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    agencyId: row.agency_id,
    name: row.name,
    email: row.email,
    phone: row.phone ?? "",
    role: row.role,
    active: row.active === true,
    createdAtISO: row.created_at_iso
  };
}

/**
 * Membre connecté : le gérant EST le compte agence (aucune ligne agents),
 * un agent est une ligne active de la table agents. L'agence reste l'unité
 * de visibilité et de facturation : le membre ne change jamais le périmètre.
 */
function gerantMember(agency) {
  return {
    id: agency.id,
    agencyId: agency.id,
    name: agency.name,
    email: agency.email,
    phone: agency.phone,
    role: "gerant",
    active: true
  };
}

async function findAgentOfAgency(agencyId, agentId) {
  const { rows } = await query("SELECT * FROM agents WHERE id = $1 AND agency_id = $2", [agentId, agencyId]);
  return rows[0] || null;
}

/** Écritures réservées au gérant de l'agence (inviter/désactiver ses agents). */
function requireGerant(req, res, next) {
  if (req.member?.role !== "gerant") {
    return res.status(403).json({ error: "Seul le gérant de l'agence peut gérer les agents." });
  }
  next();
}

function agencyDirectory(row) {
  return { id: row.id, name: row.name, city: row.city };
}

function toCaisseClosure(row) {
  if (!row) return null;
  return {
    id: row.id,
    dateKey: row.date_key,
    countedTotalFCFA: row.counted_total_fcfa,
    computedTotalFCFA: row.computed_total_fcfa,
    ecartFCFA: row.ecart_fcfa,
    agentName: row.agent_name,
    createdAtISO: row.created_at_iso
  };
}

/**
 * Carnet de clients (LOT 3) — upsert par (agence, rôle, téléphone) :
 * la mémorisation automatique à l'enregistrement d'un colis complète la
 * fiche existante sans écraser une CNI déjà renseignée, et ne crée jamais
 * de doublon. Renvoie `{ client, cree }`.
 */
async function memoriserClient(agencyId, fiche, nowISO) {
  const { rows } = await query(
    "SELECT * FROM clients WHERE agency_id = $1 AND kind = $2 AND phone = $3",
    [agencyId, fiche.kind, fiche.phone]
  );
  if (rows.length) {
    await query(
      `UPDATE clients
       SET first_name = $1, last_name = $2,
           cni = COALESCE($3, cni),
           city = CASE WHEN $4 <> '' THEN $4 ELSE city END,
           notes = CASE WHEN $5 <> '' THEN $5 ELSE notes END,
           updated_at_iso = $6
       WHERE id = $7`,
      [fiche.firstName, fiche.lastName, fiche.cni, fiche.city ?? "", fiche.notes ?? "", nowISO, rows[0].id]
    );
    const { rows: maj } = await query("SELECT * FROM clients WHERE id = $1", [rows[0].id]);
    return { client: normaliserClient(maj[0]), cree: false };
  }
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO clients (id, agency_id, kind, first_name, last_name, phone, cni, city, notes, created_at_iso, updated_at_iso)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [id, agencyId, fiche.kind, fiche.firstName, fiche.lastName, fiche.phone, fiche.cni, fiche.city ?? "", fiche.notes ?? "", nowISO]
  );
  const { rows: insere } = await query("SELECT * FROM clients WHERE id = $1", [id]);
  return { client: normaliserClient(insere[0]), cree: true };
}

async function findAgency(id) {
  const { rows } = await query("SELECT * FROM agencies WHERE id = $1", [id]);
  return rows[0] || null;
}

async function findParcelForAgency(id, agencyId) {
  const { rows } = await query(
    "SELECT * FROM parcels WHERE id = $1 AND (owner_id = $2 OR destination_agency_id = $2)",
    [id, agencyId]
  );
  return rows[0] || null;
}

async function generateUniqueTrackingCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let tentative = 0; tentative < 8; tentative += 1) {
    const bytes = crypto.randomBytes(6);
    const token = Array.from(bytes, (b) => chars[b % chars.length]).join("");
    const code = `CLI-${token}`;
    const { rows } = await query("SELECT 1 FROM parcels WHERE tracking_code = $1", [code]);
    if (!rows.length) return code;
  }
  throw new Error("Impossible de générer un code de suivi unique. Réessayez.");
}

/** Code bordereau `BDR-XXXXXX` (même alphabet sans caractères ambigus). */
async function generateUniqueBordereauCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let tentative = 0; tentative < 8; tentative += 1) {
    const bytes = crypto.randomBytes(6);
    const token = Array.from(bytes, (b) => chars[b % chars.length]).join("");
    const code = `BDR-${token}`;
    const { rows } = await query("SELECT 1 FROM bordereaux WHERE code = $1", [code]);
    if (!rows.length) return code;
  }
  throw new Error("Impossible de générer un code bordereau unique. Réessayez.");
}

function validateProfile({ name, city, phone }) {
  const nom = textePropre(name);
  const ville = textePropre(city);
  const tel = normalizeIvorianPhone(phone ?? "");
  if (!dansLimite(nom, NOM_AGENCE)) return { error: "Le nom de l'agence doit contenir 2 à 120 caractères." };
  if (!dansLimite(ville, VILLE)) return { error: "La ville de l'agence doit contenir 2 à 60 caractères." };
  if (!isValidIvorianPhone(tel)) return { error: "Saisissez un téléphone ivoirien valide (10 chiffres)." };
  return { valeur: { name: nom, city: ville, phone: tel } };
}

export function buildApp() {
  const app = express();
  // Vercel (plan Hobby) : un déploiement est limité à 12 fonctions
  // serverless. Les routes imbriquées (/api/colis/:id/attach,
  // /api/bordereaux/:id/controle, /api/caisse/cloture…) sont donc repliées
  // par les « rewrites » de vercel.json sur la fonction de leur route
  // parente, avec l'action en paramètre (?action=attach). Ce middleware
  // redéplie l'URL réelle avant tout routage ; en local (npm start) et dans
  // les tests, les requêtes arrivent déjà sous leur forme complète et rien
  // ne change. Si Vercel transmettait plutôt le chemin d'origine, le
  // paramètre serait absent et le dépliage simplement inactif.
  app.use((req, res, next) => {
    const action = req.query?.action;
    if (typeof action === "string" && /^[a-z][a-z-]{2,}$/.test(action) && req.path.startsWith("/api/")) {
      const [chemin] = req.url.split("?");
      // Une fonction Vercel peut avoir déjà redéplié l'URL avant d'appeler
      // Express : ne pas ajouter deux fois la même action.
      if (!chemin.endsWith(`/${action}`)) {
        const reste = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
        req.url = reste ? `${chemin}/${action}?${reste}` : `${chemin}/${action}`;
      }
    }
    next();
  });
  // Repli robuste : chemins originaux transmis par Vercel via en-têtes.
  app.use((req, res, next) => {
    deplierRequeteVercel(req);
    next();
  });
  // Limite de corps relevée uniquement pour l'upload de photos (LOT 4) :
  // l'image compressée (~200 Ko) voyage en base64 dans un JSON. Toutes les
  // autres routes gardent la limite stricte de 256 Ko.
  // LOT 7 — logo de marque (~400 Ko en base64) : 1 Mo sur PUT /api/marque.
  // Webhook SasPay : le corps BRUT est conservé, la signature HMAC se calcule
  // sur les octets reçus et jamais sur une re-sérialisation.
  app.use((req, res, next) =>
    express.json({
      limit: /\/photos(\/|$|\?)/.test(req.path) ? "6mb" : req.path === "/api/marque" ? "1mb" : "256kb",
      verify: req.path === "/api/paiements/webhook"
        ? (requete, reponse, tampon) => { requete.corpsBrut = tampon.toString("utf8"); }
        : undefined
    })(req, res, next)
  );

  /* ------------------------------- session ------------------------------- */

  async function requireAgency(req, res, next) {
    const charge = getSessionCharge(req);
    if (!charge) return res.status(401).json({ error: "Votre session a expiré. Reconnectez-vous pour continuer." });
    const agency = await findAgency(charge.id);
    if (!agency) {
      clearSessionCookie(res);
      return res.status(401).json({ error: "Votre session a expiré. Reconnectez-vous pour continuer." });
    }
    // Session d'agent : l'agent doit toujours exister, appartenir à l'agence
    // et être actif — un agent désactivé par le gérant perd son accès immédiatement.
    if (charge.agent) {
      const agent = await findAgentOfAgency(agency.id, charge.agent);
      if (!agent || agent.active !== true) {
        clearSessionCookie(res);
        return res.status(401).json({ error: "Votre session a expiré. Reconnectez-vous pour continuer." });
      }
      req.member = toAgent(agent);
    } else {
      req.member = gerantMember(agency);
    }
    req.agency = agency;
    next();
  }

  app.get("/api/health", (req, res) => {
    res.json({ ok: true, base: process.env.DATABASE_URL ? "neon" : "demo" });
  });

  app.post("/api/register", async (req, res) => {
    verifierSecretSession();
    const { name, city, phone, email, password } = req.body || {};
    const profil = validateProfile({ name, city, phone });
    if (profil.error) return res.status(400).json({ error: profil.error });
    const mail = String(email ?? "").trim().toLowerCase();
    if (!EMAIL.test(mail) || mail.length > 254) {
      return res.status(400).json({ error: "L'adresse e-mail saisie n'est pas valide." });
    }
    if (typeof password !== "string" || password.length < 6) {
      return res.status(400).json({ error: "Votre mot de passe est trop court. Utilisez au moins 6 caractères." });
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await query(
        `INSERT INTO agencies (id, email, password_hash, name, city, phone, created_at_iso)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, mail, hashPassword(password), profil.valeur.name, profil.valeur.city, profil.valeur.phone, now]
      );
    } catch (error) {
      if (/unique|duplicate/i.test(String(error?.code) + String(error?.message))) {
        return res.status(409).json({ error: "Cette adresse e-mail est déjà utilisée. Connectez-vous ou utilisez une autre adresse." });
      }
      throw error;
    }
    setSessionCookie(res, createSessionToken(id));
    const agenceCreee = await findAgency(id);
    res.status(201).json({ agency: toAgency(agenceCreee), member: gerantMember(agenceCreee) });
  });

  app.post("/api/login", async (req, res) => {
    verifierSecretSession();
    const mail = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    const { rows } = await query("SELECT * FROM agencies WHERE email = $1", [mail]);
    const agency = rows[0];
    if (agency) {
      // Compte agence = le gérant (identifiants inchangés, rétrocompatibles).
      if (!verifyPassword(password, agency.password_hash)) {
        return res.status(401).json({ error: "E-mail ou mot de passe incorrect. Vérifiez vos saisies." });
      }
      setSessionCookie(res, createSessionToken(agency.id));
      return res.json({ agency: toAgency(agency), member: gerantMember(agency) });
    }
    // Connexion par agent (e-mail unique au niveau du réseau).
    const { rows: agentRows } = await query("SELECT * FROM agents WHERE email = $1", [mail]);
    const agent = agentRows[0];
    if (!agent || !verifyPassword(password, agent.password_hash)) {
      return res.status(401).json({ error: "E-mail ou mot de passe incorrect. Vérifiez vos saisies." });
    }
    if (agent.active !== true) {
      return res.status(401).json({ error: "Votre compte agent est désactivé. Contactez le gérant de votre agence." });
    }
    const agentAgency = await findAgency(agent.agency_id);
    if (!agentAgency) {
      return res.status(401).json({ error: "E-mail ou mot de passe incorrect. Vérifiez vos saisies." });
    }
    setSessionCookie(res, createSessionToken(agentAgency.id, agent.id));
    res.json({ agency: toAgency(agentAgency), member: toAgent(agent) });
  });

  app.post("/api/logout", (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get("/api/me", requireAgency, (req, res) => {
    res.json({ agency: toAgency(req.agency), member: req.member });
  });

  app.patch("/api/me", requireAgency, async (req, res) => {
    const profil = validateProfile({
      name: req.body?.name ?? req.agency.name,
      city: req.body?.city ?? req.agency.city,
      phone: req.body?.phone ?? req.agency.phone
    });
    if (profil.error) return res.status(400).json({ error: profil.error });
    await query("UPDATE agencies SET name = $1, city = $2, phone = $3 WHERE id = $4", [
      profil.valeur.name, profil.valeur.city, profil.valeur.phone, req.agency.id
    ]);
    res.json({ agency: toAgency(await findAgency(req.agency.id)) });
  });

  /* ------------------------------ annuaire ------------------------------- */

  app.get("/api/agences", requireAgency, async (req, res) => {
    const { rows } = await query("SELECT id, name, city FROM agencies ORDER BY name");
    res.json({ agencies: rows.map(agencyDirectory) });
  });

  /* ------------------------------- agents -------------------------------- */

  // L'agence est l'unité de visibilité : chaque membre (gérant ou agent)
  // lit l'équipe de SON agence, jamais celle d'une autre.

  app.get("/api/agents", requireAgency, async (req, res) => {
    const { rows } = await query(
      "SELECT * FROM agents WHERE agency_id = $1 ORDER BY created_at_iso, name",
      [req.agency.id]
    );
    res.json({ agents: [gerantMember(req.agency), ...rows.map(toAgent)] });
  });

  app.post("/api/agents", requireAgency, requireGerant, async (req, res) => {
    const nom = textePropre(req.body?.name);
    const mail = String(req.body?.email ?? "").trim().toLowerCase();
    const brutTel = req.body?.phone ?? "";
    const password = String(req.body?.password ?? "");

    if (!dansLimite(nom, NOM_AGENCE)) {
      return res.status(400).json({ error: "Le nom de l'agent doit contenir 2 à 120 caractères." });
    }
    if (!EMAIL.test(mail) || mail.length > 254) {
      return res.status(400).json({ error: "L'adresse e-mail saisie n'est pas valide." });
    }
    const tel = normalizeIvorianPhone(brutTel ?? "");
    if (textePropre(brutTel) && !isValidIvorianPhone(tel)) {
      return res.status(400).json({ error: "Saisissez un téléphone ivoirien valide (10 chiffres), ou laissez vide." });
    }
    if (typeof password !== "string" || password.length < 6) {
      return res.status(400).json({ error: "Le mot de passe provisoire doit contenir au moins 6 caractères." });
    }

    // Un e-mail déjà pris par un compte gérant rendrait la connexion ambiguë.
    const { rows: conflit } = await query("SELECT 1 FROM agencies WHERE email = $1", [mail]);
    if (conflit.length) {
      return res.status(409).json({ error: "Cette adresse e-mail est déjà utilisée par un compte gérant." });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await query(
        `INSERT INTO agents (id, agency_id, name, email, phone, password_hash, role, active, created_at_iso)
         VALUES ($1, $2, $3, $4, $5, $6, 'agent', TRUE, $7)`,
        [id, req.agency.id, nom, mail, textePropre(brutTel) ? tel : null, hashPassword(password), now]
      );
    } catch (error) {
      if (/unique|duplicate/i.test(String(error?.code) + String(error?.message))) {
        return res.status(409).json({ error: "Cette adresse e-mail est déjà utilisée par un agent du réseau." });
      }
      throw error;
    }
    res.status(201).json({ agent: toAgent(await findAgentOfAgency(req.agency.id, id)) });
  });

  app.patch("/api/agents/:id", requireAgency, requireGerant, async (req, res) => {
    const agent = await findAgentOfAgency(req.agency.id, String(req.params.id ?? ""));
    if (!agent) {
      return res.status(404).json({ error: "Cet agent est introuvable dans votre agence." });
    }

    const champs = [];
    const params = [];
    const ajouter = (colonne, valeur) => {
      params.push(valeur);
      champs.push(`${colonne} = $${params.length}`);
    };

    if (req.body?.name !== undefined) {
      const nom = textePropre(req.body.name);
      if (!dansLimite(nom, NOM_AGENCE)) {
        return res.status(400).json({ error: "Le nom de l'agent doit contenir 2 à 120 caractères." });
      }
      ajouter("name", nom);
    }
    if (req.body?.phone !== undefined) {
      const brut = textePropre(req.body.phone);
      const tel = normalizeIvorianPhone(brut);
      if (brut && !isValidIvorianPhone(tel)) {
        return res.status(400).json({ error: "Saisissez un téléphone ivoirien valide (10 chiffres), ou laissez vide." });
      }
      ajouter("phone", brut ? tel : null);
    }
    if (req.body?.active !== undefined) {
      if (typeof req.body.active !== "boolean") {
        return res.status(400).json({ error: "Le statut actif/inactif est invalide." });
      }
      ajouter("active", req.body.active);
    }
    if (req.body?.password !== undefined) {
      const password = String(req.body.password);
      if (password.length < 6) {
        return res.status(400).json({ error: "Le nouveau mot de passe doit contenir au moins 6 caractères." });
      }
      ajouter("password_hash", hashPassword(password));
    }
    if (!champs.length) {
      return res.status(400).json({ error: "Aucune modification à enregistrer." });
    }

    await query(`UPDATE agents SET ${champs.join(", ")} WHERE id = $${params.length + 1}`, [
      ...params,
      agent.id
    ]);
    res.json({ agent: toAgent(await findAgentOfAgency(req.agency.id, agent.id)) });
  });

  /* ------------------------------- tarifs --------------------------------- */

  // La grille appartient à l'agence : lecture pour tout membre (le formulaire
  // « nouveau colis » en a besoin), écriture réservée au gérant. Pas de
  // suppression : une ligne quitte la grille par `active = FALSE` (PATCH).

  app.get("/api/tarifs", requireAgency, async (req, res) => {
    const { rows } = await query(
      "SELECT * FROM tarifs WHERE agency_id = $1 ORDER BY origin_city, destination_city, weight_min_kg",
      [req.agency.id]
    );
    res.json({ tarifs: rows.map(normaliserTarif) });
  });

  app.post("/api/tarifs", requireAgency, requireGerant, async (req, res) => {
    const controle = validerTarif(req.body || {});
    if (controle.error) return res.status(400).json({ error: controle.error });
    const tarif = controle.valeur;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await query(
      `INSERT INTO tarifs (id, agency_id, origin_city, destination_city, weight_min_kg, weight_max_kg, price_fcfa, active, created_at_iso)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)`,
      [id, req.agency.id, tarif.originCity, tarif.destinationCity, tarif.weightMinKg, tarif.weightMaxKg, tarif.priceFCFA, now]
    );
    const { rows } = await query("SELECT * FROM tarifs WHERE id = $1", [id]);
    res.status(201).json({ tarif: normaliserTarif(rows[0]) });
  });

  app.patch("/api/tarifs/:id", requireAgency, requireGerant, async (req, res) => {
    const { rows } = await query("SELECT * FROM tarifs WHERE id = $1 AND agency_id = $2", [
      String(req.params.id ?? ""),
      req.agency.id
    ]);
    const existant = rows[0];
    if (!existant) {
      return res.status(404).json({ error: "Ce tarif est introuvable dans votre grille." });
    }

    const actuel = normaliserTarif(existant);
    const candidat = { ...actuel };
    const champs = [];
    const params = [];
    const ajouter = (colonne, valeur) => {
      params.push(valeur);
      champs.push(`${colonne} = $${params.length}`);
    };

    const champsTarif = ["originCity", "destinationCity", "weightMinKg", "weightMaxKg", "priceFCFA"]
      .filter((cle) => req.body?.[cle] !== undefined);
    if (champsTarif.length) {
      for (const cle of champsTarif) candidat[cle] = req.body[cle];
      const controle = validerTarif(candidat);
      if (controle.error) return res.status(400).json({ error: controle.error });
      ajouter("origin_city", controle.valeur.originCity);
      ajouter("destination_city", controle.valeur.destinationCity);
      ajouter("weight_min_kg", controle.valeur.weightMinKg);
      ajouter("weight_max_kg", controle.valeur.weightMaxKg);
      ajouter("price_fcfa", controle.valeur.priceFCFA);
    }
    if (req.body?.active !== undefined) {
      if (typeof req.body.active !== "boolean") {
        return res.status(400).json({ error: "Le statut actif/inactif est invalide." });
      }
      ajouter("active", req.body.active);
    }
    if (!champs.length) {
      return res.status(400).json({ error: "Aucune modification à enregistrer." });
    }

    await query(`UPDATE tarifs SET ${champs.join(", ")} WHERE id = $${params.length + 1}`, [
      ...params,
      existant.id
    ]);
    const { rows: maj } = await query("SELECT * FROM tarifs WHERE id = $1", [existant.id]);
    res.json({ tarif: normaliserTarif(maj[0]) });
  });

  /* --------------------------- carnet de clients --------------------------- */

  // LOT 3 — mémoire client : le carnet appartient à l'agence (cloisonnement
  // strict), la clé pratique est le téléphone ivoirien. Aucune suppression :
  // une fiche se complète (PATCH), jamais ne disparaît.

  app.get("/api/clients", requireAgency, async (req, res) => {
    const kind = textePropre(req.query?.kind);
    if (kind && !["expediteur", "destinataire"].includes(kind)) {
      return res.status(400).json({ error: "Le rôle du client est invalide (expéditeur ou destinataire)." });
    }
    const { rows } = await query(
      "SELECT * FROM clients WHERE agency_id = $1 ORDER BY first_name, last_name",
      [req.agency.id]
    );
    const clients = rechercherClients({
      clients: rows.map(normaliserClient),
      recherche: textePropre(req.query?.recherche),
      kind
    });
    res.json({ clients });
  });

  app.post("/api/clients", requireAgency, async (req, res) => {
    const controle = validerClient(req.body || {});
    if (controle.error) return res.status(400).json({ error: controle.error });
    const nowISO = new Date().toISOString();
    const { client, cree } = await memoriserClient(req.agency.id, controle.valeur, nowISO);
    res.status(cree ? 201 : 200).json({ client, cree });
  });

  app.get("/api/clients/:id", requireAgency, async (req, res) => {
    const { rows } = await query("SELECT * FROM clients WHERE id = $1 AND agency_id = $2", [
      String(req.params.id ?? ""), req.agency.id
    ]);
    const client = rows[0] ? normaliserClient(rows[0]) : null;
    if (!client) return res.status(404).json({ error: "Ce client est introuvable dans votre carnet." });

    // Historique des colis du client : ceux de l'agence (expéditrice ou
    // destination) dont l'expéditeur ou le destinataire porte ce téléphone.
    const { rows: parcelsRows } = await query(
      "SELECT * FROM parcels WHERE owner_id = $1 OR destination_agency_id = $1 ORDER BY created_at DESC",
      [req.agency.id]
    );
    const historique = [];
    for (const row of parcelsRows) {
      const parcel = toParcel(row);
      const roles = [];
      if (normalizeIvorianPhone(parcel.sender?.phone ?? "") === client.phone) roles.push("expediteur");
      if (normalizeIvorianPhone(parcel.recipient?.phone ?? "") === client.phone) roles.push("destinataire");
      if (!roles.length) continue;
      historique.push({
        id: parcel.id,
        trackingCode: parcel.trackingCode,
        status: parcel.status,
        roles,
        originCity: parcel.originCity,
        destinationCity: parcel.destinationCity,
        priceFCFA: parcel.priceFCFA,
        createdAtISO: parcel.createdAtISO
      });
    }
    res.json({ client, historique });
  });

  app.patch("/api/clients/:id", requireAgency, async (req, res) => {
    const { rows } = await query("SELECT * FROM clients WHERE id = $1 AND agency_id = $2", [
      String(req.params.id ?? ""), req.agency.id
    ]);
    if (!rows[0]) return res.status(404).json({ error: "Ce client est introuvable dans votre carnet." });
    const actuel = normaliserClient(rows[0]);

    const candidat = {
      kind: req.body?.kind !== undefined ? req.body.kind : actuel.kind,
      firstName: req.body?.firstName !== undefined ? req.body.firstName : actuel.firstName,
      lastName: req.body?.lastName !== undefined ? req.body.lastName : actuel.lastName,
      phone: req.body?.phone !== undefined ? req.body.phone : actuel.phone,
      cni: req.body?.cni !== undefined ? req.body.cni : actuel.cni ?? "",
      city: req.body?.city !== undefined ? req.body.city : actuel.city,
      notes: req.body?.notes !== undefined ? req.body.notes : actuel.notes
    };
    const controle = validerClient(candidat);
    if (controle.error) return res.status(400).json({ error: controle.error });

    // Le téléphone (ou le rôle) peut changer : la nouvelle clé ne doit pas
    // entrer en collision avec une autre fiche du carnet.
    const { rows: conflit } = await query(
      "SELECT 1 FROM clients WHERE agency_id = $1 AND kind = $2 AND phone = $3 AND id <> $4",
      [req.agency.id, controle.valeur.kind, controle.valeur.phone, actuel.id]
    );
    if (conflit.length) {
      return res.status(409).json({ error: "Un client avec ce rôle et ce téléphone existe déjà dans votre carnet." });
    }

    const nowISO = new Date().toISOString();
    await query(
      `UPDATE clients SET kind = $1, first_name = $2, last_name = $3, phone = $4, cni = $5, city = $6, notes = $7, updated_at_iso = $8
       WHERE id = $9`,
      [
        controle.valeur.kind, controle.valeur.firstName, controle.valeur.lastName,
        controle.valeur.phone, controle.valeur.cni, controle.valeur.city, controle.valeur.notes,
        nowISO, actuel.id
      ]
    );
    const { rows: maj } = await query("SELECT * FROM clients WHERE id = $1", [actuel.id]);
    res.json({ client: normaliserClient(maj[0]) });
  });

  /* -------------------------------- colis -------------------------------- */

  app.get("/api/colis", requireAgency, async (req, res) => {
    const { rows } = await query(
      "SELECT * FROM parcels WHERE owner_id = $1 OR destination_agency_id = $1 ORDER BY created_at DESC",
      [req.agency.id]
    );
    res.json({ parcels: rows.map(toParcel) });
  });

  app.post("/api/colis", requireAgency, async (req, res) => {
    const brut = req.body?.values || {};
    const agencyNotRegistered = req.body?.agencyNotRegistered === true;

    // LOT 2 — prix issu de la grille tarifaire de l'agence expéditrice :
    // le serveur recalcule et impose le prix (autorité serveur). Repli
    // « saisie libre » uniquement si la grille ne couvre pas cet envoi.
    const { rows: tarifsRows } = await query(
      "SELECT * FROM tarifs WHERE agency_id = $1 AND active = TRUE",
      [req.agency.id]
    );
    const options = optionsPrix({
      tarifs: tarifsRows.map(normaliserTarif),
      originCity: brut.originCity,
      destinationCity: brut.destinationCity,
      weightKg: brut.weightKg
    });
    const values = options.length ? { ...brut, priceFCFA: options[0].priceFCFA } : brut;

    const message = validerColis({ values, agencyNotRegistered });
    if (message) return res.status(400).json({ error: message });

    // État de paiement saisi à l'enregistrement (LOT 2) ; absent = colis legacy.
    const paiementResolu = validerPaiement({ priceFCFA: Number(values.priceFCFA), payment: req.body?.payment ?? null });
    if (paiementResolu.error) return res.status(400).json({ error: paiementResolu.error });
    const paiement = paiementResolu.valeur;

    const { rows: agencesRows } = await query("SELECT id, name, city FROM agencies");
    const resolution = resoudreDestination({
      values,
      agencies: agencesRows.map(agencyDirectory),
      currentAgencyId: req.agency.id,
      agencyNotRegistered
    });
    if (!resolution.ok) return res.status(400).json({ error: resolution.error });

    const parcelId = crypto.randomUUID();
    const nowISO = new Date().toISOString();
    const trackingCode = await generateUniqueTrackingCode();
    const built = construireColis({
      values,
      currentAgency: toAgency(req.agency),
      destination: resolution.destination,
      parcelId,
      trackingCode,
      nowISO,
      // Traçabilité : chaque écriture d'étape porte l'agent acteur.
      actor: { id: req.member.id, name: req.member.name }
    });
    const p = built.parcel;

    // LOT 6 — quota du plan : seule la création d'un NOUVEAU colis par
    // l'agence expéditrice est comptée (l'agence de destination ne paie
    // jamais). Refus uniquement si le quota est atteint ET le portefeuille
    // prépayé insuffisant ; aucune autre route (lecture, progression,
    // réception, contrôle, retour) ne consulte la facturation. Une panne
    // inattendue de la facturation n'empêche pas l'agence de travailler.
    let reservation = null;
    try {
      reservation = await reserverCreation({
        agencyId: req.agency.id, parcelId: p.id, trackingCode: p.trackingCode, acteurNom: req.member.name
      });
    } catch (error) {
      console.error("[facturation] réservation ignorée :", error?.code ?? "erreur");
    }
    if (reservation && !reservation.ok) {
      return res.status(reservation.status).json({ error: reservation.error, quotaAtteint: true });
    }

    let colisInsere = false;
    try {
      await query(
        `INSERT INTO parcels (id, tracking_code, owner_id, owner_agency_name, owner_agency_city,
          destination_agency_id, destination_agency_name, destination_agency_city,
          unregistered_destination_agency, sender, recipient, package_nature, weight_kg, price_fcfa,
          origin_city, destination_city, status, history, payment_status, paid_amount_fcfa, created_at_iso)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [
          p.id, p.trackingCode, p.ownerId, p.ownerAgencyName, p.ownerAgencyCity,
          p.destinationAgencyId, p.destinationAgencyName, p.destinationAgencyCity,
          p.unregisteredDestinationAgency ? JSON.stringify(p.unregisteredDestinationAgency) : null,
          JSON.stringify(p.sender), JSON.stringify(p.recipient),
          p.packageNature, p.weightKg, p.priceFCFA,
          p.originCity, p.destinationCity, p.status, JSON.stringify(p.history),
          paiement?.status ?? null, paiement?.paid ?? null, p.createdAtISO
        ]
      );
      colisInsere = true;
      // Montant encaissé immédiatement (payé au départ ou partiel) : première
      // ligne du journal de caisse de l'agence expéditrice.
      if (paiement && paiement.paid > 0) {
        await query(
          `INSERT INTO encaissements (id, parcel_id, agency_id, agent_id, agent_name, amount_fcfa, mode, date_key, created_at_iso)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            crypto.randomUUID(), p.id, req.agency.id, req.member.id, req.member.name,
            paiement.paid, paiement.mode, jourCle(), nowISO
          ]
        );
      }
      // LOT 3 — mémoire client : l'expéditeur et le destinataire entrent dans
      // le carnet de l'agence (upsert). Un échec ici ne doit jamais empêcher
      // l'enregistrement du colis lui-même.
      try {
        for (const fiche of clientsDepuisColis(p)) {
          await memoriserClient(req.agency.id, fiche, nowISO);
        }
      } catch (error) {
        console.error("[clients] mémorisation ignorée :", error?.message);
      }
    } catch (error) {
      // Colis non enregistré : la réservation du quota (et un éventuel débit
      // hors forfait) est rendue, remboursement journalisé.
      if (!colisInsere && reservation?.annuler) await reservation.annuler().catch(() => {});
      if (/unique|duplicate/i.test(String(error?.code) + String(error?.message))) {
        return res.status(409).json({ error: "Ce code de suivi vient d'être attribué. Réessayez l'enregistrement." });
      }
      throw error;
    }
    // LOT 10 — le compteur à jour revient avec le colis : l'interface se met
    // à jour immédiatement, sans attendre le rafraîchissement périodique.
    const compteur = await resumeCompteur(req.agency.id).catch(() => null);
    res.status(201).json({
      parcel: toParcel((await query("SELECT * FROM parcels WHERE id = $1", [p.id])).rows[0]),
      ...(reservation?.decision ? { facturation: { periode: reservation.periode, ...reservation.decision } } : {}),
      ...(compteur ? { compteur } : {})
    });
  });

  app.get("/api/colis/:id", requireAgency, async (req, res) => {
    const row = await findParcelForAgency(req.params.id, req.agency.id);
    if (!row) return res.status(404).json({ error: "Ce colis est introuvable ou vous n'y avez pas accès." });
    res.json({ parcel: toParcel(row) });
  });

  app.post("/api/colis/:id/attach", requireAgency, async (req, res) => {
    const row = await findParcelForAgency(req.params.id, req.agency.id);
    if (!row) return res.status(404).json({ error: "Ce colis est introuvable ou vous n'y avez pas accès." });
    const parcel = toParcel(row);

    if (!peutRattacher({ parcel, agencyId: req.agency.id })) {
      return res.status(403).json({ error: "Ce colis a déjà une agence de destination, ou vous n'êtes pas l'agence expéditrice." });
    }
    const cible = await findAgency(String(req.body?.agencyId ?? ""));
    if (!cible) {
      return res.status(400).json({ error: "Cette agence n'est pas inscrite : demandez-lui de créer son compte avant de la rattacher." });
    }
    if (cible.id === req.agency.id) {
      return res.status(400).json({ error: "L'agence de destination doit être différente de l'agence expéditrice." });
    }

    const now = new Date().toISOString();
    const changes = changementsRattachement({
      parcel,
      agency: toAgency(cible),
      ownerAgency: toAgency(req.agency),
      now,
      destinationCity: req.body?.destinationCity ?? null,
      actor: { id: req.member.id, name: req.member.name }
    });

    await query(
      `UPDATE parcels SET
         destination_agency_id = $1, destination_agency_name = $2, destination_agency_city = $3,
         destination_agency_attached_at = $4, destination_agency_attached_by = $5,
         destination_city = $6, history = $7, updated_at = now()
       WHERE id = $8`,
      [
        changes.destinationAgencyId, changes.destinationAgencyName, changes.destinationAgencyCity,
        changes.destinationAgencyAttachedAt, changes.destinationAgencyAttachedBy,
        changes.destinationCity, JSON.stringify(changes.history), parcel.id
      ]
    );
    res.json({ parcel: toParcel((await query("SELECT * FROM parcels WHERE id = $1", [parcel.id])).rows[0]) });
  });

  app.post("/api/colis/:id/progress", requireAgency, async (req, res) => {
    const row = await findParcelForAgency(req.params.id, req.agency.id);
    if (!row) return res.status(404).json({ error: "Ce colis est introuvable ou vous n'y avez pas accès." });
    const parcel = toParcel(row);

    const nextStatus = prochaineEtape({ parcel, agencyId: req.agency.id });
    if (!nextStatus) {
      return res.status(403).json({ error: "Cette étape doit être effectuée par l'agence concernée." });
    }

    const nowISO = new Date().toISOString();
    let collectedBy = null;
    if (nextStatus === "Retiré") {
      const nom = textePropre(req.body?.collectedBy?.name);
      const cni = textePropre(req.body?.collectedBy?.cni);
      if (!dansLimite(nom, NOM_AGENCE)) {
        return res.status(400).json({ error: "Indiquez le nom de la personne qui retire le colis." });
      }
      if (!isValidCni(cni)) {
        return res.status(400).json({ error: "Le numéro CNI doit contenir 8 à 25 caractères et au moins un chiffre." });
      }
      collectedBy = { name: nom, cni: cni.toUpperCase(), date: nowISO };
    }

    const history = Array.isArray(parcel.history) ? [...parcel.history] : [];
    history.push({
      status: nextStatus,
      date: nowISO,
      agencyName: req.agency.name,
      city: req.agency.city,
      actorId: req.member.id,
      actorName: req.member.name
    });

    await query(
      `UPDATE parcels SET status = $1, history = $2, collected_by = $3, updated_at = now() WHERE id = $4`,
      [nextStatus, JSON.stringify(history), collectedBy ? JSON.stringify(collectedBy) : null, parcel.id]
    );
    res.json({ parcel: toParcel((await query("SELECT * FROM parcels WHERE id = $1", [parcel.id])).rows[0]) });
  });

  /* ------------------------- encaissement / caisse ------------------------ */

  // Encaisser le reste d'un colis : réservé à une des deux agences concernées
  // (expéditrice ou destination) — mêmes règles de visibilité que la lecture.

  app.post("/api/colis/:id/encaisser", requireAgency, async (req, res) => {
    const row = await findParcelForAgency(req.params.id, req.agency.id);
    if (!row) return res.status(404).json({ error: "Ce colis est introuvable ou vous n'y avez pas accès." });
    const parcel = toParcel(row);

    const paye = parcel.paidAmountFCFA ?? 0;
    const reste = resteAPayer({ priceFCFA: parcel.priceFCFA, paidAmountFCFA: paye });
    if (reste <= 0) {
      return res.status(400).json({ error: "Ce colis est déjà entièrement réglé." });
    }
    const montant = Math.round(Number(req.body?.amountFCFA));
    if (!Number.isFinite(montant) || montant <= 0) {
      return res.status(400).json({ error: "Indiquez le montant encaissé (supérieur à 0 FCFA)." });
    }
    if (montant > reste) {
      return res.status(400).json({ error: `Le montant dépasse le reste à encaisser (${reste} FCFA).` });
    }
    const mode = textePropre(req.body?.mode);
    if (!estModeEncaissement(mode)) {
      return res.status(400).json({ error: "Choisissez le mode de paiement : espèces ou mobile money." });
    }

    const etat = etatApresEncaissement({
      priceFCFA: parcel.priceFCFA,
      paidAmountFCFA: paye,
      montant
    });
    const nowISO = new Date().toISOString();
    const encaissementId = crypto.randomUUID();
    await query(
      `INSERT INTO encaissements (id, parcel_id, agency_id, agent_id, agent_name, amount_fcfa, mode, date_key, created_at_iso)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        encaissementId, parcel.id, req.agency.id, req.member.id, req.member.name,
        montant, mode, jourCle(), nowISO
      ]
    );
    await query("UPDATE parcels SET payment_status = $1, paid_amount_fcfa = $2, updated_at = now() WHERE id = $3", [
      etat.status, etat.paid, parcel.id
    ]);
    const { rows: maj } = await query("SELECT * FROM parcels WHERE id = $1", [parcel.id]);
    res.status(201).json({
      parcel: toParcel(maj[0]),
      encaissement: {
        id: encaissementId,
        amountFCFA: montant,
        mode,
        dateKey: jourCle(),
        createdISO: nowISO,
        agentName: req.member.name
      }
    });
  });

  app.get("/api/caisse", requireAgency, async (req, res) => {
    const date = resoudreDateCaisse(req.query?.date);
    if (!date) return res.status(400).json({ error: "Format de date invalide : utilisez AAAA-MM-JJ." });

    const { rows: encRows } = await query(
      `SELECT e.*, p.tracking_code, p.sender, p.recipient, p.price_fcfa, p.paid_amount_fcfa
       FROM encaissements e
       JOIN parcels p ON p.id = e.parcel_id
       WHERE e.agency_id = $1 AND e.date_key = $2
       ORDER BY e.created_at`,
      [req.agency.id, date]
    );
    const encaissements = encRows.map((row) => {
      const sender = json(row.sender, {});
      const recipient = json(row.recipient, {});
      const paye = row.paid_amount_fcfa ?? 0;
      return {
        id: row.id,
        dateKey: row.date_key,
        createdISO: row.created_at_iso,
        parcelId: row.parcel_id,
        trackingCode: row.tracking_code,
        senderName: textePropre(`${sender.firstName || ""} ${sender.lastName || ""}`),
        recipientName: textePropre(`${recipient.firstName || ""} ${recipient.lastName || ""}`),
        priceFCFA: row.price_fcfa,
        paidAmountFCFA: paye,
        resteFCFA: resteAPayer({ priceFCFA: row.price_fcfa, paidAmountFCFA: paye }),
        amountFCFA: row.amount_fcfa,
        mode: row.mode,
        agentName: row.agent_name,
        label: row.label || ""
      };
    });

    const totaux = { especes: 0, mobile_money: 0, total: 0 };
    for (const item of encaissements) {
      totaux[item.mode] = (totaux[item.mode] || 0) + item.amountFCFA;
      totaux.total += item.amountFCFA;
    }

    // Restes à encaisser : colis me concernant (expéditrice ou destination)
    // jamais entièrement réglés — l'impayé ne bloque jamais le colis.
    const { rows: resteRows } = await query(
      `SELECT * FROM parcels
       WHERE (owner_id = $1 OR destination_agency_id = $1)
         AND COALESCE(paid_amount_fcfa, 0) < price_fcfa
       ORDER BY created_at DESC`,
      [req.agency.id]
    );
    const restes = resteRows.map((row) => {
      const sender = json(row.sender, {});
      const recipient = json(row.recipient, {});
      const paye = row.paid_amount_fcfa ?? 0;
      return {
        id: row.id,
        trackingCode: row.tracking_code,
        senderName: textePropre(`${sender.firstName || ""} ${sender.lastName || ""}`),
        recipientName: textePropre(`${recipient.firstName || ""} ${recipient.lastName || ""}`),
        priceFCFA: row.price_fcfa,
        paidAmountFCFA: paye,
        resteFCFA: resteAPayer({ priceFCFA: row.price_fcfa, paidAmountFCFA: paye }),
        status: row.status,
        destinationAgencyName: row.destination_agency_name,
        createdAtISO: row.created_at_iso
      };
    });

    const { rows: clotureRows } = await query(
      "SELECT * FROM caisse_closures WHERE agency_id = $1 AND date_key = $2",
      [req.agency.id, date]
    );
    res.json({
      date,
      encaissements,
      totaux,
      restes,
      cloture: clotureRows[0] ? toCaisseClosure(clotureRows[0]) : null
    });
  });

  app.post("/api/caisse/cloture", requireAgency, async (req, res) => {
    const date = resoudreDateCaisse(req.body?.date);
    if (!date) return res.status(400).json({ error: "Format de date invalide : utilisez AAAA-MM-JJ." });
    const compteur = Math.round(Number(req.body?.countedTotalFCFA));
    if (!Number.isFinite(compteur) || compteur < 0) {
      return res.status(400).json({ error: "Indiquez le total compté en FCFA (nombre positif)." });
    }

    const { rows: existante } = await query(
      "SELECT 1 FROM caisse_closures WHERE agency_id = $1 AND date_key = $2",
      [req.agency.id, date]
    );
    if (existante.length) {
      return res.status(409).json({ error: `La caisse du ${date} est déjà clôturée par votre agence.` });
    }
    const { rows: totRows } = await query(
      "SELECT COALESCE(SUM(amount_fcfa), 0)::int AS total FROM encaissements WHERE agency_id = $1 AND date_key = $2",
      [req.agency.id, date]
    );
    const calcule = Number(totRows[0].total);
    const id = crypto.randomUUID();
    const nowISO = new Date().toISOString();
    await query(
      `INSERT INTO caisse_closures (id, agency_id, date_key, counted_total_fcfa, computed_total_fcfa, ecart_fcfa, agent_id, agent_name, created_at_iso)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, req.agency.id, date, compteur, calcule, compteur - calcule, req.member.id, req.member.name, nowISO]
    );
    const { rows } = await query("SELECT * FROM caisse_closures WHERE id = $1", [id]);
    res.status(201).json({ cloture: toCaisseClosure(rows[0]) });
  });

  /* ------------------------- bordereaux (LOT 4) ---------------------------- */

  // Chaîne de preuve entre deux agences : 1 à 200 colis expédiés ensemble,
  // transporteur identifié, émargement à chaque bout. Lecture aux deux
  // agences concernées ; écritures verrouillées par rôle ; jamais de
  // suppression ; colis et transporteur immuables après remise.

  async function findBordereau(id) {
    const { rows } = await query("SELECT * FROM bordereaux WHERE id = $1", [String(id ?? "")]);
    return rows[0] || null;
  }

  async function findBordereauForAgency(id, agencyId) {
    const { rows } = await query(
      "SELECT * FROM bordereaux WHERE id = $1 AND (from_agency_id = $2 OR to_agency_id = $2)",
      [String(id ?? ""), agencyId]
    );
    return rows[0] || null;
  }

  async function parcelIdsDuBordereau(bordereauId) {
    const { rows } = await query("SELECT parcel_id FROM bordereau_parcels WHERE bordereau_id = $1", [bordereauId]);
    return rows.map((row) => row.parcel_id);
  }

  async function parcelsDuBordereau(bordereauId) {
    const { rows } = await query(
      `SELECT p.* FROM parcels p
       JOIN bordereau_parcels bp ON bp.parcel_id = p.id
       WHERE bp.bordereau_id = $1
       ORDER BY p.tracking_code`,
      [bordereauId]
    );
    return rows;
  }

  /** Ajoute une étape à l'historique d'un colis (traçabilité acteur incluse). */
  async function ajouterEtapeColis(row, etape) {
    const parcel = toParcel(row);
    const history = Array.isArray(parcel.history) ? [...parcel.history] : [];
    history.push(etape);
    await query("UPDATE parcels SET history = $1, updated_at = now() WHERE id = $2", [
      JSON.stringify(history), parcel.id
    ]);
    return history;
  }

  app.get("/api/bordereaux", requireAgency, async (req, res) => {
    const { rows } = await query(
      "SELECT * FROM bordereaux WHERE from_agency_id = $1 OR to_agency_id = $1 ORDER BY created_at DESC",
      [req.agency.id]
    );
    res.json({
      bordereaux: rows.map((row) => ({
        ...normaliserBordereau(row),
        role: row.from_agency_id === req.agency.id ? "emetteur" : "destinataire"
      }))
    });
  });

  app.post("/api/bordereaux", requireAgency, async (req, res) => {
    const controle = validerCreationBordereau(req.body || {});
    if (controle.error) return res.status(400).json({ error: controle.error });
    const { carrierName, carrierPhone, vehicleRef, parcelIds } = controle.valeur;

    const placeholders = parcelIds.map((_, index) => `$${index + 1}`).join(", ");
    const { rows } = await query(`SELECT * FROM parcels WHERE id IN (${placeholders})`, parcelIds);
    if (rows.length !== parcelIds.length) {
      return res.status(400).json({ error: "Au moins un colis sélectionné est introuvable. Actualisez la liste." });
    }
    const embarquement = validerColisEmbarquables({ parcels: rows.map(toParcel), agencyId: req.agency.id });
    if (embarquement.error) return res.status(400).json({ error: embarquement.error });

    const id = crypto.randomUUID();
    const code = await generateUniqueBordereauCode();
    const nowISO = new Date().toISOString();
    const { toAgencyId, toAgencyName, toCity, originCity } = embarquement.destination;
    await query(
      `INSERT INTO bordereaux (id, code, from_agency_id, from_agency_name, from_city,
        to_agency_id, to_agency_name, to_city, carrier_name, carrier_phone, vehicle_ref,
        parcel_count, status, created_at_iso)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'Préparé', $13)`,
      [
        id, code, req.agency.id, req.agency.name, originCity,
        toAgencyId, toAgencyName, toCity, carrierName, carrierPhone, vehicleRef,
        parcelIds.length, nowISO
      ]
    );
    for (const parcelId of parcelIds) {
      await query(
        "INSERT INTO bordereau_parcels (bordereau_id, parcel_id) VALUES ($1, $2)",
        [id, parcelId]
      );
      await query("UPDATE parcels SET bordereau_id = $1, updated_at = now() WHERE id = $2", [id, parcelId]);
    }
    const bordereau = normaliserBordereau(await findBordereau(id), parcelIds);
    res.status(201).json({ bordereau });
  });

  app.get("/api/bordereaux/:id", requireAgency, async (req, res) => {
    const row = await findBordereauForAgency(req.params.id, req.agency.id);
    if (!row) return res.status(404).json({ error: "Ce bordereau est introuvable ou vous n'y avez pas accès." });
    const parcelIds = await parcelIdsDuBordereau(row.id);
    const parcelRows = await parcelsDuBordereau(row.id);
    const bordereau = normaliserBordereau(row, parcelIds);
    res.json({
      bordereau,
      parcels: parcelRows.map((parcelRow) => {
        const parcel = toParcel(parcelRow);
        return {
          id: parcel.id,
          trackingCode: parcel.trackingCode,
          status: parcel.status,
          packageNature: parcel.packageNature,
          weightKg: parcel.weightKg,
          destinationCity: parcel.destinationCity,
          absent: bordereau.missingParcelIds.includes(parcel.id)
        };
      }),
      actions: {
        prochaineEtape: prochaineEtapeBordereau({ bordereau, agencyId: req.agency.id }),
        peutControler: peutControler({ bordereau, agencyId: req.agency.id }),
        role: row.from_agency_id === req.agency.id ? "emetteur" : "destinataire"
      }
    });
  });

  app.post("/api/bordereaux/:id/remettre", requireAgency, async (req, res) => {
    const row = await findBordereauForAgency(req.params.id, req.agency.id);
    if (!row) return res.status(404).json({ error: "Ce bordereau est introuvable ou vous n'y avez pas accès." });
    const bordereau = normaliserBordereau(row);

    const next = prochaineEtapeBordereau({ bordereau, agencyId: req.agency.id });
    if (!next) {
      return res.status(403).json({ error: "Cette étape doit être effectuée par l'agence concernée, ou le bordereau est déjà arrivé à échéance." });
    }
    const demandee = textePropre(req.body?.etape);
    if (demandee && demandee !== next) {
      return res.status(400).json({ error: `La prochaine étape de ce bordereau est « ${next} ».` });
    }

    const nowISO = new Date().toISOString();
    if (next === "Remis") {
      await query(
        "UPDATE bordereaux SET status = 'Remis', handed_over_at = $1, handed_over_by = $2, updated_at = now() WHERE id = $3",
        [nowISO, req.member.name, bordereau.id]
      );
      // Chaque colis embarqué trace la remise au transporteur (preuve horodatée,
      // visible dans le suivi public via la note — sans donnée personnelle).
      // Un colis encore « Enregistré » est expédié par le même geste : la
      // remise physique au transporteur EST l'expédition (acteur légitime).
      for (const parcelRow of await parcelsDuBordereau(bordereau.id)) {
        const parcel = toParcel(parcelRow);
        const expedition = parcel.status === "Enregistré";
        const note = `Bordereau ${bordereau.code} — ${bordereau.carrierName}${bordereau.vehicleRef ? ` (${bordereau.vehicleRef})` : ""}`;
        const history = Array.isArray(parcel.history) ? [...parcel.history] : [];
        history.push({
          status: expedition ? "Expédié" : "Remis au transporteur",
          date: nowISO,
          agencyName: req.agency.name,
          city: req.agency.city,
          note: expedition ? `Remis au transporteur — ${note}` : note,
          actorId: req.member.id,
          actorName: req.member.name
        });
        await query(
          "UPDATE parcels SET status = $1, history = $2, updated_at = now() WHERE id = $3",
          [expedition ? "Expédié" : parcel.status, JSON.stringify(history), parcel.id]
        );
      }
    } else if (next === "En route") {
      await query(
        "UPDATE bordereaux SET status = 'En route', departed_at = $1, updated_at = now() WHERE id = $2",
        [nowISO, bordereau.id]
      );
      // Le lot roule : les colis « Expédié » passent « En transit » (étape de
      // l'expéditeur, horodatée) — le contrôle d'arrivée pourra ensuite les
      // confirmer arrivés sans saut de statut.
      for (const parcelRow of await parcelsDuBordereau(bordereau.id)) {
        const parcel = toParcel(parcelRow);
        if (parcel.status !== "Expédié") continue;
        const history = Array.isArray(parcel.history) ? [...parcel.history] : [];
        history.push({
          status: "En transit",
          date: nowISO,
          agencyName: req.agency.name,
          city: req.agency.city,
          note: `Bordereau ${bordereau.code} en route`,
          actorId: req.member.id,
          actorName: req.member.name
        });
        await query("UPDATE parcels SET status = 'En transit', history = $1, updated_at = now() WHERE id = $2", [
          JSON.stringify(history), parcel.id
        ]);
      }
    } else if (next === "Arrivé") {
      await query(
        "UPDATE bordereaux SET status = 'Arrivé', arrived_at = $1, arrived_by = $2, updated_at = now() WHERE id = $3",
        [nowISO, req.member.name, bordereau.id]
      );
    }
    const maj = normaliserBordereau(await findBordereau(bordereau.id), await parcelIdsDuBordereau(bordereau.id));
    // LOT 5 — arrivée du lot notifiée aux deux agences (contrôle à faire).
    if (next === "Arrivé") await notifier({ type: "bordereau_arrive", bordereau: maj });
    res.json({ bordereau: maj });
  });

  app.post("/api/bordereaux/:id/controle", requireAgency, async (req, res) => {
    const row = await findBordereauForAgency(req.params.id, req.agency.id);
    if (!row) return res.status(404).json({ error: "Ce bordereau est introuvable ou vous n'y avez pas accès." });
    const bordereau = normaliserBordereau(row, await parcelIdsDuBordereau(row.id));
    if (!peutControler({ bordereau, agencyId: req.agency.id })) {
      return res.status(403).json({ error: "Le contrôle d'arrivée est réservé à l'agence de destination (ou à l'agence expéditrice si la destination n'est pas rattachée), une fois le bordereau arrivé." });
    }

    const absentsDemandes = Array.isArray(req.body?.absentParcelIds) ? req.body.absentParcelIds : [];
    const controle = resoudreControle({ bordereau, parcelIds: bordereau.parcelIds, absentParcelIds: absentsDemandes });
    if (controle.error) return res.status(400).json({ error: controle.error });

    const nowISO = new Date().toISOString();
    await query(
      `UPDATE bordereaux SET status = $1, checked_at = $2, checked_by = $3, missing_parcel_ids = $4, updated_at = now()
       WHERE id = $5`,
      [controle.status, nowISO, req.member.name, JSON.stringify(controle.absents), bordereau.id]
    );

    // Colis présents : confirmés arrivés (l'étape suit les règles de
    // progression habituelles — jamais de saut de statut).
    let colisAvances = 0;
    const parcelRows = await parcelsDuBordereau(bordereau.id);
    for (const parcelRow of parcelRows) {
      const parcel = toParcel(parcelRow);
      if (!controle.presents.includes(parcel.id)) continue;
      const prochaine = prochaineEtape({ parcel, agencyId: req.agency.id });
      if (prochaine !== "Arrivé à l'agence de destination") continue;
      const history = Array.isArray(parcel.history) ? [...parcel.history] : [];
      history.push({
        status: "Arrivé à l'agence de destination",
        date: nowISO,
        agencyName: req.agency.name,
        city: req.agency.city,
        note: `Contrôle d'arrivée du bordereau ${bordereau.code}`,
        actorId: req.member.id,
        actorName: req.member.name
      });
      await query("UPDATE parcels SET status = $1, history = $2, updated_at = now() WHERE id = $3", [
        "Arrivé à l'agence de destination", JSON.stringify(history), parcel.id
      ]);
      colisAvances += 1;
    }

    // Colis absents : incident automatique « perdu » (visible par les deux
    // agences, bordereau en preuve) — s'il n'y en a pas déjà un de non résolu.
    let incidentsCrees = 0;
    const incidentsAutomatiques = [];
    for (const parcelId of controle.absents) {
      const { rows: deja } = await query(
        "SELECT 1 FROM incidents WHERE parcel_id = $1 AND state <> 'resolu'",
        [parcelId]
      );
      if (deja.length) continue;
      const incidentId = crypto.randomUUID();
      await query(
        `INSERT INTO incidents (id, parcel_id, bordereau_id, type, state, note, opened_by_agency_id, opened_by_id, opened_by_name, opened_at_iso)
         VALUES ($1, $2, $3, 'perdu', 'ouvert', $4, $5, $6, $7, $8)`,
        [
          incidentId, parcelId, bordereau.id,
          `Absent au contrôle d'arrivée du bordereau ${bordereau.code} (${bordereau.fromCity} → ${bordereau.toCity}, transporteur ${bordereau.carrierName}).`,
          req.agency.id, req.member.id, req.member.name, nowISO
        ]
      );
      incidentsAutomatiques.push({ incidentId, parcelId });
      incidentsCrees += 1;
    }

    const maj = normaliserBordereau(await findBordereau(bordereau.id), bordereau.parcelIds);

    // LOT 5 — notifications aux deux agences : chaque incident automatique,
    // puis l'écart du lot (codes de suivi seulement, aucune donnée personnelle).
    const parcelParId = new Map(parcelRows.map((parcelRow) => [parcelRow.id, toParcel(parcelRow)]));
    for (const { incidentId, parcelId } of incidentsAutomatiques) {
      await notifier({
        type: "incident_ouvert",
        parcel: parcelParId.get(parcelId),
        incident: { id: incidentId, type: "perdu", automatique: true },
        bordereau: maj
      });
    }
    if (controle.status === "Écart") {
      await notifier({
        type: "bordereau_ecart",
        bordereau: maj,
        absents: controle.absents.map((parcelId) => parcelParId.get(parcelId)?.trackingCode).filter(Boolean)
      });
    }
    res.status(201).json({ bordereau: maj, colisAvances, incidentsCrees, absents: controle.absents });
  });

  /* --------------------- suivi public d'un bordereau ----------------------- */

  app.get("/api/suivi-bordereau/:code", async (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase();
    const { rows } = await query("SELECT * FROM bordereaux WHERE code = $1", [code]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Aucun bordereau ne correspond à ce code. Vérifiez les caractères saisis." });
    const bordereau = normaliserBordereau(row, await parcelIdsDuBordereau(row.id));
    const parcelRows = await parcelsDuBordereau(row.id);
    // Projection stricte : codes de suivi et statuts, jamais de noms,
    // téléphones (y compris celui du transporteur) ni CNI.
    res.json({
      bordereau: bordereauPublic(
        { ...bordereau, carrierPhone: "" },
        parcelRows.map((parcelRow) => toParcel(parcelRow)),
        row.updated_at ? new Date(row.updated_at).toISOString() : bordereau.createdAtISO
      )
    });
  });

  /* ----------------------------- incidents (LOT 4) -------------------------- */

  app.post("/api/colis/:id/incidents", requireAgency, async (req, res) => {
    const row = await findParcelForAgency(req.params.id, req.agency.id);
    if (!row) return res.status(404).json({ error: "Ce colis est introuvable ou vous n'y avez pas accès." });
    const parcel = toParcel(row);

    const { rows: deja } = await query(
      "SELECT 1 FROM incidents WHERE parcel_id = $1 AND state <> 'resolu'",
      [parcel.id]
    );
    if (deja.length) {
      return res.status(409).json({ error: "Un incident est déjà en cours sur ce colis : faites-le avancer (recherches, résolution) au lieu d'en ouvrir un second." });
    }
    const controle = validerOuvertureIncident(req.body || {});
    if (controle.error) return res.status(400).json({ error: controle.error });

    const id = crypto.randomUUID();
    const nowISO = new Date().toISOString();
    await query(
      `INSERT INTO incidents (id, parcel_id, bordereau_id, type, state, note, opened_by_agency_id, opened_by_id, opened_by_name, opened_at_iso)
       VALUES ($1, $2, $3, $4, 'ouvert', $5, $6, $7, $8, $9)`,
      [id, parcel.id, parcel.bordereauId ?? null, controle.valeur.type, controle.valeur.note, req.agency.id, req.member.id, req.member.name, nowISO]
    );
    const { rows } = await query("SELECT * FROM incidents WHERE id = $1", [id]);
    const incident = normaliserIncident(rows[0]);
    // LOT 5 — les deux agences du colis sont notifiées (simulation par défaut,
    // jamais la note libre : elle peut citer un client).
    await notifier({ type: "incident_ouvert", parcel, incident });
    res.status(201).json({ incident });
  });

  app.get("/api/incidents", requireAgency, async (req, res) => {
    const etat = textePropre(req.query?.state);
    if (etat && !["ouvert", "recherches", "resolu"].includes(etat)) {
      return res.status(400).json({ error: "L'état demandé est invalide (ouvert, recherches ou resolu)." });
    }
    const { rows } = await query(
      `SELECT i.*, p.tracking_code, p.status AS parcel_status, p.origin_city, p.destination_city,
              p.owner_id, p.destination_agency_id
       FROM incidents i
       JOIN parcels p ON p.id = i.parcel_id
       WHERE p.owner_id = $1 OR p.destination_agency_id = $1
       ORDER BY i.created_at DESC`,
      [req.agency.id]
    );
    const incidents = rows
      .filter((row) => !etat || row.state === etat)
      .map((row) => ({
        ...normaliserIncident(row),
        parcel: {
          id: row.parcel_id,
          trackingCode: row.tracking_code,
          status: row.parcel_status,
          originCity: row.origin_city,
          destinationCity: row.destination_city
        }
      }));
    res.json({ incidents });
  });

  app.patch("/api/incidents/:id", requireAgency, async (req, res) => {
    const { rows } = await query(
      `SELECT i.*, p.owner_id, p.destination_agency_id
       FROM incidents i JOIN parcels p ON p.id = i.parcel_id
       WHERE i.id = $1`,
      [String(req.params.id ?? "")]
    );
    const row = rows[0];
    if (!row || (row.owner_id !== req.agency.id && row.destination_agency_id !== req.agency.id)) {
      return res.status(404).json({ error: "Cet incident est introuvable ou vous n'y avez pas accès." });
    }
    const incident = normaliserIncident(row);
    if (incident.state === "resolu") {
      return res.status(409).json({ error: "Cet incident est déjà résolu : il ne peut plus être modifié." });
    }
    const controle = validerTransitionIncident({ incident, state: req.body?.state, resolution: req.body?.resolution });
    if (controle.error) return res.status(400).json({ error: controle.error });

    const nowISO = new Date().toISOString();
    await query(
      `UPDATE incidents SET state = $1, resolution = $2, updated_by_name = $3,
         resolved_at_iso = CASE WHEN $1 = 'resolu' THEN $4 ELSE resolved_at_iso END,
         updated_at = now()
       WHERE id = $5`,
      [controle.valeur.state, controle.valeur.resolution, req.member.name, nowISO, incident.id]
    );
    const { rows: maj } = await query("SELECT * FROM incidents WHERE id = $1", [incident.id]);
    res.json({ incident: normaliserIncident(maj[0]) });
  });

  /* ------------------------------- photos (LOT 4) --------------------------- */

  // Preuve horodatée : 2 photos max par étape (prise en charge / arrivée),
  // image/* uniquement, compressées côté navigateur (~200 Ko). Le contenu vit
  // HORS de Postgres (lib/photos.js : disque local ou Vercel Blob). Lecture
  // réservée aux deux agences du colis ; aucune suppression.

  const ETAPES_PHOTO = ["prise_en_charge", "arrivee"];
  const MAX_PHOTOS_PAR_ETAPE = 2;
  const MAX_PHOTO_OCTETS = 2 * 1024 * 1024;
  const TYPES_IMAGE = new Set(["image/jpeg", "image/png", "image/webp"]);

  /** L'agence peut-elle téléverser une photo de cette étape ? */
  function peutPhotographier({ parcel, agencyId, etape }) {
    const owner = parcel.ownerId === agencyId;
    const destination = parcel.destinationAgencyId === agencyId;
    if (etape === "prise_en_charge") return owner;
    return destination || (owner && parcel.destinationAgencyId === null);
  }

  function photoMetadonnees(row) {
    return {
      id: row.id,
      parcelId: row.parcel_id,
      etape: row.etape,
      contentType: row.content_type,
      sizeBytes: row.size_bytes,
      agencyName: row.agency_name ?? "",
      agentName: row.agent_name ?? "",
      createdAtISO: row.created_at_iso
    };
  }

  app.get("/api/colis/:id/photos", requireAgency, async (req, res) => {
    const row = await findParcelForAgency(req.params.id, req.agency.id);
    if (!row) return res.status(404).json({ error: "Ce colis est introuvable ou vous n'y avez pas accès." });
    const { rows } = await query(
      `SELECT ph.*, a.name AS agency_name
       FROM photos ph JOIN agencies a ON a.id = ph.agency_id
       WHERE ph.parcel_id = $1 ORDER BY ph.created_at_iso`,
      [row.id]
    );
    res.json({ photos: rows.map(photoMetadonnees), backend: backendPhotos() });
  });

  app.post("/api/colis/:id/photos", requireAgency, async (req, res) => {
    const row = await findParcelForAgency(req.params.id, req.agency.id);
    if (!row) return res.status(404).json({ error: "Ce colis est introuvable ou vous n'y avez pas accès." });
    const parcel = toParcel(row);

    const etape = textePropre(req.body?.etape);
    if (!ETAPES_PHOTO.includes(etape)) {
      return res.status(400).json({ error: "L'étape de la photo est invalide (prise en charge ou arrivée)." });
    }
    if (!peutPhotographier({ parcel, agencyId: req.agency.id, etape })) {
      return res.status(403).json({ error: "Cette photo doit être téléversée par l'agence concernée par l'étape." });
    }

    const image = String(req.body?.image ?? "");
    const match = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(image);
    if (!match) {
      return res.status(400).json({ error: "Fournissez une image valide au format data:image/…;base64 (compressez-la côté navigateur)." });
    }
    const contentType = match[1].toLowerCase();
    if (!TYPES_IMAGE.has(contentType)) {
      return res.status(400).json({ error: "Seules les images JPEG, PNG ou WebP sont acceptées." });
    }
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length) {
      return res.status(400).json({ error: "L'image fournie est vide." });
    }
    if (buffer.length > MAX_PHOTO_OCTETS) {
      return res.status(400).json({ error: "L'image dépasse 2 Mo : compressez-la avant l'envoi (200 Ko suffisent)." });
    }

    const { rows: existantes } = await query(
      "SELECT count(*)::int AS n FROM photos WHERE parcel_id = $1 AND etape = $2",
      [parcel.id, etape]
    );
    if (existantes[0].n >= MAX_PHOTOS_PAR_ETAPE) {
      return res.status(400).json({ error: `Maximum ${MAX_PHOTOS_PAR_ETAPE} photos par étape : les photos sont une preuve, jamais supprimables.` });
    }

    const extension = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
    const key = `colis/${parcel.id}/${etape}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${extension}`;
    try {
      await stockerObjet({ key, buffer, contentType });
    } catch {
      return res.status(502).json({ error: "Le stockage des photos est momentanément indisponible. Réessayez." });
    }
    const id = crypto.randomUUID();
    const nowISO = new Date().toISOString();
    await query(
      `INSERT INTO photos (id, parcel_id, etape, storage_key, content_type, size_bytes, agency_id, agent_id, agent_name, created_at_iso)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, parcel.id, etape, key, contentType, buffer.length, req.agency.id, req.member.id, req.member.name, nowISO]
    );
    const { rows } = await query(
      `SELECT ph.*, a.name AS agency_name FROM photos ph JOIN agencies a ON a.id = ph.agency_id WHERE ph.id = $1`,
      [id]
    );
    res.status(201).json({ photo: photoMetadonnees(rows[0]) });
  });

  app.get("/api/photos/:id", requireAgency, async (req, res) => {
    const { rows } = await query("SELECT * FROM photos WHERE id = $1", [String(req.params.id ?? "")]);
    const photo = rows[0];
    if (!photo) return res.status(404).json({ error: "Cette photo est introuvable." });
    const parcelRow = await findParcelForAgency(photo.parcel_id, req.agency.id);
    if (!parcelRow) return res.status(404).json({ error: "Cette photo est introuvable." });
    const objet = await lireObjet(photo.storage_key);
    if (!objet) return res.status(404).json({ error: "Le contenu de cette photo est momentanément indisponible." });
    res.setHeader("Content-Type", objet.contentType || photo.content_type);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(objet.buffer);
  });

  /* --------------------- souffrance + retour (LOT 4) ------------------------ */

  app.get("/api/souffrance", requireAgency, async (req, res) => {
    const { rows } = await query(
      "SELECT * FROM parcels WHERE owner_id = $1 OR destination_agency_id = $1 ORDER BY created_at DESC",
      [req.agency.id]
    );
    const now = new Date();
    const souffrance = rows
      .map(toParcel)
      .filter((parcel) => parcel.status === "Arrivé à l'agence de destination" && parcel.retourStatus !== "termine")
      .filter((parcel) => estEnSouffrance(parcel, now))
      .map((parcel) => {
        const sender = parcel.sender || {};
        const recipient = parcel.recipient || {};
        const arrivee = dateArriveeDestinantion(parcel) ?? parcel.updatedAtISO ?? parcel.createdAtISO;
        return {
          id: parcel.id,
          trackingCode: parcel.trackingCode,
          status: parcel.status,
          originCity: parcel.originCity,
          destinationCity: parcel.destinationCity,
          senderName: textePropre(`${sender.firstName || ""} ${sender.lastName || ""}`),
          senderPhone: sender.phone || "",
          recipientName: textePropre(`${recipient.firstName || ""} ${recipient.lastName || ""}`),
          recipientPhone: recipient.phone || "",
          priceFCFA: parcel.priceFCFA,
          paidAmountFCFA: parcel.paidAmountFCFA ?? 0,
          arriveeISO: arrivee,
          jours: joursDepuis(arrivee, now),
          retourStatus: parcel.retourStatus ?? null
        };
      })
      .sort((a, b) => b.jours - a.jours);
    res.json({ souffrance });
  });

  app.post("/api/colis/:id/retour", requireAgency, async (req, res) => {
    const row = await findParcelForAgency(req.params.id, req.agency.id);
    if (!row) return res.status(404).json({ error: "Ce colis est introuvable ou vous n'y avez pas accès." });
    const parcel = toParcel(row);
    const etape = textePropre(req.body?.etape) || "decider";
    const nowISO = new Date().toISOString();

    if (etape === "decider") {
      // Décision de retour : l'agence qui détient le colis (destination
      // rattachée, sinon l'expéditrice — même logique que la progression).
      const detenteur = parcel.destinationAgencyId ?? parcel.ownerId;
      if (detenteur !== req.agency.id) {
        return res.status(403).json({ error: "Le retour à l'expéditeur est décidé par l'agence qui détient le colis." });
      }
      if (parcel.status !== "Arrivé à l'agence de destination") {
        return res.status(400).json({ error: "Seul un colis arrivé et non retiré peut être retourné à l'expéditeur." });
      }
      if (parcel.retourStatus) {
        return res.status(409).json({ error: parcel.retourStatus === "en_cours" ? "Un retour à l'expéditeur est déjà en cours pour ce colis." : "Ce colis a déjà été retourné à l'expéditeur." });
      }

      // Frais de magasinage éventuels : encaissés dans la caisse de l'agence
      // qui détient le colis (l'impayé ne bloque jamais le colis lui-même).
      const frais = Math.round(Number(req.body?.fraisMagasinageFCFA ?? 0));
      if (frais > 0) {
        const mode = textePropre(req.body?.mode);
        if (!estModeEncaissement(mode)) {
          return res.status(400).json({ error: "Choisissez le mode de paiement des frais de magasinage : espèces ou mobile money." });
        }
        await query(
          `INSERT INTO encaissements (id, parcel_id, agency_id, agent_id, agent_name, amount_fcfa, mode, date_key, label, created_at_iso)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Frais de magasinage', $9)`,
          [crypto.randomUUID(), parcel.id, req.agency.id, req.member.id, req.member.name, frais, mode, jourCle(), nowISO]
        );
      }

      const arrivee = dateArriveeDestinantion(parcel) ?? parcel.createdAtISO;
      await ajouterEtapeColis(row, {
        status: "Retour à l'expéditeur décidé",
        date: nowISO,
        agencyName: req.agency.name,
        city: req.agency.city,
        note: `Colis non retiré depuis le ${new Date(arrivee).toLocaleDateString("fr-FR")}${frais > 0 ? ` — frais de magasinage : ${frais} FCFA` : ""}`,
        actorId: req.member.id,
        actorName: req.member.name
      });
      await query(
        "UPDATE parcels SET retour_status = 'en_cours', retour_started_at = $1, updated_at = now() WHERE id = $2",
        [nowISO, parcel.id]
      );
    } else if (etape === "recevoir") {
      // Réception du retour : l'agence expéditrice récupère le colis et le
      // remet à son client (nouveau trajet tracé dans l'historique).
      if (parcel.ownerId !== req.agency.id) {
        return res.status(403).json({ error: "La réception du retour est confirmée par l'agence expéditrice." });
      }
      if (parcel.retourStatus !== "en_cours") {
        return res.status(400).json({ error: "Aucun retour à l'expéditeur n'est en cours pour ce colis." });
      }
      await ajouterEtapeColis(row, {
        status: "Colis retourné à l'expéditeur",
        date: nowISO,
        agencyName: req.agency.name,
        city: req.agency.city,
        note: textePropre(req.body?.note) || "Le colis est revenu à l'agence expéditrice.",
        actorId: req.member.id,
        actorName: req.member.name
      });
      await query(
        "UPDATE parcels SET retour_status = 'termine', retour_completed_at = $1, updated_at = now() WHERE id = $2",
        [nowISO, parcel.id]
      );
    } else {
      return res.status(400).json({ error: "L'étape du retour est invalide (decider ou recevoir)." });
    }

    const { rows: maj } = await query("SELECT * FROM parcels WHERE id = $1", [parcel.id]);
    const parcelMaj = toParcel(maj[0]);
    // LOT 5 — décision et réception du retour notifiées aux deux agences.
    await notifier({ type: etape === "decider" ? "retour_decide" : "retour_recu", parcel: parcelMaj });
    res.json({ parcel: parcelMaj });
  });

  /* --------------------- alertes « colis qui dorment » ---------------------- */

  app.get("/api/alertes", requireAgency, async (req, res) => {
    const { rows } = await query(
      "SELECT * FROM parcels WHERE owner_id = $1 OR destination_agency_id = $1",
      [req.agency.id]
    );
    const parcels = rows.map(toParcel);
    const groupes = alertesParSignal(parcels, new Date());
    // LOT 5 — le tableau de bord (rafraîchi toutes les 20 s) déclenche aussi
    // le balayage des échéances : chaque alerte devient UNE notification par
    // épisode et par agence concernée (idempotent, jamais bloquant).
    await balayerEcheances({ agencyId: req.agency.id, parcels });
    res.json({
      alertes: groupes,
      total: Object.values(groupes).reduce((somme, liste) => somme + liste.length, 0),
      // Compteur des notifications non lues : le badge suit le balayage sans requête de plus.
      notificationsNonLues: await compterNonLues(req.agency.id)
    });
  });

  /* ----------------------- notifications (LOT 5) ---------------------------- */

  // Journal des notifications de l'agence (destinataire) : lecture par tout
  // membre, cloisonnement strict par agence, aucune suppression (on marque
  // « lu »). Mode simulation par défaut : rien ne sort de l'application tant
  // qu'aucun transport réel n'est branché et configuré (lib/notifications.js).

  /* ------------------ LOT 10 — résumé léger temps réel ---------------------- */

  // Compteur de colis du mois (expéditeur uniquement) + notifications non
  // lues : UNE requête légère par page, sans balayage des échéances.
  async function resumeCompteur(agencyId) {
    const etat = await etatFacturation(agencyId);
    return {
      plan: etat.plan,
      periode: etat.periode.cle,
      compteur: etat.periode.compteur,
      quotaEffectif: etat.periode.quotaEffectif,
      depassements: etat.periode.depassements,
      enRetard: etat.periode.abonnement.enRetard,
      soldeFCFA: etat.portefeuille.soldeFCFA,
      ...etat.resume
    };
  }

  app.get("/api/resume", requireAgency, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const [compteur, nonLues] = await Promise.all([resumeCompteur(req.agency.id), compterNonLues(req.agency.id)]);
    res.json({ compteur, nonLues, horodatageISO: new Date().toISOString() });
  });

  app.get("/api/notifications", requireAgency, async (req, res) => {
    // Compteur seul (badge de la barre latérale, chaque page) : léger, sans balayage.
    if (req.query?.resume === "1") {
      return res.json({ nonLues: await compterNonLues(req.agency.id) });
    }
    const { rows: parcelRows } = await query(
      "SELECT * FROM parcels WHERE owner_id = $1 OR destination_agency_id = $1",
      [req.agency.id]
    );
    await balayerEcheances({ agencyId: req.agency.id, parcels: parcelRows.map(toParcel) });
    const { rows } = await query(
      "SELECT * FROM notifications WHERE agency_id = $1 ORDER BY created_at DESC, id LIMIT 300",
      [req.agency.id]
    );
    const configuration = configurationNotifications();
    res.json({
      notifications: rows.map(normaliserNotification),
      nonLues: await compterNonLues(req.agency.id),
      configuration: {
        canal: configuration.canal,
        simulation: configuration.simulation,
        raison: configuration.raison
      }
    });
  });

  app.post("/api/notifications/lecture", requireAgency, async (req, res) => {
    const brut = req.body?.ids;
    if (brut !== undefined && !Array.isArray(brut)) {
      return res.status(400).json({ error: "La liste des notifications à marquer comme lues est invalide." });
    }
    const ids = Array.isArray(brut) ? [...new Set(brut.map((id) => textePropre(id)).filter(Boolean))] : [];
    if (ids.length > 500) {
      return res.status(400).json({ error: "500 notifications au maximum par demande." });
    }
    if (ids.length) {
      const placeholders = ids.map((_, index) => `$${index + 2}`).join(", ");
      await query(
        `UPDATE notifications SET lu = TRUE WHERE agency_id = $1 AND id IN (${placeholders})`,
        [req.agency.id, ...ids]
      );
    } else if (req.body?.toutes === true) {
      await query("UPDATE notifications SET lu = TRUE WHERE agency_id = $1 AND lu = FALSE", [req.agency.id]);
    } else {
      return res.status(400).json({ error: "Indiquez les notifications à marquer comme lues, ou « toutes »." });
    }
    res.json({ nonLues: await compterNonLues(req.agency.id) });
  });

  /* ------------------ abonnement et portefeuille (LOT 6) --------------------- */

  // Lecture par tout membre (un agent doit comprendre un refus de création) ;
  // changements réservés au gérant (garde serveur). Aucune suppression : le
  // journal du portefeuille est immuable.
  app.get("/api/facturation", requireAgency, async (req, res) => {
    if (req.query?.resume === "1") {
      return res.json({ resume: await resumeCompteur(req.agency.id) });
    }
    const etat = await etatFacturation(req.agency.id);
    res.json({ facturation: { ...etat, plans: PLANS, peutModifier: req.member.role === "gerant" } });
  });

  function requireGerantFacturation(req, res, next) {
    if (req.member?.role !== "gerant") {
      return res.status(403).json({ error: "Seul le gérant de l'agence peut gérer l'abonnement et le portefeuille." });
    }
    next();
  }

  app.post("/api/facturation/plan", requireAgency, requireGerantFacturation, async (req, res) => {
    const resultat = await changerPlanGerant({ agencyId: req.agency.id, planDemande: textePropre(req.body?.plan) });
    if (resultat.error) return res.status(400).json({ error: resultat.error });
    res.json({ effet: resultat.effet, facturation: await etatFacturation(req.agency.id) });
  });

  app.post("/api/facturation/abonnement", requireAgency, requireGerantFacturation, async (req, res) => {
    const ligne = await ouvrirPeriode(req.agency.id);
    const periode = normaliserPeriode(ligne);
    if (periode.abonnement.statut !== "du") {
      return res.status(400).json({ error: "Aucun abonnement n'est à régler pour ce mois-ci." });
    }
    if (!(await reglerAbonnement(req.agency.id, ligne.periode))) {
      const { portefeuille } = await etatFacturation(req.agency.id);
      const manque = periode.abonnement.montantFCFA - portefeuille.soldeFCFA;
      return res.status(402).json({
        error: `Solde insuffisant : il manque ${Math.max(0, manque)} FCFA pour régler l'abonnement (${periode.abonnement.montantFCFA} FCFA). Rechargez le portefeuille.`
      });
    }
    res.json({ facturation: await etatFacturation(req.agency.id) });
  });

  /* ----------------------- suivi personnalisé (LOT 7) ------------------------ */

  function projectionMarque(agency) {
    return {
      active: agency.marque_active === true,
      nom: agency.marque_nom || agency.name,
      couleur: agency.marque_couleur || null,
      couleur2: agency.marque_couleur_2 || null,
      logo: Boolean(agency.marque_logo_cle),
      majISO: agency.marque_maj_iso || null
    };
  }

  // Lecture par tout membre (aperçu) ; modification réservée au gérant.
  app.get("/api/marque", requireAgency, async (req, res) => {
    if (req.query?.logo === "1") {
      if (!req.agency.marque_logo_cle) return res.status(404).json({ error: "Aucun logo enregistré." });
      const objet = await lireObjet(req.agency.marque_logo_cle);
      if (!objet) return res.status(404).json({ error: "Aucun logo enregistré." });
      res.setHeader("Content-Type", req.agency.marque_logo_type || objet.contentType);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.send(objet.buffer);
    }
    const { rows } = await query("SELECT tracking_code FROM parcels WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1", [req.agency.id]);
    res.json({ marque: projectionMarque(req.agency), apercuCode: rows[0]?.tracking_code ?? null, peutModifier: req.member.role === "gerant" });
  });

  app.put("/api/marque", requireAgency, async (req, res) => {
    if (req.member?.role !== "gerant") {
      return res.status(403).json({ error: "Seul le gérant de l'agence peut personnaliser le suivi." });
    }
    const controle = validerMarque(req.body || {}, { nomAgence: req.agency.name });
    if (controle.error) return res.status(400).json({ error: controle.error });
    let logoCle = req.agency.marque_logo_cle || null;
    let logoType = req.agency.marque_logo_type || null;
    const logo = req.body?.logo;
    if (logo === null) {
      logoCle = null;
      logoType = null;
    } else if (logo !== undefined) {
      const donnees = String(logo?.donnees ?? "");
      if (!/^[A-Za-z0-9+/=\s]+$/.test(donnees)) return res.status(400).json({ error: "Le fichier du logo est illisible." });
      const octets = Buffer.from(donnees, "base64");
      const verifie = validerLogo({ type: String(logo?.type ?? ""), octets });
      if (verifie.error) return res.status(400).json({ error: verifie.error });
      const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[verifie.valeur.type];
      logoCle = await stockerObjet({
        key: `marques/${req.agency.id}/logo-${Date.now()}.${extension}`,
        buffer: octets,
        contentType: verifie.valeur.type
      });
      logoType = verifie.valeur.type;
    }
    const { valeur } = controle;
    await query(
      `UPDATE agencies SET marque_active = $2, marque_nom = $3, marque_couleur = $4, marque_couleur_2 = $5,
         marque_logo_cle = $6, marque_logo_type = $7, marque_maj_iso = $8 WHERE id = $1`,
      [req.agency.id, valeur.active, valeur.nom, valeur.couleur, valeur.couleur2, logoCle, logoType, new Date().toISOString()]
    );
    res.json({ marque: projectionMarque(await findAgency(req.agency.id)) });
  });

  /* ------------------------ paiements en ligne (LOT 7) ------------------------ */

  // SasPay (paiement hébergé) derrière lib/paiements.js : simulation sans clé,
  // test avec sk_test_, réel avec sk_live_. Aucun effet sans vérification
  // serveur ; aucune donnée client transmise ; aucune suppression.
  function urlPublique(req, { ignorerAppUrl = false } = {}) {
    const configuree = String(process.env.APP_URL ?? "").trim().replace(/\/+$/, "");
    if (!ignorerAppUrl && /^https?:\/\/[^\s/]+/.test(configuree)) return configuree;
    const hote = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
    if (!/^[A-Za-z0-9.:-]+$/.test(hote)) return "";
    const protocole = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
    return `${protocole === "http" ? "http" : "https"}://${hote}`;
  }

  async function paiementDeLAgence(id, agencyId) {
    const { rows } = await query("SELECT * FROM paiements_en_ligne WHERE id = $1 AND agency_id = $2", [textePropre(id), agencyId]);
    return rows[0] || null;
  }

  function erreurPaiement(res, error) {
    if (error instanceof ErreurPaiement) return res.status(error.status).json({ error: error.message });
    throw error;
  }

  app.get("/api/paiements", requireAgency, async (req, res) => {
    const configuration = configurationPaiements();
    const publique = { mode: configuration.mode, actif: configuration.actif, raison: configuration.raison };
    if (req.query?.id) {
      const paiement = await paiementDeLAgence(req.query.id, req.agency.id);
      if (!paiement) return res.status(404).json({ error: "Ce paiement est introuvable." });
      return res.json({ paiement: projectionPaiement(paiement), configuration: publique });
    }
    const filtreColis = textePropre(req.query?.parcelId);
    const { rows } = await query(
      `SELECT * FROM paiements_en_ligne WHERE agency_id = $1 AND ($2 = '' OR parcel_id = $2)
       ORDER BY created_at DESC LIMIT 50`,
      [req.agency.id, filtreColis]
    );
    res.json({ paiements: rows.map(projectionPaiement), configuration: publique });
  });

  // LOT 8 — Shopin30 n'encaisse jamais l'argent des colis : l'objet « colis »
  // est refusé (403, règle métier) ; seuls l'abonnement et les recharges du
  // portefeuille se paient en ligne, par le gérant.
  app.post("/api/paiements", requireAgency, async (req, res) => {
    const controle = validerDemandePaiement(req.body || {});
    if (controle.error) return res.status(controle.status ?? 400).json({ error: controle.error });
    const demande = controle.valeur;
    if (req.member.role !== "gerant") {
      return res.status(403).json({ error: "Seul le gérant de l'agence peut payer l'abonnement ou recharger le portefeuille." });
    }
    try {
      const paiement = await creerPaiement({ demande, agency: req.agency, member: req.member, baseUrl: urlPublique(req) });
      res.status(201).json({ paiement: projectionPaiement(paiement) });
    } catch (error) {
      erreurPaiement(res, error);
    }
  });

  app.post("/api/paiements/verifier", requireAgency, async (req, res) => {
    const paiement = await paiementDeLAgence(req.body?.id, req.agency.id);
    if (!paiement) return res.status(404).json({ error: "Ce paiement est introuvable." });
    try {
      res.json({ paiement: projectionPaiement(await confirmerPaiement(paiement)) });
    } catch (error) {
      erreurPaiement(res, error);
    }
  });

  // Page de paiement SIMULÉE : refusée dès qu'une clé SasPay est configurée.
  app.post("/api/paiements/simulation", requireAgency, async (req, res) => {
    if (configurationPaiements().mode !== "simulation") {
      return res.status(409).json({ error: "Le mode simulation est désactivé : une clé SasPay est configurée." });
    }
    const paiement = await paiementDeLAgence(req.body?.id, req.agency.id);
    if (!paiement || paiement.mode !== "simulation") return res.status(404).json({ error: "Ce paiement simulé est introuvable." });
    const resultat = textePropre(req.body?.resultat);
    if (!["succes", "echec"].includes(resultat)) {
      return res.status(400).json({ error: "Résultat de simulation invalide (succes ou echec)." });
    }
    if (["en_attente", "echec"].includes(paiement.statut)) {
      await query("UPDATE paiements_en_ligne SET simulation_statut = $2, updated_at = now() WHERE id = $1", [
        paiement.id, resultat === "succes" ? "PAID" : "FAILED"
      ]);
    }
    const { rows } = await query("SELECT * FROM paiements_en_ligne WHERE id = $1", [paiement.id]);
    res.json({ paiement: projectionPaiement(await confirmerPaiement(rows[0])) });
  });

  // Webhook SasPay (public) : signature HMAC vérifiée sur le corps brut, puis
  // simple déclenchement de la vérification serveur des paiements concernés.
  app.post("/api/paiements/webhook", async (req, res) => {
    const secret = String(process.env.SASPAY_WEBHOOK_SECRET ?? "").trim();
    const verifie = verifierSignatureWebhook({
      corpsBrut: req.corpsBrut,
      signature: req.get("x-webhook-signature"),
      horodatage: req.get("x-webhook-timestamp"),
      secret
    });
    if (!verifie.ok) {
      return res.status(secret ? 403 : 503).json({ error: secret ? "Signature du webhook invalide." : "Webhook non configuré." });
    }
    const evenement = String(req.body?.event ?? req.get("x-webhook-event") ?? "");
    const resultat = await traiterWebhook({ evenement, donnees: req.body?.data ?? {} });
    res.json({ recu: true, ...resultat });
  });

  /* ---------------------- console plateforme (LOT 6) ------------------------- */

  // Compte SÉPARÉ des agences : table plateforme_admins, cookie ce_plateforme
  // signé dans un domaine distinct. Une session d'agence n'ouvre jamais la
  // console, une session plateforme n'ouvre aucune route d'agence.
  let hashFactice = null;
  async function requirePlateforme(req, res, next) {
    const charge = getPlatformCharge(req);
    const refus = () => res.status(401).json({ error: "Session de la console plateforme expirée. Reconnectez-vous." });
    if (!charge) return refus();
    const { rows } = await query("SELECT id, email, name, active FROM plateforme_admins WHERE id = $1", [charge.plateforme]);
    const admin = rows[0];
    if (!admin || admin.active !== true) {
      clearPlatformCookie(res);
      return refus();
    }
    req.admin = { id: admin.id, email: admin.email, name: admin.name };
    next();
  }

  app.post("/api/plateforme/connexion", async (req, res) => {
    verifierSecretSession();
    const mail = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    const { rows } = await query("SELECT * FROM plateforme_admins WHERE email = $1", [mail]);
    const admin = rows[0];
    // Compte inconnu : vérification factice pour un temps de réponse comparable.
    if (!admin) verifyPassword(password, (hashFactice ??= hashPassword(crypto.randomUUID())));
    if (!admin || !verifyPassword(password, admin.password_hash) || admin.active !== true) {
      return res.status(401).json({ error: "Identifiants de la console plateforme incorrects." });
    }
    setPlatformCookie(res, createPlatformToken(admin.id));
    res.json({ admin: { id: admin.id, email: admin.email, name: admin.name } });
  });

  app.post("/api/plateforme/deconnexion", (req, res) => {
    clearPlatformCookie(res);
    res.json({ ok: true });
  });

  // LOT 8 — amorçage du premier administrateur (sans terminal). Public mais
  // inerte dès qu'un administrateur existe ; jeton comparé en temps constant
  // (lib/plateforme.js) ; tentatives limitées par adresse.
  const tentativesAmorcage = new Map();
  function amorcageBloque(req) {
    const cle = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    const maintenant = Date.now();
    const entree = tentativesAmorcage.get(cle) ?? { n: 0, depuis: maintenant };
    if (maintenant - entree.depuis > 15 * 60 * 1000) Object.assign(entree, { n: 0, depuis: maintenant });
    tentativesAmorcage.set(cle, entree);
    return entree;
  }

  app.get("/api/plateforme/amorcage", async (req, res) => {
    verifierSecretSession();
    res.setHeader("Cache-Control", "no-store");
    res.json(await etatAmorcage());
  });

  app.post("/api/plateforme/amorcage", async (req, res) => {
    verifierSecretSession();
    const compteur = amorcageBloque(req);
    if (compteur.n >= 5) return res.status(429).json({ error: "Trop de tentatives : réessayez dans 15 minutes." });
    const resultat = await creerPremierAdmin(req.body || {});
    if (resultat.error) {
      if (resultat.status === 403) compteur.n += 1;
      return res.status(resultat.status).json({ error: resultat.error });
    }
    setPlatformCookie(res, createPlatformToken(resultat.admin.id));
    res.status(201).json({ admin: resultat.admin, aFaire: "Supprimez maintenant la variable PLATEFORME_PREMIER_ADMIN_JETON dans Vercel, puis redéployez." });
  });

  app.get("/api/plateforme", requirePlateforme, async (req, res) => {
    res.json({ admin: req.admin, ...(await vuePlateforme()) });
  });

  // LOT 9 — panneau « Mise en service » : lecture seule, jamais de valeur de secret.
  app.get("/api/plateforme/mise-en-service", requirePlateforme, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await diagnosticMiseEnService({ hoteRequete: urlPublique(req, { ignorerAppUrl: true }) }));
  });

  async function agenceCiblee(req, res) {
    const agence = await findAgency(textePropre(req.body?.agencyId));
    if (!agence) res.status(404).json({ error: "Cette agence est introuvable." });
    return agence;
  }

  app.post("/api/plateforme/plan", requirePlateforme, async (req, res) => {
    const agence = await agenceCiblee(req, res);
    if (!agence) return;
    const controle = validerPlanPlateforme(req.body || {});
    if (controle.error) return res.status(400).json({ error: controle.error });
    await changerPlanPlateforme({ agencyId: agence.id, valeur: controle.valeur });
    res.json({ facturation: await etatFacturation(agence.id) });
  });

  app.post("/api/plateforme/credit", requirePlateforme, async (req, res) => {
    const agence = await agenceCiblee(req, res);
    if (!agence) return;
    const controle = validerRecharge(req.body || {});
    if (controle.error) return res.status(400).json({ error: controle.error });
    const resultat = await rechargerPortefeuille({
      agencyId: agence.id,
      montantFCFA: controle.valeur.montantFCFA,
      reference: controle.valeur.reference,
      acteurNom: req.admin.name
    });
    res.status(201).json({ ...resultat, facturation: await etatFacturation(agence.id) });
  });

  /* --------------------------- devis public (LOT 3) ------------------------ */

  // Estimateur anonyme de la page d'accueil : aucune donnée personnelle
  // demandée (ville départ, ville arrivée, poids, nature facultative), aucune
  // session. Les prix viennent des grilles ACTIVES des agences qui couvrent
  // l'axe ; chaque offre propose le contact WhatsApp de l'agence concernée.
  app.post("/api/devis", async (req, res) => {
    const originCity = textePropre(req.body?.originCity);
    const destinationCity = textePropre(req.body?.destinationCity);
    const weightKg = Number(req.body?.weightKg);
    const packageNature = textePropre(req.body?.packageNature);
    if (!dansLimite(originCity, VILLE) || !dansLimite(destinationCity, VILLE)) {
      return res.status(400).json({ error: "Indiquez les villes de départ et de destination (2 à 60 caractères)." });
    }
    if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg > 1000) {
      return res.status(400).json({ error: "Le poids doit être compris entre 0 et 1000 kg." });
    }
    if (packageNature.length > 120) {
      return res.status(400).json({ error: "La nature du colis ne doit pas dépasser 120 caractères." });
    }

    const { rows } = await query(
      `SELECT t.origin_city, t.destination_city, t.weight_min_kg, t.weight_max_kg,
              t.price_fcfa, t.active, t.created_at_iso,
              a.name AS agency_name, a.city AS agency_city, a.phone AS agency_phone
       FROM tarifs t
       JOIN agencies a ON a.id = t.agency_id
       WHERE t.active = TRUE`
    );
    const tarifs = rows.map((row) => ({
      ...normaliserTarif(row),
      agence: { name: row.agency_name, city: row.agency_city, phone: row.agency_phone }
    }));
    const offres = estimerDevis({ tarifs, originCity, destinationCity, weightKg });
    res.json({
      devis: {
        originCity,
        destinationCity,
        weightKg,
        ...(packageNature ? { packageNature } : {}),
        offres
      }
    });
  });

  /* --------------------------- suivi public ------------------------------ */

  app.get("/api/suivi/:code", async (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase();
    const { rows } = await query(
      "SELECT id, tracking_code, status, history, origin_city, destination_city, updated_at FROM parcels WHERE tracking_code = $1",
      [code]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Aucun colis ne correspond à ce code. Vérifiez les caractères saisis." });
    // LOT 4 — incident en cours : bandeau sobre et fixe, jamais de détail
    // (type, note, agence) côté public.
    const { rows: incidentRows } = await query("SELECT state FROM incidents WHERE parcel_id = $1", [row.id]);
    const notice = bandeauPublicIncident(incidentRows);
    // LOT 7 — habillage de l'agence expéditrice, s'il est activé : identité
    // commerciale seulement (nom affiché, couleurs, logo), jamais de contact.
    const { rows: marqueRows } = await query(
      `SELECT a.name, a.marque_active, a.marque_nom, a.marque_couleur, a.marque_couleur_2, a.marque_logo_cle, a.marque_maj_iso
       FROM parcels p JOIN agencies a ON a.id = p.owner_id WHERE p.id = $1`,
      [row.id]
    );
    const marque = marquePublique(marqueRows[0]);
    res.json({
      tracking: {
        code: row.tracking_code,
        status: row.status,
        // Projection stricte (etapePublique, partagée client/serveur) : l'identité
        // de l'agent acteur (actorId/actorName) reste privée — le suivi public
        // n'expose aucune donnée personnelle.
        history: json(row.history, []).map(etapePublique),
        originCity: row.origin_city,
        destinationCity: row.destination_city,
        lastUpdatedAtISO: new Date(row.updated_at).toISOString(),
        ...(notice ? { notice } : {}),
        ...(marque ? { marque } : {})
      }
    });
  });

  // Logo public de l'agence expéditrice (suivi personnalisé) : servi seulement
  // si la personnalisation est active ; la clé de stockage reste interne.
  app.get("/api/suivi/:code/logo", async (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase();
    const { rows } = await query(
      `SELECT a.marque_active, a.marque_logo_cle, a.marque_logo_type
       FROM parcels p JOIN agencies a ON a.id = p.owner_id WHERE p.tracking_code = $1`,
      [code]
    );
    const agence = rows[0];
    if (!agence || agence.marque_active !== true || !agence.marque_logo_cle) {
      return res.status(404).json({ error: "Aucun logo pour ce suivi." });
    }
    const objet = await lireObjet(agence.marque_logo_cle);
    if (!objet) return res.status(404).json({ error: "Aucun logo pour ce suivi." });
    res.setHeader("Content-Type", agence.marque_logo_type || objet.contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.send(objet.buffer);
  });

  app.use("/api", (req, res) => {
    res.status(404).json({ error: "Ressource introuvable." });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    // LOT 8 — SESSION_SECRET absente ou trop courte sur une vraie base :
    // refus clair (503), sans jamais retomber sur le secret de démonstration.
    if (error instanceof ErreurConfigurationSession) {
      console.error(`[API] configuration : ${error.message}`);
      return res.status(503).json({ error: error.message, code: error.code });
    }
    console.error("[API]", error);
    const message = /DATABASE_URL/.test(String(error?.message))
      ? error.message
      : "Le service est momentanément indisponible. Réessayez.";
    res.status(500).json({ error: message });
  });

  return app;
}

export default buildApp();
