/*
 * Point d'entrée Vercel des routes API à un segment : /api/health,
 * /api/register, /api/login, /api/logout, /api/me, /api/agences, /api/colis,
 * /api/caisse, /api/alertes, /api/notifications…
 * Toute la logique (routes, sessions, autorisations) est dans lib/app.js.
 *
 * Le nom de fichier compte : hors Next.js, Vercel convertit tout segment
 * entre crochets (`[param]`, `[...param]`, `[[...param]]`) en `([^/]+)` —
 * un seul segment d'URL, jamais un catch-all multi-segments. Les routes à
 * DEUX segments ont donc leur fichier (api/colis/[id].js, api/suivi/[code].js,
 * api/bordereaux/[id].js…), qui réexporte la même application Express.
 *
 * Les routes à TROIS segments n'ont PAS de fichier : le plan Hobby de Vercel
 * limite un déploiement à 12 fonctions serverless (un fichier par route
 * imbriquée en faisait 19 et chaque déploiement échouait). Elles sont
 * repliées par les rewrites de vercel.json sur la fonction parente
 * (ex. /api/colis/:id/:action → /api/colis/:id?action=:action,
 * /api/notifications/:action → /api/notifications?action=:action), et le
 * premier middleware de lib/app.js redéplie l'URL réelle avant le routage.
 * Nouvelle route imbriquée = un rewrite, jamais un nouveau fichier ici
 * (garde-fou : tests/integration-page.test.mjs).
 */
export { default } from "../lib/app.js";
