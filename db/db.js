/*
 * Accès à la base : Postgres (Neon) via `pg` quand DATABASE_URL est défini,
 * sinon PGlite (Postgres WASM en mémoire) pour le développement, la démo et
 * les tests — même SQL dans les deux cas.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { notificationsPourAgences } from "../js/metier-notifications.js";
import { calculerEcheance, clePeriode, libellePeriode } from "../js/metier-plans.js";
import { hashPassword } from "../lib/auth.js";
import { stockerObjet } from "../lib/photos.js";
import { logoDemoPng } from "./logo-demo.js";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(path.join(ICI, "schema.sql"), "utf8");

let driver = null;
let ready = null;

export function modeDemo() {
  return !process.env.DATABASE_URL;
}

async function creerDriver() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "0" ? undefined : { rejectUnauthorized: false },
      max: 5
    });
    return { query: (text, params) => pool.query(text, params), kind: "postgres" };
  }
  if (process.env.VERCEL) {
    // Sur Vercel, PGlite serait éphémère (données perdues à chaque instance) :
    // mieux vaut un message d'explicite qu'une démo silencieuse.
    throw new Error(
      "Base de données non configurée : ajoutez DATABASE_URL (connection string Neon) dans Vercel → Settings → Environment Variables, puis redéployez."
    );
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  return {
    query: (text, params) => db.query(text, params),
    exec: (sql) => db.exec(sql),
    kind: "pglite"
  };
}

/** Une seule initialisation (schéma + démo éventuelle) partagée par tous les appels. */
export function getDb() {
  if (!ready) {
    ready = (async () => {
      driver = await creerDriver();
      if (driver.exec) await driver.exec(SCHEMA);
      else await driver.query(SCHEMA);
      // seedDemo utilise le driver directement : passer par query() ici
      // attendrait la promesse `ready` en cours — deadlock garanti.
      if (modeDemo() && process.env.SEED_DEMO !== "0") await seedDemo(driver);
      return driver;
    })();
  }
  return ready;
}

export async function query(text, params = []) {
  const db = await getDb();
  return db.query(text, params);
}

export async function closeDb() {
  if (!ready) return;
  const db = await ready;
  if (db.kind === "postgres") await db.query("SELECT 1").catch(() => {});
  ready = null;
  driver = null;
}

