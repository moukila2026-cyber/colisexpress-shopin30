/*
 * Applique db/schema.sql (idempotent, migrations additives) sur la base
 * définie par DATABASE_URL — `npm run init-db`. Le serveur applique aussi le
 * schéma à son démarrage ; ce script permet de le faire avant un déploiement.
 */
import { getDb } from "./db.js";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL absente : définissez la connection string Neon (variable d'environnement) avant `npm run init-db`.");
  process.exit(1);
}

try {
  await getDb();
  console.log("Schéma appliqué : toutes les tables COLIS EXPRESS sont prêtes.");
  process.exit(0);
} catch (error) {
  // Jamais la connection string dans les journaux : uniquement le code d'erreur.
  console.error(`Échec de l'application du schéma (${error?.code ?? "erreur inconnue"}). Vérifiez DATABASE_URL.`);
  process.exit(1);
}
