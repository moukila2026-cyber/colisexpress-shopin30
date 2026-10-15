/*
 * Route imbriquée Vercel : PATCH /api/agents/:id (activation/désactivation
 * d'un agent par le gérant). Voir api/colis/[id].js pour le principe :
 * hors Next.js, un segment entre crochets ne capte qu'un seul segment
 * d'URL — chaque forme de route imbriquée a son fichier, qui réexporte
 * la même application Express (lib/app.js).
 */
export { default } from "../../../lib/app.js";
