/*
 * Route imbriquée Vercel : GET/PATCH /api/clients/:id (fiche client du carnet
 * et son historique de colis). Voir api/colis/[id].js pour le principe : hors
 * Next.js, un segment entre crochets ne capte qu'un seul segment d'URL — un
 * fichier par forme de route imbriquée, tous réexportent lib/app.js.
 */
export { default } from "../../lib/app.js";
