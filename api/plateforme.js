/*
 * Fonction Vercel dédiée au parent /api/plateforme.
 * Les routes imbriquées (connexion, amorcage, mise-en-service, taches, etc.)
 * sont repliées par vercel.json sur ce parent avec ?action=... . Cette
 * fonction explicite évite de dépendre de la résolution du catch-all
 * api/[...path].js sur Vercel Hobby.
 */
import app from "../lib/app.js";
import { deplierRequeteVercel } from "../lib/vercel-depliage.js";

export default function handler(req, res) {
  deplierRequeteVercel(req);
  return app(req, res);
}
