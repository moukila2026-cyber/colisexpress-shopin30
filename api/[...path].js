/*
 * Point d'entrée Vercel des routes API à un segment : /api/health,
 * /api/register, /api/login, /api/logout, /api/me, /api/agences, /api/colis.
 * Toute la logique (routes, sessions, autorisations) est dans lib/app.js.
 *
 * Le nom de fichier compte : hors Next.js, Vercel convertit tout segment
 * entre crochets (`[param]`, `[...param]`, `[[...param]]`) en `([^/]+)` —
 * un seul segment d'URL, jamais un catch-all multi-segments. Les routes
 * imbriquées ont donc leurs propres fichiers, qui réexportent la même
 * application Express : api/colis/[id].js, api/colis/[id]/attach.js,
 * api/colis/[id]/progress.js et api/suivi/[code].js. Sans eux,
 * /api/colis/:id et /api/suivi/:code tombaient sur le 404 NOT_FOUND de la
 * plateforme sans atteindre Express (fiche colis et QR code en panne sur
 * le site déployé, alors que tout passait en local via server.js).
 * Toute nouvelle route imbriquée doit recevoir son fichier ici.
 */
export { default } from "../lib/app.js";
