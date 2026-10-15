/*
 * Accès à la base : Postgres (Neon) via `pg` quand DATABASE_URL est défini,
 * sinon PGlite (Postgres WASM en mémoire) pour le développement, la démo et
 * les tests — même SQL dans les deux cas.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashPassword } from "../lib/auth.js";

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

  const colis = [
    {
      id: "demo-colis-1", code: "CLI-DEMO01", owner: "demo-abidjan", dest: "demo-bouake",
      destName: "Agence Bouaké Centre", destCity: "Bouaké", status: "Expédié",
      payStatus: "paye", paid: 3500,
      history: [
        { status: "Enregistré", date: now, agencyName: "Shopin30 Abidjan", city: "Abidjan", actorId: "demo-agent-koffi", actorName: "Koffi N'Guessan" },
        { status: "Expédié", date: now, agencyName: "Shopin30 Abidjan", city: "Abidjan", actorId: "demo-agent-koffi", actorName: "Koffi N'Guessan" }
      ], unreg: null
    },
    {
      id: "demo-colis-2", code: "CLI-DEMO02", owner: "demo-abidjan", dest: null,
      destName: "Flash Korhogo", destCity: "Korhogo", status: "Enregistré",
      payStatus: "arrivee", paid: 0,
      history: [{ status: "Enregistré", date: now, agencyName: "Shopin30 Abidjan", city: "Abidjan" }],
      unreg: { name: "Flash Korhogo", city: "Korhogo", phone: "0700000009" }
    },
    {
      id: "demo-colis-3", code: "CLI-DEMO03", owner: "demo-bouake", dest: "demo-abidjan",
      destName: "Shopin30 Abidjan", destCity: "Abidjan", status: "Arrivé à l'agence de destination",
      payStatus: "arrivee", paid: 0,
      history: [
        { status: "Enregistré", date: now, agencyName: "Agence Bouaké Centre", city: "Bouaké" },
        { status: "Expédié", date: now, agencyName: "Agence Bouaké Centre", city: "Bouaké", actorId: "demo-agent-aicha", actorName: "Aïcha Touré" },
        { status: "En transit", date: now, agencyName: "Agence Bouaké Centre", city: "Bouaké", actorId: "demo-agent-aicha", actorName: "Aïcha Touré" },
        { status: "Arrivé à l'agence de destination", date: now, agencyName: "Shopin30 Abidjan", city: "Abidjan", actorId: "demo-abidjan", actorName: "Shopin30 Abidjan" }
      ], unreg: null
    }
  ];
  for (const c of colis) {
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
        c.status, JSON.stringify(c.history), c.payStatus, c.paid, now
      ]
    );
  }

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
