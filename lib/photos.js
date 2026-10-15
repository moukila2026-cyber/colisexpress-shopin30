/*
 * Stockage des objets photos (LOT 4) — isolé derrière deux fonctions :
 *
 *   stockerObjet({ key, buffer, contentType }) → key enregistré
 *   lireObjet(key)                             → { buffer, contentType } | null
 *
 * Backends (choix simple et réversible, jamais de base64 géant en base) :
 *   - **Vercel Blob** si `BLOB_READ_WRITE_TOKEN` est défini (recommandé en
 *     production : stockage d'objets dédié, compatible Vercel sans config
 *     supplémentaire). L'URL du blob reste strictement interne (colonne
 *     `photos.storage_key`) : le contenu n'est servi QUE par la route
 *     authentifiée `GET /api/photos/:id` (accès limité aux deux agences).
 *   - **disque local** sinon (`PHOTOS_DIR`, défaut `uploads/photos`) :
 *     développement, démo et tests avec server.js.
 *
 * La base Postgres ne garde que les métadonnées (table `photos`). Aucune
 * suppression n'est exposée : les photos font partie de la chaîne de preuve.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CLE_SURE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function backendPhotos() {
  return process.env.BLOB_READ_WRITE_TOKEN ? "vercel-blob" : "local";
}

function validerCle(key) {
  const cle = String(key ?? "");
  if (!CLE_SURE.test(cle) || cle.includes("..")) {
    throw new Error("Clé de stockage invalide.");
  }
  return cle;
}

async function stockageLocal() {
  const racine = path.resolve(process.env.PHOTOS_DIR || "uploads/photos");
  return {
    async stocker(key, buffer, contentType) {
      const cible = path.join(racine, validerCle(key));
      await mkdir(path.dirname(cible), { recursive: true });
      await writeFile(cible, buffer);
      await writeFile(`${cible}.type`, contentType, "utf8").catch(() => {});
      return key;
    },
    async lire(key) {
      const cible = path.join(racine, validerCle(key));
      try {
        const buffer = await readFile(cible);
        const contentType = await readFile(`${cible}.type`, "utf8").catch(() => "image/jpeg");
        return { buffer, contentType };
      } catch {
        return null;
      }
    }
  };
}

async function stockageVercelBlob() {
  const { get, put } = await import("@vercel/blob");
  return {
    async stocker(key, buffer, contentType) {
      const blob = await put(validerCle(key), buffer, {
        access: "public", // URL jamais diffusée : la lecture passe par GET /api/photos/:id (authentifié)
        contentType,
        addRandomSuffix: false
      });
      return blob.url; // storage_key = URL interne du blob (non exposée)
    },
    async lire(key) {
      try {
        const blob = await get(key);
        const buffer = Buffer.from(await blob.arrayBuffer());
        return { buffer, contentType: blob.contentType || "image/jpeg" };
      } catch {
        return null;
      }
    }
  };
}

let memo = null;

async function backend() {
  const voulu = backendPhotos();
  if (!memo || memo.kind !== voulu) {
    memo = { kind: voulu, acces: voulu === "vercel-blob" ? await stockageVercelBlob() : await stockageLocal() };
  }
  return memo.acces;
}

export async function stockerObjet({ key, buffer, contentType }) {
  return (await backend()).stocker(key, buffer, contentType);
}

export async function lireObjet(key) {
  return (await backend()).lire(key);
}
