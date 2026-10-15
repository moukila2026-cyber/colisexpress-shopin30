/*
 * Route imbriquée Vercel : GET /api/colis/:id (fiche colis).
 * Hors Next.js, un segment entre crochets ne capte qu'un seul segment
 * d'URL : il faut un fichier par forme de route imbriquée, chacun
 * réexporte la même application Express (lib/app.js), qui reçoit l'URL
 * d'origine complète et applique ses propres routes.
 */
export { default } from "../../lib/app.js";
