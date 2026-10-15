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

import { query } from "../db/db.js";
import {
  clearSessionCookie,
  createSessionToken,
  getSessionCharge,
  hashPassword,
  setSessionCookie,
  verifyPassword
} from "./auth.js";
import {
  changementsRattachement,
  construireColis,
  etapePublique,
  peutRattacher,
  prochaineEtape,
  resoudreDestination,
  textePropre,
  validerColis
} from "../js/metier-colis.js";
import { isValidCni, isValidIvorianPhone, normalizeIvorianPhone } from "../js/utils.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOM_AGENCE = [2, 120];
const VILLE = [2, 60];

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
    createdAtISO: row.created_at_iso
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
  app.use(express.json({ limit: "256kb" }));

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

  /* -------------------------------- colis -------------------------------- */

  app.get("/api/colis", requireAgency, async (req, res) => {
    const { rows } = await query(
      "SELECT * FROM parcels WHERE owner_id = $1 OR destination_agency_id = $1 ORDER BY created_at DESC",
      [req.agency.id]
    );
    res.json({ parcels: rows.map(toParcel) });
  });

  app.post("/api/colis", requireAgency, async (req, res) => {
    const values = req.body?.values || {};
    const agencyNotRegistered = req.body?.agencyNotRegistered === true;

    const message = validerColis({ values, agencyNotRegistered });
    if (message) return res.status(400).json({ error: message });

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

    try {
      await query(
        `INSERT INTO parcels (id, tracking_code, owner_id, owner_agency_name, owner_agency_city,
          destination_agency_id, destination_agency_name, destination_agency_city,
          unregistered_destination_agency, sender, recipient, package_nature, weight_kg, price_fcfa,
          origin_city, destination_city, status, history, created_at_iso)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          p.id, p.trackingCode, p.ownerId, p.ownerAgencyName, p.ownerAgencyCity,
          p.destinationAgencyId, p.destinationAgencyName, p.destinationAgencyCity,
          p.unregisteredDestinationAgency ? JSON.stringify(p.unregisteredDestinationAgency) : null,
          JSON.stringify(p.sender), JSON.stringify(p.recipient),
          p.packageNature, p.weightKg, p.priceFCFA,
          p.originCity, p.destinationCity, p.status, JSON.stringify(p.history), p.createdAtISO
        ]
      );
    } catch (error) {
      if (/unique|duplicate/i.test(String(error?.code) + String(error?.message))) {
        return res.status(409).json({ error: "Ce code de suivi vient d'être attribué. Réessayez l'enregistrement." });
      }
      throw error;
    }
    res.status(201).json({ parcel: toParcel((await query("SELECT * FROM parcels WHERE id = $1", [p.id])).rows[0]) });
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

  /* --------------------------- suivi public ------------------------------ */

  app.get("/api/suivi/:code", async (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase();
    const { rows } = await query(
      "SELECT tracking_code, status, history, origin_city, destination_city, updated_at FROM parcels WHERE tracking_code = $1",
      [code]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Aucun colis ne correspond à ce code. Vérifiez les caractères saisis." });
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
        lastUpdatedAtISO: new Date(row.updated_at).toISOString()
      }
    });
  });

  app.use("/api", (req, res) => {
    res.status(404).json({ error: "Ressource introuvable." });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    console.error("[API]", error);
    const message = /DATABASE_URL/.test(String(error?.message))
      ? error.message
      : "Le service est momentanément indisponible. Réessayez.";
    res.status(500).json({ error: message });
  });

  return app;
}

export default buildApp();
