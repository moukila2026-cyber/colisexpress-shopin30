/*
 * Crée ou met à jour un compte de la console plateforme (LOT 6), SANS aucun
 * secret dans le code : tout vient des variables d'environnement.
 *
 *   PLATEFORME_ADMIN_EMAIL=equipe@shopin30.ci \
 *   PLATEFORME_ADMIN_NOM="Équipe Shopin30" \
 *   PLATEFORME_ADMIN_MOT_DE_PASSE=… \
 *   DATABASE_URL=… npm run plateforme-admin
 *
 * PLATEFORME_ADMIN_ACTIF=0 désactive le compte (aucune suppression).
 * Le mot de passe n'est jamais affiché ni journalisé ; il est haché (scrypt).
 * En démo (sans DATABASE_URL), le compte plateforme@colisexpress.ci est créé
 * automatiquement par le seed.
 */
import crypto from "node:crypto";

import { hashPassword } from "../lib/auth.js";
import { getDb, query } from "./db.js";

const email = String(process.env.PLATEFORME_ADMIN_EMAIL ?? "").trim().toLowerCase();
const nom = String(process.env.PLATEFORME_ADMIN_NOM ?? "").trim() || "Équipe Shopin30";
const motDePasse = String(process.env.PLATEFORME_ADMIN_MOT_DE_PASSE ?? "");
const actif = process.env.PLATEFORME_ADMIN_ACTIF !== "0";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL absente : ce script vise la base Neon (en démo, le compte plateforme est créé par le seed).");
  process.exit(1);
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
  console.error("Définissez PLATEFORME_ADMIN_EMAIL (adresse e-mail valide).");
  process.exit(1);
}
if (actif && motDePasse.length < 12) {
  console.error("Définissez PLATEFORME_ADMIN_MOT_DE_PASSE (12 caractères minimum).");
  process.exit(1);
}

try {
  await getDb();
  if (actif) {
    await query(
      `INSERT INTO plateforme_admins (id, email, name, password_hash, active, created_at_iso)
       VALUES ($1, $2, $3, $4, TRUE, $5)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, active = TRUE`,
      [crypto.randomUUID(), email, nom, hashPassword(motDePasse), new Date().toISOString()]
    );
    console.log(`Compte de la console plateforme prêt : ${email}`);
  } else {
    const { rows } = await query("UPDATE plateforme_admins SET active = FALSE WHERE email = $1 RETURNING id", [email]);
    console.log(rows.length ? `Compte désactivé : ${email}` : `Aucun compte plateforme pour ${email}.`);
  }
  process.exit(0);
} catch (error) {
  console.error(`Échec (${error?.code ?? "erreur inconnue"}). Vérifiez DATABASE_URL et le schéma (npm run init-db).`);
  process.exit(1);
}
