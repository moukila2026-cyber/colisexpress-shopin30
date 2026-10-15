/*
 * Point d'entrée Vercel : la totalité de /api/* arrive sur cette application
 * Express (routes, sessions et autorisations dans lib/app.js).
 *
 * Le nom de fichier compte : hors Next.js, Vercel ne connaît que le segment
 * dynamique simple `[param]` et le catch-all `[...param]`. L'ancien nom
 * `[[...path]].js` (catch-all optionnel, syntaxe Next.js) était interprété
 * comme un segment simple : `/api/health` ou `/api/colis` répondaient, mais
 * toute route imbriquée (`/api/colis/:id`, `/api/colis/:id/attach`,
 * `/api/suivi/:code`…) tombait sur le 404 NOT_FOUND de la plateforme, sans
 * jamais atteindre Express — d'où la fiche colis et le suivi QR en panne sur
 * le site déployé alors que tout passait en local. `[...path]` capte un ou
 * plusieurs segments : toutes les routes appelées par le front ont au moins
 * un segment après /api, le compte est bon.
 */
export { default } from "../lib/app.js";
