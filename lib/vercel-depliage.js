/* 
 * Dépliage des URLs repliées par les rewrites Vercel (plan Hobby).
 *
 * Vercel réécrit /api/plateforme/connexion en /api/plateforme?action=connexion
 * (voir vercel.json). Ce module reconstruit l'URL réelle avant le routage
 * Express, en s'appuyant sur plusieurs sources possibles selon la façon dont
 * Vercel transmet la requête à la fonction serverless :
 *   - req.query.action (cas normal, déjà couvert par le middleware) ;
 *   - la chaîne de requête de req.url ;
 *   - les en-têtes x-vercel-original-path / x-now-route-matches ;
 *   - un chemin original complet transmis par Vercel.
 *
 * La fonction est idempotente et ne fait rien si l'URL est déjà sous sa
 * forme complète (3 segments ou plus sous /api).
 */
const ACTION = /^[a-z][a-z-]{2,}$/;

function segments(chemin) {
  return String(chemin || "").split("?")[0].split("/").filter(Boolean);
}

function actionDepuisValeur(valeur) {
  if (typeof valeur !== "string" || !valeur) return null;
  // Chaîne de requête action=...
  let m = valeur.match(/[?&]action=([a-z][a-z-]{2,})/);
  if (m) return m[1];
  // JSON (x-now-route-matches peut être un objet sérialisé).
  try {
    const obj = JSON.parse(valeur);
    if (obj && typeof obj.action === "string" && ACTION.test(obj.action)) return obj.action;
    if (obj && typeof obj.path === "string") {
      const s = segments(obj.path);
      const dernier = s[s.length - 1];
      if (dernier && ACTION.test(dernier) && s.length >= 2) return dernier;
    }
  } catch {}
  // Chemin original complet : /api/plateforme/amorcage (ou /plateforme/amorcage).
  const chemin = valeur.split("?")[0];
  const s = segments(chemin);
  if (s.length >= 3 && s[0] === "api") {
    const dernier = s[s.length - 1];
    if (ACTION.test(dernier)) return dernier;
  }
  if (s.length === 2 && s[0] !== "api") {
    const dernier = s[1];
    if (ACTION.test(dernier)) return dernier;
  }
  return null;
}

export function cheminOriginalVercel(req) {
  const enTetes = req?.headers || {};
  for (const nom of ["x-vercel-original-path", "x-vercel-original-url", "x-now-route-matches", "x-vercel-rewrite-path"]) {
    const valeur = enTetes[nom] || enTetes[nom.toLowerCase()];
    if (typeof valeur === "string" && valeur) {
      const chemin = valeur.split("?")[0];
      const s = segments(chemin);
      // On ne retient que les chemins qui pointent vers une route API repliée
      // (au moins 3 segments dont "api", ou 2 segments sans "api").
      if (s.length >= 3 && s[0] === "api") return chemin;
      if (s.length === 2 && s[0] !== "api") return "/api" + (chemin.startsWith("/") ? chemin : "/" + chemin);
    }
  }
  return null;
}

export function deplierRequeteVercel(req) {
  if (!req || typeof req.url !== "string") return;
  const cheminActuel = req.url.split("?")[0];
  const segs = segments(cheminActuel);
  // Déjà sous forme complète : /api/.../action (3 segments ou plus).
  if (segs.length >= 3 && segs[0] === "api") return;

  // 1. Chemin original fourni par Vercel : on l'utilise tel quel.
  const original = cheminOriginalVercel(req);
  if (original) {
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    req.url = original + (original.includes("?") ? "" : query);
    return;
  }

  // 2. Action disponible quelque part (query, en-tête, ...).
  let action = null;
  try {
    if (typeof req.query?.action === "string" && ACTION.test(req.query.action)) action = req.query.action;
  } catch {}
  if (!action) {
    const idx = req.url.indexOf("?");
    if (idx >= 0) {
      try {
        const params = new URLSearchParams(req.url.slice(idx + 1));
        const a = params.get("action");
        if (a && ACTION.test(a)) action = a;
      } catch {}
    }
  }
  if (!action) {
    const enTetes = req?.headers || {};
    for (const nom of ["x-vercel-original-path", "x-vercel-original-url", "x-now-route-matches", "x-vercel-rewrite-path"]) {
      const valeur = enTetes[nom] || enTetes[nom.toLowerCase()];
      if (typeof valeur === "string") {
        const a = actionDepuisValeur(valeur);
        if (a) { action = a; break; }
      }
    }
  }
  if (typeof action === "string" && ACTION.test(action)) {
    const [chemin] = req.url.split("?");
    if (segments(chemin).at(-1) === action) return;
    const reste = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
    req.url = reste ? `${chemin}/${action}?${reste}` : `${chemin}/${action}`;
  }
}