/** Données de démonstration : deux agences et quelques colis, uniquement sans DATABASE_URL. */
async function seedDemo(db) {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM agencies");
  if (rows[0].n > 0) return;
  const now = new Date().toISOString();
  const hash = hashPassword("demo1234");
  await db.query(
    `INSERT INTO agencies (id, email, password_hash, name, city, phone, created_at_iso)
     VALUES ($1, $2, $3, $4, $5, $6, $7), ($8, $9, $10, $11, $12, $13, $14)`,
    [
      "demo-abidjan", "demo@colisexpress.ci", hash, "Shopin30 Abidjan", "Abidjan", "0700000001", now,
      "demo-bouake", "bouake@colisexpress.ci", hash, "Agence Bouaké Centre", "Bouaké", "0500000002", now
    ]
  );
  // LOT 1 — équipe de démonstration : deux agents actifs et un agent désactivé.
  await db.query(
    `INSERT INTO agents (id, agency_id, name, email, phone, password_hash, role, active, created_at_iso)
     VALUES ($1, $2, $3, $4, $5, $6, 'agent', TRUE, $7),
            ($8, $9, $10, $11, $12, $6, 'agent', TRUE, $7),
            ($13, $14, $15, $16, $17, $6, 'agent', FALSE, $7)`,
    [
      "demo-agent-koffi", "demo-abidjan", "Koffi N'Guessan", "koffi@colisexpress.ci", "0700000011", hash, now,
      "demo-agent-aicha", "demo-bouake", "Aïcha Touré", "aicha@colisexpress.ci", "0500000012",
      "demo-agent-yao", "demo-abidjan", "Yao Konan", "yao@colisexpress.ci", "0700000013"
    ]
  );
  // LOT 2 — grilles tarifaires de démonstration (les prix du formulaire
  // « nouveau colis » sont alors proposés en menu déroulant).
  const tarifs = [
    ["tarif-demo-1", "demo-abidjan", "Abidjan", "Bouaké", 0, 2, 2500],
    ["tarif-demo-2", "demo-abidjan", "Abidjan", "Bouaké", 2, 5, 3500],
    ["tarif-demo-3", "demo-abidjan", "Abidjan", "Bouaké", 5, 10, 5000],
    ["tarif-demo-4", "demo-abidjan", "Abidjan", "Bouaké", 10, null, 7500],
    ["tarif-demo-5", "demo-abidjan", "Abidjan", "", 0, 2, 3000],
    ["tarif-demo-6", "demo-abidjan", "Abidjan", "", 2, 5, 4200],
    ["tarif-demo-7", "demo-bouake", "Bouaké", "Abidjan", 0, 2, 2500],
    ["tarif-demo-8", "demo-bouake", "Bouaké", "Abidjan", 2, 5, 3500],
    ["tarif-demo-9", "demo-bouake", "Bouaké", "", 0, null, 4000]
  ];
  for (const [id, agency, origin, destination, min, max, prix] of tarifs) {
    await db.query(
      `INSERT INTO tarifs (id, agency_id, origin_city, destination_city, weight_min_kg, weight_max_kg, price_fcfa, active, created_at_iso)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)`,
      [id, agency, origin, destination, min, max, prix, now]
    );
  }

  // LOT 4 — dates de démonstration : des colis « qui dorment » pour montrer
  // les alertes (sans mouvement > 48 h, non rattaché > 7 j, souffrance > 7 j).
  const joursAvant = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const heuresAvant = (n) => new Date(Date.now() - n * 3600000).toISOString();
  // LOT 5 — date d'arrivée de CLI-DEMO06 : partagée par l'historique et par
  // les clés de dédoublonnage des notifications d'échéance pré-remplies.
  const arriveeDemo6 = joursAvant(12);

  const colis = [
    {
      id: "demo-colis-1", code: "CLI-DEMO01", owner: "demo-abidjan", dest: "demo-bouake",
      destName: "Agence Bouaké Centre", destCity: "Bouaké", status: "Expédié",
      payStatus: "paye", paid: 3500, cree: joursAvant(4), maj: joursAvant(3),
      history: [
        { status: "Enregistré", date: joursAvant(4), agencyName: "Shopin30 Abidjan", city: "Abidjan", actorId: "demo-agent-koffi", actorName: "Koffi N'Guessan" },
        { status: "Remis au transporteur", date: joursAvant(3), agencyName: "Shopin30 Abidjan", city: "Abidjan", note: "Bordereau BDR-DEMO01 — Gbaka Express (car Bouaké 07 h — CI-1234-AB)", actorId: "demo-agent-koffi", actorName: "Koffi N'Guessan" },
        { status: "Expédié", date: joursAvant(3), agencyName: "Shopin30 Abidjan", city: "Abidjan", actorId: "demo-agent-koffi", actorName: "Koffi N'Guessan" }
      ], unreg: null
    },
    {
      id: "demo-colis-2", code: "CLI-DEMO02", owner: "demo-abidjan", dest: null,
      destName: "Flash Korhogo", destCity: "Korhogo", status: "Enregistré",
      payStatus: "arrivee", paid: 0, cree: joursAvant(9), maj: joursAvant(9),
      history: [{ status: "Enregistré", date: joursAvant(9), agencyName: "Shopin30 Abidjan", city: "Abidjan" }],
      unreg: { name: "Flash Korhogo", city: "Korhogo", phone: "0700000009" }
    },
    {
      id: "demo-colis-3", code: "CLI-DEMO03", owner: "demo-bouake", dest: "demo-abidjan",
      destName: "Shopin30 Abidjan", destCity: "Abidjan", status: "Arrivé à l'agence de destination",
      payStatus: "arrivee", paid: 0, cree: joursAvant(10), maj: joursAvant(8),
      history: [
        { status: "Enregistré", date: joursAvant(10), agencyName: "Agence Bouaké Centre", city: "Bouaké" },
        { status: "Expédié", date: joursAvant(9), agencyName: "Agence Bouaké Centre", city: "Bouaké", actorId: "demo-agent-aicha", actorName: "Aïcha Touré" },
        { status: "En transit", date: joursAvant(9), agencyName: "Agence Bouaké Centre", city: "Bouaké", actorId: "demo-agent-aicha", actorName: "Aïcha Touré" },
        { status: "Arrivé à l'agence de destination", date: joursAvant(8), agencyName: "Shopin30 Abidjan", city: "Abidjan", note: "Contrôle d'arrivée du bordereau BDR-DEMO02", actorId: "demo-abidjan", actorName: "Shopin30 Abidjan" }
      ], unreg: null
    },
    // LOT 5 — lot BDR-DEMO03 (Abidjan → Bouaké) contrôlé hier avec un écart :
    // CLI-DEMO04 présent (arrivé), CLI-DEMO05 absent (incident « perdu »
    // automatique) — notifications « bordereau arrivé », « écart au
    // contrôle » et « incident ouvert » aux deux agences.
    {
      id: "demo-colis-4", code: "CLI-DEMO04", owner: "demo-abidjan", dest: "demo-bouake",
      destName: "Agence Bouaké Centre", destCity: "Bouaké", status: "Arrivé à l'agence de destination",
      payStatus: "paye", paid: 3500, cree: joursAvant(3), maj: heuresAvant(20),
      history: [
        { status: "Enregistré", date: joursAvant(3), agencyName: "Shopin30 Abidjan", city: "Abidjan", actorId: "demo-agent-koffi", actorName: "Koffi N'Guessan" },
        { status: "Expédié", date: joursAvant(2), agencyName: "Shopin30 Abidjan", city: "Abidjan", note: "Remis au transporteur — Bordereau BDR-DEMO03 — UTB (car Bouaké 14 h)", actorId: "demo-agent-koffi", actorName: "Koffi N'Guessan" },
        { status: "En transit", date: joursAvant(2), agencyName: "Shopin30 Abidjan", city: "Abidjan", note: "Bordereau BDR-DEMO03 en route", actorId: "demo-agent-koffi", actorName: "Koffi N'Guessan" },
        { status: "Arrivé à l'agence de destination", date: heuresAvant(20), agencyName: "Agence Bouaké Centre", city: "Bouaké", note: "Contrôle d'arrivée du bordereau BDR-DEMO03", actorId: "demo-agent-aicha", actorName: "Aïcha Touré" }
      ], unreg: null
    },
    {
      id: "demo-colis-5", code: "CLI-DEMO05", owner: "demo-abidjan", dest: "demo-bouake",
      destName: "Agence Bouaké Centre", destCity: "Bouaké", status: "En transit",
      payStatus: "arrivee", paid: 0, cree: joursAvant(3), maj: joursAvant(2),
      history: [
        { status: "Enregistré", date: joursAvant(3), agencyName: "Shopin30 Abidjan", city: "Abidjan", actorId: "demo-agent-koffi", actorName: "Koffi N'Guessan" },
        { status: "Expédié", date: joursAvant(2), agencyName: "Shopin30 Abidjan", city: "Abidjan", note: "Remis au transporteur — Bordereau BDR-DEMO03 — UTB (car Bouaké 14 h)", actorId: "demo-agent-koffi", actorName: "Koffi N'Guessan" },
        { status: "En transit", date: joursAvant(2), agencyName: "Shopin30 Abidjan", city: "Abidjan", note: "Bordereau BDR-DEMO03 en route", actorId: "demo-agent-koffi", actorName: "Koffi N'Guessan" }
      ], unreg: null
    },
    // LOT 5 — CLI-DEMO06 (Bouaké → Abidjan) non retiré depuis 12 jours : la
    // destination a décidé le retour il y a 2 jours ; Bouaké confirme la
    // réception pendant la démo (notification « retour reçu » en direct).
    {
      id: "demo-colis-6", code: "CLI-DEMO06", owner: "demo-bouake", dest: "demo-abidjan",
      destName: "Shopin30 Abidjan", destCity: "Abidjan", status: "Arrivé à l'agence de destination",
      payStatus: "paye", paid: 3500, cree: joursAvant(15), maj: joursAvant(2),
      history: [
        { status: "Enregistré", date: joursAvant(15), agencyName: "Agence Bouaké Centre", city: "Bouaké", actorId: "demo-agent-aicha", actorName: "Aïcha Touré" },
        { status: "Expédié", date: joursAvant(14), agencyName: "Agence Bouaké Centre", city: "Bouaké", actorId: "demo-agent-aicha", actorName: "Aïcha Touré" },
        { status: "En transit", date: joursAvant(14), agencyName: "Agence Bouaké Centre", city: "Bouaké", actorId: "demo-agent-aicha", actorName: "Aïcha Touré" },
        { status: "Arrivé à l'agence de destination", date: arriveeDemo6, agencyName: "Shopin30 Abidjan", city: "Abidjan", actorId: "demo-agent-koffi", actorName: "Koffi N'Guessan" },
        { status: "Retour à l'expéditeur décidé", date: joursAvant(2), agencyName: "Shopin30 Abidjan", city: "Abidjan", note: `Colis non retiré depuis le ${new Date(arriveeDemo6).toLocaleDateString("fr-FR")}`, actorId: "demo-agent-koffi", actorName: "Koffi N'Guessan" }
      ], unreg: null
    },
    // LOT 6 — CLI-DEMO07 (Abidjan → Bouaké) retiré il y a 11 jours puis
    // contesté par le destinataire : litige ouvert depuis 10 jours, donc dans
    // la file plateforme (> 7 j) de la console.
    {
      id: "demo-colis-7", code: "CLI-DEMO07", owner: "demo-abidjan", dest: "demo-bouake",
      destName: "Agence Bouaké Centre", destCity: "Bouaké", status: "Retiré",
      payStatus: "paye", paid: 3500, cree: joursAvant(14), maj: joursAvant(11),
      history: [
        { status: "Enregistré", date: joursAvant(14), agencyName: "Shopin30 Abidjan", city: "Abidjan", actorId: "demo-agent-koffi", actorName: "Koffi N'Guessan" },
        { status: "Expédié", date: joursAvant(13), agencyName: "Shopin30 Abidjan", city: "Abidjan", actorId: "demo-agent-koffi", actorName: "Koffi N'Guessan" },
        { status: "En transit", date: joursAvant(13), agencyName: "Shopin30 Abidjan", city: "Abidjan", actorId: "demo-agent-koffi", actorName: "Koffi N'Guessan" },
        { status: "Arrivé à l'agence de destination", date: joursAvant(12), agencyName: "Agence Bouaké Centre", city: "Bouaké", actorId: "demo-agent-aicha", actorName: "Aïcha Touré" },
        { status: "Retiré", date: joursAvant(11), agencyName: "Agence Bouaké Centre", city: "Bouaké", actorId: "demo-agent-aicha", actorName: "Aïcha Touré" }
      ], unreg: null
    }
  ];

  // LOT 6 — volume de démonstration : Bouaké (plan Gratuit, quota 50) a déjà
  // enregistré 48 colis ce mois-ci → 2 colis inclus restants, puis 2 colis
  // hors forfait prépayés (portefeuille 60 FCFA), puis refus de création
  // jusqu'à la recharge. Colis livrés (« Retiré ») vers une agence inscrite :
  // aucune alerte, aucun effet sur les autres démonstrations.
  const COMPTEUR_BOUAKE = 48;
  const maintenant = Date.now();
  const debutMois = new Date(Date.UTC(new Date(maintenant).getUTCFullYear(), new Date(maintenant).getUTCMonth(), 1)).getTime();
  const creeCeMois = (c) => new Date(c.cree).getTime() >= debutMois;
  const volumeBouake = COMPTEUR_BOUAKE - colis.filter((c) => c.owner === "demo-bouake" && creeCeMois(c)).length;
  const volume = [];
  for (let i = 0; i < volumeBouake; i += 1) {
    const t0 = debutMois + Math.floor(((maintenant - debutMois) * (i + 1)) / (volumeBouake + 2));
    const pas = Math.min(3 * 3600000, Math.floor((maintenant - t0) / 6));
    const date = (k) => new Date(t0 + k * pas).toISOString();
    const bouake = { agencyName: "Agence Bouaké Centre", city: "Bouaké", actorId: "demo-agent-aicha", actorName: "Aïcha Touré" };
    const abidjan = { agencyName: "Shopin30 Abidjan", city: "Abidjan", actorId: "demo-agent-koffi", actorName: "Koffi N'Guessan" };
    volume.push({
      id: `demo-volume-${i + 1}`, code: `CLI-BK${String(i + 1).padStart(4, "0")}`, owner: "demo-bouake", dest: "demo-abidjan",
      destName: "Shopin30 Abidjan", destCity: "Abidjan", status: "Retiré",
      payStatus: "paye", paid: 3500, cree: date(0), maj: date(4),
      history: [
        { status: "Enregistré", date: date(0), ...bouake },
        { status: "Expédié", date: date(1), ...bouake },
        { status: "En transit", date: date(2), ...bouake },
        { status: "Arrivé à l'agence de destination", date: date(3), ...abidjan },
        { status: "Retiré", date: date(4), ...abidjan }
      ], unreg: null
    });
  }
  for (const c of [...colis, ...volume]) {
    await db.query(
      `INSERT INTO parcels (id, tracking_code, owner_id, owner_agency_name, owner_agency_city,
        destination_agency_id, destination_agency_name, destination_agency_city,
        unregistered_destination_agency, sender, recipient, package_nature, weight_kg, price_fcfa,
        origin_city, destination_city, status, history, payment_status, paid_amount_fcfa, created_at_iso)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        c.id, c.code, c.owner,
        c.owner === "demo-abidjan" ? "Shopin30 Abidjan" : "Agence Bouaké Centre",
        c.owner === "demo-abidjan" ? "Abidjan" : "Bouaké",
        c.dest, c.destName, c.destCity,
        c.unreg ? JSON.stringify(c.unreg) : null,
        JSON.stringify({ firstName: "Awa", lastName: "Traoré", phone: "0700000001", cni: "CI12345678" }),
        JSON.stringify({ firstName: "Ibrahim", lastName: "Koné", phone: "0500000002" }),
        "Vêtements", 2.5, 3500,
        c.owner === "demo-abidjan" ? "Abidjan" : "Bouaké", c.destCity,
        c.status, JSON.stringify(c.history), c.payStatus, c.paid, c.cree
      ]
    );
    await db.query("UPDATE parcels SET updated_at = $1 WHERE id = $2", [c.maj, c.id]);
  }
  await db.query(
    "UPDATE parcels SET retour_status = 'en_cours', retour_started_at = $1 WHERE id = 'demo-colis-6'",
    [joursAvant(2)]
  );

  // LOT 4 — bordereaux de démonstration : un lot en route (Abidjan → Bouaké)
  // et un lot contrôlé à l'arrivée (Bouaké → Abidjan, zéro écart).
  const bordereaux = [
    {
      id: "demo-bdr-1", code: "BDR-DEMO01", from: "demo-abidjan", fromName: "Shopin30 Abidjan", fromCity: "Abidjan",
      to: "demo-bouake", toName: "Agence Bouaké Centre", toCity: "Bouaké",
      carrier: "Gbaka Express", phone: "0700000055", vehicle: "car Bouaké 07 h — CI-1234-AB",
      status: "En route", remis: joursAvant(3), parti: joursAvant(3), arrive: null, controle: null, cree: joursAvant(3)
    },
    {
      id: "demo-bdr-2", code: "BDR-DEMO02", from: "demo-bouake", fromName: "Agence Bouaké Centre", fromCity: "Bouaké",
      to: "demo-abidjan", toName: "Shopin30 Abidjan", toCity: "Abidjan",
      carrier: "Union Cars", phone: "0500000055", vehicle: "car Abidjan 06 h",
      status: "Contrôlé", remis: joursAvant(9), parti: joursAvant(9), arrive: joursAvant(8), controle: joursAvant(8), cree: joursAvant(9)
    },
    // LOT 5 — lot contrôlé hier par Bouaké avec un absent (statut « Écart »).
    {
      id: "demo-bdr-3", code: "BDR-DEMO03", from: "demo-abidjan", fromName: "Shopin30 Abidjan", fromCity: "Abidjan",
      to: "demo-bouake", toName: "Agence Bouaké Centre", toCity: "Bouaké",
      carrier: "UTB", phone: "0700000077", vehicle: "car Bouaké 14 h",
      status: "Écart", remis: joursAvant(2), parti: joursAvant(2), arrive: heuresAvant(21), controle: heuresAvant(20), cree: joursAvant(2),
      count: 2, missing: ["demo-colis-5"], arrivedBy: "Aïcha Touré", checkedBy: "Aïcha Touré"
    }
  ];
  for (const b of bordereaux) {
    await db.query(
      `INSERT INTO bordereaux (id, code, from_agency_id, from_agency_name, from_city, to_agency_id, to_agency_name, to_city,
        carrier_name, carrier_phone, vehicle_ref, parcel_count, status,
        handed_over_at, handed_over_by, departed_at, arrived_at, arrived_by, checked_at, checked_by,
        missing_parcel_ids, created_at_iso)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        b.id, b.code, b.from, b.fromName, b.fromCity, b.to, b.toName, b.toCity,
        b.carrier, b.phone, b.vehicle, b.count ?? 1, b.status,
        b.remis, "Koffi N'Guessan", b.parti, b.arrive,
        b.arrivedBy ?? (b.arrive ? "Shopin30 Abidjan" : null),
        b.controle, b.checkedBy ?? (b.controle ? "Shopin30 Abidjan" : null),
        JSON.stringify(b.missing ?? []), b.cree
      ]
    );
    await db.query("UPDATE bordereaux SET updated_at = $1 WHERE id = $2", [b.controle || b.parti || b.cree, b.id]);
  }
  await db.query("INSERT INTO bordereau_parcels (bordereau_id, parcel_id) VALUES ($1, $2), ($3, $4), ($5, $6), ($7, $8)",
    ["demo-bdr-1", "demo-colis-1", "demo-bdr-2", "demo-colis-3", "demo-bdr-3", "demo-colis-4", "demo-bdr-3", "demo-colis-5"]);
  await db.query("UPDATE parcels SET bordereau_id = 'demo-bdr-1' WHERE id = 'demo-colis-1'");
  await db.query("UPDATE parcels SET bordereau_id = 'demo-bdr-2' WHERE id = 'demo-colis-3'");
  await db.query("UPDATE parcels SET bordereau_id = 'demo-bdr-3' WHERE id IN ('demo-colis-4', 'demo-colis-5')");

  // LOT 4 — incidents de démonstration : un retard ouvert (bandeau sobre sur
  // le suivi public de CLI-DEMO02, escalade > 24 h) et un dommage résolu.
  await db.query(
    `INSERT INTO incidents (id, parcel_id, bordereau_id, type, state, note, opened_by_agency_id, opened_by_id, opened_by_name, opened_at_iso, resolution, updated_by_name, resolved_at_iso)
     VALUES ($1, $2, NULL, 'retard', 'ouvert', $3, $4, $5, $6, $7, '', '', NULL),
            ($8, $9, $10, 'endommage', 'resolu', $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      "demo-incident-1", "demo-colis-2",
      "Le car de Korhogo est parti sans le colis : recherches en cours auprès du transporteur déclaré.",
      "demo-abidjan", "demo-agent-koffi", "Koffi N'Guessan", joursAvant(2),
      "demo-incident-2", "demo-colis-3", "demo-bdr-2",
      "Emballage légèrement écrasé au dépotage, contenu vérifié intact avec le destinataire.",
      "demo-abidjan", "demo-abidjan", "Shopin30 Abidjan", joursAvant(9),
      "Colis remis en l'état au destinataire après vérification conjointe.", "Shopin30 Abidjan", joursAvant(8)
    ]
  );
  // LOT 5 — incident automatique du contrôle de BDR-DEMO03 (CLI-DEMO05 absent).
  await db.query(
    `INSERT INTO incidents (id, parcel_id, bordereau_id, type, state, note, opened_by_agency_id, opened_by_id, opened_by_name, opened_at_iso, resolution, updated_by_name, resolved_at_iso)
     VALUES ($1, $2, $3, 'perdu', 'ouvert', $4, $5, $6, $7, $8, '', '', NULL)`,
    [
      "demo-incident-3", "demo-colis-5", "demo-bdr-3",
      "Absent au contrôle d'arrivée du bordereau BDR-DEMO03 (Abidjan → Bouaké, transporteur UTB).",
      "demo-bouake", "demo-agent-aicha", "Aïcha Touré", heuresAvant(20)
    ]
  );

  // LOT 5 — journal des notifications de démonstration (mode simulation) :
  // mêmes messages que le serveur (js/metier-notifications.js), aucune donnée
  // personnelle, une ligne par agence concernée. Les autres échéances
  // (escalade 24 h de CLI-DEMO02, colis qui dorment, souffrance de
  // CLI-DEMO03) s'y ajoutent EN DIRECT au premier affichage du tableau de
  // bord ou du journal : balayage idempotent de lib/notifications.js.
  const colisNotif = (id) => {
    const c = colis.find((item) => item.id === id);
    return {
      id: c.id, trackingCode: c.code, ownerId: c.owner, destinationAgencyId: c.dest,
      originCity: c.owner === "demo-abidjan" ? "Abidjan" : "Bouaké", destinationCity: c.destCity
    };
  };
  const bordereauNotif = (id) => {
    const b = bordereaux.find((item) => item.id === id);
    return { id: b.id, code: b.code, fromAgencyId: b.from, toAgencyId: b.to, fromCity: b.fromCity, toCity: b.toCity, parcelCount: b.count ?? 1 };
  };
  const journalDemo = [
    { date: joursAvant(9), lu: true, evenement: { type: "incident_ouvert", parcel: colisNotif("demo-colis-3"), incident: { id: "demo-incident-2", type: "endommage" } } },
    { date: joursAvant(9), lu: true, evenement: { type: "alerte_non_retire", parcel: colisNotif("demo-colis-6"), depuis: arriveeDemo6, heures: 72 } },
    { date: joursAvant(8), lu: true, evenement: { type: "bordereau_arrive", bordereau: bordereauNotif("demo-bdr-2") } },
    { date: joursAvant(5), lu: true, evenement: { type: "colis_souffrance", parcel: colisNotif("demo-colis-6"), depuis: arriveeDemo6, jours: 7 } },
    { date: joursAvant(2), lu: false, evenement: { type: "incident_ouvert", parcel: colisNotif("demo-colis-2"), incident: { id: "demo-incident-1", type: "retard" } } },
    { date: joursAvant(2), lu: false, evenement: { type: "retour_decide", parcel: colisNotif("demo-colis-6") } },
    { date: heuresAvant(21), lu: false, evenement: { type: "bordereau_arrive", bordereau: bordereauNotif("demo-bdr-3") } },
    {
      date: heuresAvant(20), lu: false,
      evenement: { type: "incident_ouvert", parcel: colisNotif("demo-colis-5"), incident: { id: "demo-incident-3", type: "perdu", automatique: true }, bordereau: bordereauNotif("demo-bdr-3") }
    },
    { date: heuresAvant(20), lu: false, evenement: { type: "bordereau_ecart", bordereau: bordereauNotif("demo-bdr-3"), absents: ["CLI-DEMO05"] } }
  ];
  let rangNotif = 0;
  for (const { date, lu, evenement } of journalDemo) {
    for (const notification of notificationsPourAgences(evenement)) {
      rangNotif += 1;
      await db.query(
        `INSERT INTO notifications (id, agency_id, type, titre, message, lien, parcel_id, bordereau_id, incident_id,
           canal, statut, dedup_key, lu, created_at, created_at_iso)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'simulation', 'simule', $10, $11, $12, $13)`,
        [
          `demo-notif-${rangNotif}`, notification.agencyId, notification.type, notification.titre, notification.message,
          notification.lien, notification.parcelId, notification.bordereauId, notification.incidentId,
          notification.cle, lu, date, date
        ]
      );
    }
  }

  // LOT 6 — litige de démonstration : CLI-DEMO07 contesté depuis 10 jours
  // (en recherches) → file plateforme (> 7 j) et liste des litiges.
  await db.query(
    `INSERT INTO incidents (id, parcel_id, bordereau_id, type, state, note, opened_by_agency_id, opened_by_id, opened_by_name, opened_at_iso, resolution, updated_by_name, resolved_at_iso)
     VALUES ($1, $2, NULL, 'conteste', 'recherches', $3, $4, $5, $6, $7, '', $6, NULL)`,
    [
      "demo-incident-4", "demo-colis-7",
      "Le destinataire signale un article manquant à l'ouverture du colis : vérification du chargement avec l'agence d'Abidjan.",
      "demo-bouake", "demo-agent-aicha", "Aïcha Touré", joursAvant(10)
    ]
  );

  // LOT 6 — plans et portefeuilles : Abidjan au plan Pro (abonnement du mois
  // réglé depuis le portefeuille, 2 500 FCFA restants : la prochaine échéance
  // demandera une recharge), Bouaké au plan Gratuit (48/50, 60 FCFA = 2 colis
  // hors forfait prépayés). Mouvements journalisés comme en production.
  const periodeDemo = clePeriode(new Date(maintenant));
  const debutMoisISO = new Date(debutMois).toISOString();
  const apresOuvertureISO = new Date(Math.min(maintenant, debutMois + 60_000)).toISOString();
  await db.query("UPDATE agencies SET plan = 'pro', portefeuille_fcfa = 2500 WHERE id = 'demo-abidjan'");
  await db.query("UPDATE agencies SET plan = 'gratuit', portefeuille_fcfa = 60 WHERE id = 'demo-bouake'");
  const compteurAbidjan = colis.filter((c) => c.owner === "demo-abidjan" && creeCeMois(c)).length;
  await db.query(
    `INSERT INTO facturation_periodes (agency_id, periode, plan, quota, colis_comptes, colis_depassement,
       abonnement_fcfa, abonnement_statut, echeance_iso, paye_le_iso, created_at, created_at_iso)
     VALUES ('demo-abidjan', $1, 'pro', 500, $2, 0, 10000, 'paye', $3, $4, $5, $6),
            ('demo-bouake', $1, 'gratuit', 50, $7, 0, 0, 'sans_frais', NULL, NULL, $5, $6)`,
    [periodeDemo, compteurAbidjan, calculerEcheance(debutMoisISO), apresOuvertureISO, debutMoisISO, debutMoisISO, COMPTEUR_BOUAKE]
  );
  const mouvements = [
    ["demo-mvt-1", "demo-abidjan", "recharge", 12500, 12500, null, "Recharge du portefeuille", "MM-DEMO-0001", "Console Shopin30", debutMoisISO],
    ["demo-mvt-2", "demo-abidjan", "abonnement", -10000, 2500, periodeDemo, `Abonnement Pro — ${libellePeriode(periodeDemo)}`, null, null, apresOuvertureISO],
    ["demo-mvt-3", "demo-bouake", "recharge", 60, 60, null, "Recharge du portefeuille", "MM-DEMO-0002", "Console Shopin30", debutMoisISO]
  ];
  for (const [id, agence, type, montant, solde, periode, libelle, reference, acteur, date] of mouvements) {
    await db.query(
      `INSERT INTO portefeuille_mouvements (id, agency_id, type, montant_fcfa, solde_apres_fcfa, periode, libelle, reference, acteur_nom, created_at, created_at_iso)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, agence, type, montant, solde, periode, libelle, reference, acteur, date, date]
    );
  }

  // LOT 6 — compte de la console plateforme (démo uniquement ; en production,
  // `npm run plateforme-admin` le crée depuis les variables d'environnement).
  await db.query(
    `INSERT INTO plateforme_admins (id, email, name, password_hash, active, created_at_iso)
     VALUES ('demo-plateforme', 'plateforme@colisexpress.ci', 'Console Shopin30', $1, TRUE, $2)`,
    [hash, now]
  );

  // LOT 7 — suivi personnalisé : Shopin30 Abidjan habille le suivi public de
  // ses colis (bleu et or, logo stocké via lib/photos.js) ; Bouaké garde
  // l'apparence COLIS EXPRESS par défaut. Comparez CLI-DEMO01 et CLI-DEMO03.
  const cleLogo = await stockerObjet({
    key: "marques/demo-abidjan/logo-demo.png",
    buffer: logoDemoPng({ fond: [29, 58, 138], ruban: [245, 179, 1] }),
    contentType: "image/png"
  });
  await db.query(
    `UPDATE agencies SET marque_active = TRUE, marque_nom = 'Shopin30 Abidjan', marque_couleur = '#1d3a8a',
       marque_couleur_2 = '#f5b301', marque_logo_cle = $1, marque_logo_type = 'image/png', marque_maj_iso = $2
     WHERE id = 'demo-abidjan'`,
    [cleLogo, now]
  );

  // LOT 4 — photo de preuve de démonstration (prise en charge de CLI-DEMO01) :
  // le contenu passe par lib/photos.js (disque local en démo, Vercel Blob en
  // production) — jamais de base64 dans Postgres, seulement les métadonnées.
  const pngDemo = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  const clePhoto = await stockerObjet({
    key: "colis/demo-colis-1/prise-en-charge-demo.png",
    buffer: pngDemo,
    contentType: "image/png"
  });
  await db.query(
    `INSERT INTO photos (id, parcel_id, etape, storage_key, content_type, size_bytes, agency_id, agent_id, agent_name, created_at_iso)
     VALUES ($1, $2, 'prise_en_charge', $3, 'image/png', $4, $5, $6, $7, $8)`,
    ["demo-photo-1", "demo-colis-1", clePhoto, pngDemo.length, "demo-abidjan", "demo-agent-koffi", "Koffi N'Guessan", joursAvant(4)]
  );

  // LOT 3 — carnet de clients de démonstration : les expéditeurs et
  // destinataires des colis ci-dessus sont mémorisés par leur agence, plus un
  // client sans colis pour montrer la saisie manuelle.
  const clients = [
    ["demo-client-1", "demo-abidjan", "expediteur", "Awa", "Traoré", "0700000001", "CI12345678", "Abidjan"],
    ["demo-client-2", "demo-abidjan", "destinataire", "Ibrahim", "Koné", "0500000002", null, "Bouaké"],
    ["demo-client-3", "demo-abidjan", "expediteur", "Mariam", "Diarra", "0700000021", "CI87654321", "Abidjan"],
    ["demo-client-4", "demo-bouake", "expediteur", "Awa", "Traoré", "0700000001", "CI12345678", "Bouaké"],
    ["demo-client-5", "demo-bouake", "destinataire", "Ibrahim", "Koné", "0500000002", null, "Abidjan"]
  ];
  for (const [id, agency, kind, prenom, nom, tel, cni, ville] of clients) {
    await db.query(
      `INSERT INTO clients (id, agency_id, kind, first_name, last_name, phone, cni, city, notes, created_at_iso, updated_at_iso)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '', $9, $9)`,
      [id, agency, kind, prenom, nom, tel, cni, ville, now]
    );
  }

  // LOT 2 — encaissement du jour (caisse de démonstration) : le colis 1 a été
  // payé au départ en espèces par l'agent Koffi.
  const jour = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Abidjan", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  await db.query(
    `INSERT INTO encaissements (id, parcel_id, agency_id, agent_id, agent_name, amount_fcfa, mode, date_key, created_at_iso)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    ["demo-enc-1", "demo-colis-1", "demo-abidjan", "demo-agent-koffi", "Koffi N'Guessan", 3500, "especes", jour, now]
  );
}
