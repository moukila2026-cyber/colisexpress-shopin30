/*
 * Point d'entrée Vercel dédié au parent /api/taches.
 * Les routes imbriquées sont repliées par vercel.json avec ?action=..., ce
 * qui conserve la limite de 12 fonctions du plan Hobby.
 */
import app from "../lib/app.js";
import { deplierRequeteVercel } from "../lib/vercel-depliage.js";

export default function handler(req, res) {
  deplierRequeteVercel(req);
  return app(req, res);
}
