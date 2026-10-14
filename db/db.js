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
  const colis = [
    {
      id: "demo-colis-1", code: "CLI-DEMO01", owner: "demo-abidjan", dest: "demo-bouake",
      destName: "Agence Bouaké Centre", destCity: "Bouaké", status: "Expédié",
      history: [
        { status: "Enregistré", date: now, agencyName: "Shopin30 Abidjan", city: "Abidjan" },
        { status: "Expédié", date: now, agencyName: "Shopin30 Abidjan", city: "Abidjan" }
      ], unreg: null
    },
    {
      id: "demo-colis-2", code: "CLI-DEMO02", owner: "demo-abidjan", dest: null,
      destName: "Flash Korhogo", destCity: "Korhogo", status: "Enregistré",
      history: [{ status: "Enregistré", date: now, agencyName: "Shopin30 Abidjan", city: "Abidjan" }],
      unreg: { name: "Flash Korhogo", city: "Korhogo", phone: "0700000009" }
    },
    {
      id: "demo-colis-3", code: "CLI-DEMO03", owner: "demo-bouake", dest: "demo-abidjan",
      destName: "Shopin30 Abidjan", destCity: "Abidjan", status: "Arrivé à l'agence de destination",
      history: [
        { status: "Enregistré", date: now, agencyName: "Agence Bouaké Centre", city: "Bouaké" },
        { status: "Expédié", date: now, agencyName: "Agence Bouaké Centre", city: "Bouaké" },
        { status: "En transit", date: now, agencyName: "Agence Bouaké Centre", city: "Bouaké" },
        { status: "Arrivé à l'agence de destination", date: now, agencyName: "Shopin30 Abidjan", city: "Abidjan" }
      ], unreg: null
    }
  ];
  for (const c of colis) {
    await db.query(
      `INSERT INTO parcels (id, tracking_code, owner_id, owner_agency_name, owner_agency_city,
        destination_agency_id, destination_agency_name, destination_agency_city,
        unregistered_destination_agency, sender, recipient, package_nature, weight_kg, price_fcfa,
        origin_city, destination_city, status, history, created_at_iso)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
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
        c.status, JSON.stringify(c.history), now
      ]
    );
  }
}
