/*
 * Intégrité statique de l'application : syntaxe, imports/exports entre modules
 * locaux, identifiants DOM réellement présents dans les pages, liens internes et
 * absence de toute dépendance Firebase. Ces vérifications remplacent ce que le
 * navigateur refuserait de faire (module introuvable, export mal orthographié,
 * getElementById qui renvoie null) dans un sandbox sans base externe.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const RACINE = path.resolve(import.meta.dirname, "..");
const DOSSIER_JS = path.join(RACINE, "js");

const entrees = {
  "index.html": "js/public.js",
  "suivi.html": "js/suivi.js",
  "connexion.html": "js/connexion.js",
  "inscription.html": "js/inscription.js",
  "dashboard.html": "js/dashboard.js",
  "nouveau-colis.html": "js/nouveau-colis.js",
  "colis.html": "js/colis.js",
  "parametres.html": "js/parametres.js",
  "caisse.html": "js/caisse.js",
  "clients.html": "js/clients.js",
  "bordereaux.html": "js/bordereaux.js",
  "bordereau.html": "js/bordereau-public.js",
  "notifications.html": "js/notifications.js",
  "abonnement.html": "js/abonnement.js",
  "plateforme.html": "js/plateforme.js",
  "paiement-simulation.html": "js/paiement-simulation.js"
};

const PAGES_SANS_SCRIPT = new Set(["conditions.html", "confidentialite.html", "404.html"]);

function lire(fichier) {
  return readFileSync(path.join(RACINE, fichier), "utf8");
}

function fichiersJs() {
  return readdirSync(DOSSIER_JS)
    .filter((nom) => nom.endsWith(".js"))
    .map((nom) => `js/${nom}`);
}

/** Graphe des modules locaux importés depuis un module d'entrée. */
function grapheModules(entree) {
  const vus = new Set();
  const file = (fichier) => {
    if (vus.has(fichier)) return;
    vus.add(fichier);
    const source = lire(fichier);
    for (const match of source.matchAll(/from\s+"(\.\/[^"]+)"/g)) {
      const cible = path.posix.normalize(path.posix.join(path.posix.dirname(fichier), match[1]));
      if (existsSync(path.join(RACINE, cible))) file(cible);
    }
  };
  file(entree);
  return vus;
}

function exportsDe(fichier) {
  const source = lire(fichier);
  const noms = new Set();
  for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z0-9_$]+)/g)) noms.add(match[1]);
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const morceau of match[1].split(",")) {
      const propre = morceau.trim();
      if (!propre) continue;
      const alias = propre.split(/\s+as\s+/);
      noms.add((alias[1] || alias[0]).trim());
    }
  }
  return noms;
}

test("tous les modules JS sont syntaxiquement valides en ES modules", () => {
  const dossier = mkdtempSync(path.join(tmpdir(), "colis-syntaxe-"));
  for (const fichier of fichiersJs()) {
    const copie = path.join(dossier, `${fichier.replace(/[/.]/g, "_")}.mjs`);
    writeFileSync(copie, lire(fichier));
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ["--check", copie], { stdio: "pipe" }),
      `${fichier} ne se parse pas`
    );
  }
});

test("aucune trace de Firebase ne subsiste et le vendor QR code est présent", () => {
  for (const fichier of [...fichiersJs(), ...readdirSync(RACINE).filter((n) => n.endsWith(".html")).map((n) => n)]) {
    const source = lire(fichier);
    assert.doesNotMatch(source, /gstatic\.com\/firebasejs|firebase-config|firebase\.js|firestore/i, `${fichier} référence encore Firebase`);
  }
  const dossiers = [".", "lib", "db", "api"];
  for (const dossier of dossiers) {
    const chemin = path.join(RACINE, dossier);
    if (!existsSync(chemin)) continue;
    for (const nom of readdirSync(chemin)) {
      if (!/\.(js|mjs|sql|json)$/.test(nom)) continue;
      const source = readFileSync(path.join(chemin, nom), "utf8");
      assert.doesNotMatch(source, /gstatic\.com\/firebasejs/i, `${dossier}/${nom} référence encore le SDK Firebase`);
    }
  }
  assert.ok(existsSync(path.join(DOSSIER_JS, "vendor/qrcode-generator.js")), "le générateur de QR code est requis par le reçu");
});

test("chaque import local pointe vers un export qui existe", () => {
  for (const fichier of fichiersJs()) {
    const source = lire(fichier);
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.\/[^"]+)"/g)) {
      const cible = path.posix.normalize(path.posix.join(path.posix.dirname(fichier), match[2]));
      assert.ok(existsSync(path.join(RACINE, cible)), `${fichier} importe ${match[2]} : fichier absent`);
      const exports = exportsDe(cible);
      for (const morceau of match[1].split(",")) {
        const propre = morceau.trim();
        if (!propre) continue;
        const nom = propre.split(/\s+as\s+/)[0].trim();
        assert.ok(exports.has(nom), `${fichier} importe « ${nom} » de ${match[2]}, qui ne l'exporte pas`);
      }
    }
  }
});

test("les identifiants manipulés par une page existent dans son HTML", () => {
  for (const [page, entree] of Object.entries(entrees)) {
    const graphe = grapheModules(entree);
    const html = lire(page);
    const idsDisponibles = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const fichier of graphe) {
      for (const match of lire(fichier).matchAll(/\bid=\\?"([^"\\]+)/g)) idsDisponibles.add(match[1]);
      for (const match of lire(fichier).matchAll(/\.id\s*=\s*"([^"]+)"/g)) idsDisponibles.add(match[1]);
    }
    for (const fichier of graphe) {
      const source = lire(fichier);
      const demandes = [
        ...[...source.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]),
        ...[...source.matchAll(/querySelector\("#([A-Za-z0-9_-]+)"\)/g)].map((match) => match[1])
      ];
      for (const id of demandes) {
        assert.ok(
          idsDisponibles.has(id),
          `${fichier} cherche #${id} : aucun élément portant cet id dans ${page} ou dans le HTML généré`
        );
      }
    }
  }
});

test("les formulaires de saisie déclarent bien leurs champs", () => {
  const attendus = {
    "nouveau-colis.html": [
      "senderFirstName", "senderLastName", "senderPhone", "senderCni",
      "recipientFirstName", "recipientLastName", "recipientPhone",
      "packageNature", "weightKg", "priceFCFA", "originCity", "destinationCity",
      "destinationAgencyId", "agencyNotRegistered", "declaredAgencyName", "declaredAgencyCity", "declaredAgencyPhone"
    ]
  };
  for (const [page, champs] of Object.entries(attendus)) {
    const html = lire(page);
    for (const champ of champs) {
      assert.match(html, new RegExp(`name="${champ}"`), `${page} doit exposer un champ name="${champ}" (FormData)`);
    }
    for (const balise of html.matchAll(/<input\b[^>]*>/g)) {
      const brut = balise[0];
      const id = /\bid="([^"]+)"/.exec(brut)?.[1] || "(sans id)";
      if (!/type="(checkbox|hidden|radio|file|submit)"/.test(brut)) {
        assert.match(brut, /\bname="/, `le champ #${id} de ${page} n'a pas d'attribut name : il serait ignoré par FormData`);
      }
    }
  }
});

test("le mode « agence non inscrite » est câblé de bout en bout", () => {
  const html = lire("nouveau-colis.html");
  const script = lire("js/nouveau-colis.js");
  assert.match(html, /id="unregisteredAgencyPanel"/);
  assert.match(html, /id="agencyNotRegistered"/);
  assert.match(html, /hidden/, "le panneau de saisie doit être masqué par défaut");
  assert.match(script, /agencyNotRegistered/);
  assert.match(script, /resoudreDestination/);
  assert.match(script, /unregisteredDestinationAgency/);
  // Le rattachement est exécuté par l'API, qui applique les mêmes règles métier.
  assert.match(lire("js/colis.js"), /\/attach/);
  assert.match(lire("js/colis.js"), /Agence de destination à rattacher/);
  const api = lire("lib/app.js");
  assert.match(api, /changementsRattachement/);
  assert.match(api, /peutRattacher/);
  assert.match(api, /prochaineEtape/);
});

test("tous les liens internes des pages pointent vers un fichier du dépôt", () => {
  const pages = readdirSync(RACINE).filter((nom) => nom.endsWith(".html"));
  for (const page of pages) {
    for (const match of lire(page).matchAll(/(?:href|src)="((?!https?:|mailto:|#)[^"#?]+)"/g)) {
      const cible = match[1].replace(/\/$/, "");
      if (!cible || cible.startsWith("//")) continue;
      assert.ok(
        existsSync(path.join(RACINE, cible)),
        `${page} référence ${match[1]} : introuvable`
      );
    }
  }
});

test("chaque page a un script et un titre, et le HTML reste équilibré", () => {
  const pages = readdirSync(RACINE).filter((nom) => nom.endsWith(".html"));
  for (const page of pages) {
    const html = lire(page);
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<html lang="fr">/);
    assert.match(html, /<title>[^<]*COLIS EXPRESS[^<]*<\/title>/);
    assert.match(html, /<meta name="viewport"/);
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1]);
    if (!PAGES_SANS_SCRIPT.has(page)) {
      assert.ok(scripts.length, `${page} n charge aucun script`);
      assert.ok(
        scripts.some((src) => src === entrees[page]),
        `${page} doit charger ${entrees[page]}`
      );
    }
    assert.equal(
      (html.match(/<form\b/g) || []).length,
      (html.match(/<\/form>/g) || []).length,
      `${page} : balises <form> déséquilibrées`
    );
  }
});

test("les liens vers la fiche colis portent leur paramètre et ne dépendent d'aucun redirect cleanUrls", () => {
  // Sur Vercel, « cleanUrls » redirige colis.html?id=X vers /colis en perdant la
  // query string : le bouton « Voir le colis » (reçu) et le lien « Voir »
  // (dashboard) ouvrent alors la fiche sans identifiant. La config doit rester
  // sans cleanUrls et les liens doivent rester en .html?paramètre.
  const vercel = JSON.parse(lire("vercel.json"));
  assert.notEqual(vercel.cleanUrls, true, "vercel.json ne doit pas activer cleanUrls : les liens .html?param perdraient leur query string");

  const dashboard = lire("js/dashboard.js");
  assert.match(dashboard, /href=\\?"colis\.html\?id=/, "le dashboard doit lier chaque colis vers colis.html?id=…");

  const page = lire("nouveau-colis.html");
  assert.match(page, /<a[^>]*id="viewSavedParcel"/, "« Voir le colis » doit être un lien réel (élément <a>)");
  const script = lire("js/nouveau-colis.js");
  assert.match(script, /viewSavedParcel/, "le reçu doit câbler le lien « Voir le colis »");
  assert.match(script, /colis\.html\?id=/, "le lien « Voir le colis » doit cibler colis.html?id=…");
  assert.doesNotMatch(script, /dataset\.parcelId/, "l'identifiant doit aller dans le href du lien, pas dans un dataset lu au clic");
});

test("les points d'entrée Vercel captent les routes API à un segment et imbriquées", () => {
  // Hors Next.js, Vercel convertit tout segment entre crochets
  // (« [param] », « [...param] », « [[...param]] ») en « ([^/]+) » : un seul
  // segment d'URL, jamais un catch-all multi-segments. Avec le seul
  // api/[...path].js, /api/health et /api/colis répondaient, mais
  // /api/colis/:id et /api/suivi/:code tombaient sur le 404 NOT_FOUND de la
  // plateforme sans jamais atteindre Express — fiche colis (« Voir le
  // colis », dashboard) et suivi QR en panne sur le site déployé, alors que
  // tout passait en local via server.js. Chaque forme de route imbriquée a
  // donc son fichier, qui réexporte la même application Express.
  // LOT 4 — mais le plan Hobby de Vercel limite un déploiement à 12 fonctions
  // serverless : avec un fichier par route imbriquée, on atteignait 19 et
  // CHAQUE déploiement échouait (« No more than 12 Serverless Functions… »).
  // Les routes à 3 segments sont donc repliées par les rewrites de
  // vercel.json sur la fonction parente (?action=…), et le premier
  // middleware de lib/app.js redéplie l'URL réelle avant le routage Express.
  assert.ok(existsSync(path.join(RACINE, "api/[...path].js")), "api/[...path].js doit exister (routes à un segment)");
  assert.ok(!existsSync(path.join(RACINE, "api/[[...path]].js")), "api/[[...path]].js ne capte qu'un seul segment hors Next.js : les routes imbriquées finissent en 404 plateforme");
  assert.ok(existsSync(path.join(RACINE, "api/plateforme.js")), "api/plateforme.js garantit le point d'entrée Vercel dédié de /api/plateforme");
  assert.match(lire("api/plateforme.js"), /lib\/app\.js/, "la fonction plateforme réutilise l'application Express");
  assert.match(lire("api/plateforme.js"), /deplierRequeteVercel/, "la fonction plateforme traite le ?action= et les en-têtes Vercel");
  assert.ok(existsSync(path.join(RACINE, "api/taches.js")), "api/taches.js fournit le point d'entrée parent pour le cron replié");
  assert.match(lire("api/taches.js"), /deplierRequeteVercel/, "le handler taches re-déplie ?action=");
  assert.match(lire("api/[...path].js"), /lib\/app\.js/, "le point d'entrée Vercel générique réutilise l'application Express");

  // Garde-fou : jamais plus de 12 fonctions serverless (limite Hobby).
  const fichiersApi = [];
  (function parcourir(dossier) {
    for (const entree of readdirSync(path.join(RACINE, dossier), { withFileTypes: true })) {
      const chemin = `${dossier}/${entree.name}`;
      if (entree.isDirectory()) parcourir(chemin);
      else if (entree.name.endsWith(".js")) fichiersApi.push(chemin);
    }
  })("api");
  assert.ok(fichiersApi.length <= 12, `plan Hobby : 12 fonctions serverless max, or api/ en contient ${fichiersApi.length} — replier les nouvelles routes imbriquées via les rewrites vercel.json (?action=…)`);

  // Les rewrites qui replient les routes à 3 segments sur leur fonction parente.
  const vercelJson = JSON.parse(lire("vercel.json"));
  const rewrites = vercelJson.rewrites ?? [];
  for (const [source, destination] of [
    ["/api/colis/:id/:action", "/api/colis/:id?action=:action"],
    ["/api/bordereaux/:id/:action", "/api/bordereaux/:id?action=:action"],
    ["/api/caisse/:action", "/api/caisse?action=:action"],
    ["/api/taches/:action", "/api/taches?action=:action"]
  ]) {
    assert.ok(
      rewrites.some((r) => r.source === source && r.destination === destination),
      `vercel.json doit replier ${source} vers ${destination} (limite Hobby de 12 fonctions)`
    );
  }
  // Le middleware qui redéplie ?action=… dans lib/app.js.
  assert.match(lire("lib/app.js"), /req\.query\?\.action/, "lib/app.js doit redéplier l'action des rewrites Vercel avant le routage");

  const entreesImbriquees = {
    "api/colis/[id].js": "../../lib/app.js",
    "api/suivi/[code].js": "../../lib/app.js",
    "api/agents/[id].js": "../../lib/app.js",
    "api/tarifs/[id].js": "../../lib/app.js",
    "api/clients/[id].js": "../../lib/app.js",
    "api/bordereaux/[id].js": "../../lib/app.js",
    "api/suivi-bordereau/[code].js": "../../lib/app.js",
    "api/incidents/[id].js": "../../lib/app.js",
    "api/photos/[id].js": "../../lib/app.js"
  };
  for (const [fichier, cible] of Object.entries(entreesImbriquees)) {
    assert.ok(existsSync(path.join(RACINE, fichier)), `${fichier} doit exister : sinon Vercel répond 404 NOT_FOUND sur cette route`);
    assert.ok(lire(fichier).includes(cible), `${fichier} doit réexporter ${cible} (l'application Express)`);
    // La profondeur du chemin relatif doit réellement tomber sur lib/app.js :
    // un « ../ » de trop fait sortir du dépôt et casse la fonction sur Vercel.
    assert.ok(
      existsSync(path.resolve(path.join(RACINE, fichier), "..", cible)),
      `${fichier} : ${cible} doit résoudre vers lib/app.js depuis son dossier`
    );
  }

  // Les routes imbriquées appelées par le front doivent exister côté Express.
  const api = lire("lib/app.js");
  for (const route of [
    "/api/colis/:id", "/api/colis/:id/attach", "/api/colis/:id/progress", "/api/suivi/:code",
    "/api/agents/:id", "/api/colis/:id/encaisser", "/api/tarifs/:id", "/api/caisse/cloture",
    "/api/clients/:id",
    "/api/bordereaux/:id", "/api/bordereaux/:id/remettre", "/api/bordereaux/:id/controle",
    "/api/suivi-bordereau/:code", "/api/colis/:id/incidents", "/api/colis/:id/photos",
    "/api/colis/:id/retour", "/api/incidents/:id", "/api/photos/:id"
  ]) {
    assert.ok(api.includes(route), `lib/app.js doit déclarer ${route} (captée par son point d'entrée Vercel)`);
  }
  assert.match(lire("js/colis.js"), /\/api\/colis\//, "la fiche colis appelle les routes imbriquées /api/colis/…");
  assert.match(lire("js/suivi.js"), /\/api\/suivi\//, "le suivi public (QR code du reçu) appelle /api/suivi/…");
});

test("les règles de protection sont rappelées dans le README", () => {
  const readme = lire("README.md");
  assert.match(readme, /DATABASE_URL/);
  assert.match(readme, /Neon/i);
  assert.match(readme, /rattachement/i);
  assert.match(readme, /npm test|npm run test/);
});

test("le LOT 1 (comptes agents) est câblé de bout en bout côté interface", () => {
  // Paramètres > Équipe : le gérant invite et active/désactive ses agents ;
  // l'agent désactivé est refusé côté serveur (couvert par tests/api.test.mjs).
  const html = lire("parametres.html");
  const script = lire("js/parametres.js");
  assert.match(html, /id="teamSection"/, "section Équipe présente dans Paramètres");
  assert.match(html, /id="agentForm"/, "formulaire d'invitation d'agent");
  for (const id of ["agentName", "agentEmail", "agentPhone", "agentPassword", "agentsList", "teamMessage", "saveAgentButton"]) {
    assert.match(html, new RegExp(`id="${id}"`), `parametres.html doit exposer #${id}`);
  }
  for (const id of ["agentForm", "agentsList", "teamMessage", "saveAgentButton"]) {
    assert.match(script, new RegExp(id), `js/parametres.js manipule #${id}`);
  }
  assert.match(script, /\/api\/agents/, "les actions équipe passent par l'API");
  assert.match(script, /"PATCH"/, "activation/désactivation par PATCH");
  // La session expose le membre connecté (gérant ou agent).
  assert.match(lire("js/auth.js"), /member/, "requireAgency remonte le membre connecté");
  assert.match(lire("js/layout.js"), /data-member-label/, "la barre latérale affiche l'agent connecté");
  // L'historique affiche l'acteur côté agence, jamais en public.
  assert.match(lire("js/utils.js"), /actorName/, "l'historique affiche l'acteur");
  const app = lire("lib/app.js");
  assert.match(app, /etapePublique/, "le suivi public projette les étapes via etapePublique (aucun acteur)");
  assert.match(app, /requireGerant/, "les écritures agents sont réservées au gérant côté serveur");
  // README : les comptes agents sont documentés.
  assert.match(lire("README.md"), /comptes agents|Agents/i, "le README documente les comptes agents");
});

test("le LOT 2 (tarifs, paiement, caisse) est câblé de bout en bout", () => {
  // Nouveau colis : prix par menu déroulant (grille) avec repli libre, récapitulatif,
  // et état de paiement saisi à l'enregistrement.
  const nouveauHtml = lire("nouveau-colis.html");
  const nouveauJs = lire("js/nouveau-colis.js");
  assert.match(nouveauHtml, /id="priceTarif"/, "menu déroulant du prix (grille tarifaire)");
  assert.match(nouveauHtml, /id="priceFCFA"/, "champ de repli en saisie libre");
  assert.match(nouveauHtml, /id="priceRecap"/, "récapitulatif avant validation");
  for (const nom of ["paymentStatus", "paidAmountFCFA", "paymentMode"]) {
    assert.match(nouveauHtml, new RegExp(`name="${nom}"`), `nouveau-colis.html doit exposer name="${nom}" (FormData)`);
  }
  assert.match(nouveauJs, /optionsPrix/, "le prix vient de js/metier-tarifs.js");
  assert.match(nouveauJs, /validerPaiement/, "l'état de paiement est validé avant envoi");
  assert.match(nouveauJs, /priceRecap/, "le récapitulatif est rendu côté client");

  // Fiche colis : encaissement du solde.
  assert.match(lire("colis.html"), /id="encaisserForm"/, "formulaire d'encaissement du solde");
  const colisJs = lire("js/colis.js");
  assert.match(colisJs, /\/encaisser/, "la fiche colis appelle /api/colis/:id/encaisser");
  assert.match(colisJs, /libelleEtatPaiement/, "la fiche colis affiche l'état de paiement");

  // Paramètres > Tarifs : CRUD de la grille.
  const parametresHtml = lire("parametres.html");
  const parametresJs = lire("js/parametres.js");
  assert.match(parametresHtml, /id="tarifForm"/, "formulaire de grille tarifaire");
  for (const id of ["tarifsList", "tarifMessage", "tarifOriginCity", "tarifDestinationCity", "tarifBand", "tarifPrice", "tarifSubmitButton", "tarifCancelButton"]) {
    assert.match(parametresHtml, new RegExp(`id="${id}"`), `parametres.html doit exposer #${id}`);
  }
  assert.match(parametresJs, /\/api\/tarifs/, "la grille passe par /api/tarifs");
  assert.match(parametresJs, /validerTarif/, "validation partagée de la grille");

  // Caisse du jour : page, navigation et export CSV.
  const caisseJs = lire("js/caisse.js");
  assert.match(caisseJs, /\/api\/caisse/, "la page caisse appelle /api/caisse");
  assert.match(caisseJs, /\/api\/caisse\/cloture/, "la clôture appelle /api/caisse/cloture");
  assert.match(caisseJs, /exporterCsv/, "l'export CSV est câblé");
  for (const colonne of ["date", "code", "expéditeur", "destinataire", "prix", "payé", "reste", "mode", "agent"]) {
    assert.ok(caisseJs.includes(colonne), `l'export CSV doit contenir la colonne « ${colonne} »`);
  }
  assert.match(lire("js/layout.js"), /caisse\.html/, "la barre latérale pointe vers caisse.html");

  // README documente le nouveau fonctionnement.
  const readme = lire("README.md");
  assert.match(readme, /grille tarifaire|Tarifs/i, "le README documente la grille tarifaire");
  assert.match(readme, /caisse/i, "le README documente la caisse");
});

test("le LOT 3 (carnet de clients + devis public) est câblé de bout en bout", () => {
  // Carnet de clients : page dédiée, recherche et formulaire.
  const clientsHtml = lire("clients.html");
  const clientsJs = lire("js/clients.js");
  for (const id of ["clientsList", "clientsCount", "searchClient", "kindFilter", "clientForm", "clientKind", "clientPhone", "clientFirstName", "clientLastName", "clientCni", "clientCity", "clientNotes", "clientDetail", "newClientButton"]) {
    assert.match(clientsHtml, new RegExp(`id="${id}"`), `clients.html doit exposer #${id}`);
  }
  assert.match(clientsJs, /\/api\/clients/, "le carnet passe par /api/clients");
  assert.match(clientsJs, /rechercherClients/, "la recherche utilise le module partagé");
  assert.match(clientsJs, /validerClient/, "la validation est partagée client/serveur");
  assert.match(clientsJs, /"PATCH"/, "la modification passe par PATCH");
  assert.match(lire("js/layout.js"), /clients\.html/, "la barre latérale pointe vers clients.html");

  // Mémorisation automatique côté serveur.
  const app = lire("lib/app.js");
  assert.match(app, /clientsDepuisColis/, "POST /api/colis mémorise expéditeur et destinataire");
  assert.match(app, /memoriserClient/, "l'upsert du carnet est mutualisé");

  // Pré-remplissage depuis le carnet sur « nouveau colis ».
  assert.match(lire("nouveau-colis.html"), /id="senderMatch"/, "zone de pré-remplissage expéditeur");
  assert.match(lire("nouveau-colis.html"), /id="recipientMatch"/, "zone de pré-remplissage destinataire");
  const nouveauJs = lire("js/nouveau-colis.js");
  assert.match(nouveauJs, /\/api\/clients/, "le formulaire interroge le carnet");
  assert.match(nouveauJs, /chercherClientConn/, "recherche par téléphone câblée");
  assert.match(nouveauJs, /prefill|pré-remplir/i, "le bouton de pré-remplissage existe");

  // Devis public sur la page d'accueil : anonyme, sans donnée personnelle.
  const index = lire("index.html");
  for (const id of ["devisForm", "devisOriginCity", "devisDestinationCity", "devisWeightKg", "devisNature", "devisResult", "devisMessage"]) {
    assert.match(index, new RegExp(`id="${id}"`), `index.html doit exposer #${id}`);
  }
  const publicJs = lire("js/public.js");
  assert.match(publicJs, /\/api\/devis/, "l'estimateur appelle /api/devis");
  assert.match(publicJs, /Contacter l'agence/, "chaque offre propose le contact WhatsApp de l'agence");
  assert.match(app, /app\.post\("\/api\/devis", async/, "la route devis est publique (sans requireAgency)");
  assert.match(app, /estimerDevis/, "le calcul du devis utilise le module partagé");
  assert.doesNotMatch(app, /app\.post\("\/api\/devis", requireAgency/, "le devis ne doit pas exiger de session");

  // README documente les nouveautés.
  const readme = lire("README.md");
  assert.match(readme, /carnet de clients|Carnet/i, "le README documente le carnet de clients");
  assert.match(readme, /devis/i, "le README documente le devis public");
});

test("le LOT 4 (bordereaux, photos, incidents, souffrance, alertes) est câblé de bout en bout", () => {
  // Bordereaux : page agence (liste + préparation + contrôle en cases à cocher)
  // et page publique sans données personnelles.
  const bordereauxHtml = lire("bordereaux.html");
  const bordereauxJs = lire("js/bordereaux.js");
  for (const id of ["bordereauxList", "bordereauForm", "carrierName", "carrierPhone", "vehicleRef", "destinationGroup", "embarquablesList", "bordereauDetail", "newBordereauButton"]) {
    assert.match(bordereauxHtml, new RegExp(`id="${id}"`), `bordereaux.html doit exposer #${id}`);
  }
  assert.match(bordereauxJs, /\/api\/bordereaux/, "la page bordereaux passe par l'API");
  assert.match(bordereauxJs, /\/remettre/, "l'émargement appelle /api/bordereaux/:id/remettre");
  assert.match(bordereauxJs, /\/controle/, "le contrôle d'arrivée appelle /api/bordereaux/:id/controle");
  assert.match(bordereauxJs, /validerCreationBordereau/, "la validation de création est partagée client/serveur");
  assert.match(bordereauxJs, /type="checkbox" name="present"/, "le contrôle d'arrivée se fait en cases à cocher");

  const bordereauPublicHtml = lire("bordereau.html");
  const bordereauPublicJs = lire("js/bordereau-public.js");
  assert.match(bordereauPublicHtml, /id="bordereauResult"/, "page publique bordereau.html?code=BDR-…");
  assert.match(bordereauPublicJs, /\/api\/suivi-bordereau\//, "le suivi public du bordereau appelle son API");
  assert.match(bordereauPublicJs, /BDR-\[A-Z0-9\]\{6\}/, "le code bordereau est validé au format BDR-XXXXXX");
  assert.match(bordereauxJs, /bordereau\.html\?code=|bordereauPublicUrl/, "le lien public est partageable (transporteur)");
  assert.match(lire("js/layout.js"), /bordereaux\.html/, "la barre latérale pointe vers bordereaux.html");

  // Photos : compression navigateur, 2 max/étape, jamais publiques ni supprimables.
  const photosJs = lire("js/photos.js");
  assert.match(photosJs, /compresserImage/, "la compression est faite côté navigateur (canvas)");
  assert.match(photosJs, /image\/jpeg/, "ré-encodage JPEG ~200 Ko");
  assert.match(photosJs, /MAX_PHOTOS_PAR_ETAPE = 2/, "2 photos maximum par étape");
  const colisJs = lire("js/colis.js");
  assert.match(colisJs, /\/photos/, "la fiche colis appelle les routes photos");
  assert.match(colisJs, /accept="image\/\*"|image\/\*/, "seules les images sont acceptées");
  const app = lire("lib/app.js");
  assert.match(app, /lib\/photos\.js|from "\.\/photos\.js"/, "le stockage est isolé derrière lib/photos.js");
  assert.match(lire("lib/photos.js"), /BLOB_READ_WRITE_TOKEN/, "Vercel Blob utilisé quand le jeton existe");
  assert.match(lire("lib/photos.js"), /PHOTOS_DIR/, "repli disque local pour dev/démo/tests");
  assert.doesNotMatch(app, /app\.delete\(/, "aucune route de suppression (photos comprises)");

  // Incidents : fiche colis (ouverture + recherches + résolution), bandeau sobre
  // sur le suivi public, escalade 24 h / 7 j.
  assert.match(colisJs, /\/incidents/, "la fiche colis appelle les routes incidents");
  assert.match(colisJs, /incidentResolution/, "la résolution d'un incident est tracée");
  const incidentsMetier = lire("js/metier-incidents.js");
  assert.match(incidentsMetier, /SEUIL_ALERTE_24H = 24/, "escalade > 24 h");
  assert.match(incidentsMetier, /SEUIL_FILE_PLATEFORME_JOURS = 7/, "file plateforme > 7 jours");
  assert.match(incidentsMetier, /BANDEAU_PUBLIC_INCIDENT/, "bandeau public sobre et fixe");
  assert.match(app, /bandeauPublicIncident/, "le suivi public projette le bandeau sans détail");
  assert.match(lire("js/suivi.js"), /tracking\.notice/, "le suivi public affiche le bandeau");

  // Souffrance + retour à l'expéditeur (frais de magasinage dans la caisse).
  assert.match(app, /\/api\/souffrance/, "liste des colis en souffrance");
  assert.match(app, /\/api\/colis\/:id\/retour/, "workflow retour à l'expéditeur");
  assert.match(app, /Frais de magasinage/, "les frais de magasinage alimentent la caisse");
  assert.match(colisJs, /retourForm/, "la décision de retour passe par la modale dédiée");
  assert.match(lire("colis.html"), /id="retourModal"/, "modale retour dans colis.html");
  assert.match(colisJs, /estEnSouffrance/, "le seuil de souffrance est partagé client/serveur");

  // Alertes « colis qui dorment » sur le tableau de bord.
  const dashboardHtml = lire("dashboard.html");
  const dashboardJs = lire("js/dashboard.js");
  for (const id of ["alertsPanel", "alertsList", "alertsCount"]) {
    assert.match(dashboardHtml, new RegExp(`id="${id}"`), `dashboard.html doit exposer #${id}`);
  }
  assert.match(dashboardJs, /\/api\/alertes/, "le tableau de bord appelle /api/alertes");
  assert.match(dashboardJs, /À traiter/, "cartes « À traiter »");
  const alertesMetier = lire("js/metier-alertes.js");
  assert.match(alertesMetier, /SEUIL_SANS_MOUVEMENT_H = 48/, "sans mouvement > 48 h");
  assert.match(alertesMetier, /SEUIL_NON_RETIRE_H = 72/, "non retiré > 72 h");
  assert.match(alertesMetier, /SEUIL_NON_RATTACHE_J = 7/, "non rattaché > 7 j");

  // README documente la chaîne de preuve.
  const readme = lire("README.md");
  assert.match(readme, /bordereau/i, "le README documente les bordereaux");
  assert.match(readme, /incident/i, "le README documente les incidents");
  assert.match(readme, /photo/i, "le README documente les photos de preuve");
});

test("le LOT 5 (notifications simulées, journal, deux agences, sans donnée personnelle) est câblé de bout en bout", () => {
  // Abstraction : UNE fonction d'envoi, transports branchables, simulation par défaut.
  const lib = lire("lib/notifications.js");
  assert.match(lib, /export async function envoyerNotification\(/, "une fonction d'envoi unique");
  assert.match(lib, /export async function notifier\(/, "notifier() calcule destinataires et messages");
  assert.match(lib, /simulation: \{/, "transport de simulation (par défaut)");
  for (const canal of ["whatsapp", "sms", "email"]) {
    assert.match(lib, new RegExp(`${canal}: \\{`), `point de branchement prévu pour ${canal}`);
  }
  assert.match(lib, /NOTIFICATIONS_CANAL/, "le canal se choisit par variable d'environnement");
  assert.match(lib, /ON CONFLICT \(dedup_key\) DO NOTHING/, "dédoublonnage atomique (une notification par événement et par agence)");

  // Chaque événement de la chaîne de preuve passe par notifier().
  const app = lire("lib/app.js");
  for (const type of ["incident_ouvert", "bordereau_arrive", "bordereau_ecart", "retour_decide", "retour_recu"]) {
    assert.match(app, new RegExp(`"${type}"`), `lib/app.js notifie l'événement ${type}`);
  }
  assert.match(app, /balayerEcheances\(/, "escalade 24 h, souffrance et colis qui dorment sont balayés au fil de l'eau");
  assert.match(app, /app\.get\("\/api\/notifications"/, "journal consultable");
  assert.match(app, /app\.post\("\/api\/notifications\/lecture"/, "marquer comme lu");
  assert.doesNotMatch(app, /app\.delete\(/, "aucune suppression : on marque lu");

  // Métier partagé : mêmes seuils que les cartes « À traiter ».
  const metier = lire("js/metier-notifications.js");
  assert.match(metier, /evaluerAlertes/, "les seuils des colis qui dorment sont partagés avec le tableau de bord");
  assert.match(metier, /escaladeIncident/, "l'escalade 24 h est partagée avec les incidents");

  // Schéma additif et idempotent.
  const schema = lire("db/schema.sql");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS notifications/);
  assert.match(schema, /dedup_key\s+TEXT NOT NULL UNIQUE/);

  // Vercel Hobby : aucune nouvelle fonction, la route à 3 segments est repliée.
  const rewrites = JSON.parse(lire("vercel.json")).rewrites ?? [];
  assert.ok(
    rewrites.some((r) => r.source === "/api/notifications/:action" && r.destination === "/api/notifications?action=:action"),
    "vercel.json doit replier /api/notifications/:action vers /api/notifications?action=:action"
  );
  assert.ok(!existsSync(path.join(RACINE, "api/notifications")), "pas de fichier api/ dédié : /api/notifications passe par api/[...path].js");

  // Interface : page journal + lien de la barre latérale avec compteur de non lues.
  const html = lire("notifications.html");
  for (const id of ["notifList", "notifCount", "notifFamille", "notifNonLuesSeulement", "toutLireButton", "notifMode"]) {
    assert.match(html, new RegExp(`id="${id}"`), `notifications.html doit exposer #${id}`);
  }
  const js = lire("js/notifications.js");
  assert.match(js, /\/api\/notifications/, "la page lit le journal par l'API");
  assert.match(js, /\/api\/notifications\/lecture/, "la page marque les notifications comme lues");
  assert.match(js, /filtrerNotifications/, "filtres partagés client/serveur");
  const layout = lire("js/layout.js");
  assert.match(layout, /notifications\.html/, "la barre latérale pointe vers notifications.html");
  assert.match(layout, /resume=1/, "compteur léger des non lues sur chaque page");

  // Démo : journal pré-rempli et bordereau en écart.
  const seed = lire("db/db.js");
  assert.match(seed, /INSERT INTO notifications/, "le seed de démo pré-remplit le journal");
  assert.match(seed, /BDR-DEMO03/, "un bordereau en écart illustre la notification d'écart");

  // README et docs.
  const readme = lire("README.md");
  assert.match(readme, /notifications/i, "le README documente les notifications");
  assert.match(readme, /NOTIFICATIONS_CANAL/, "le README documente la variable de canal");
  assert.match(readme, /simulation/i, "le README documente le mode simulation");
  assert.match(lire("docs/architecture.md"), /LOT 5/, "docs/architecture.md documente le LOT 5");
});

test("le LOT 6 (plans, quotas, portefeuille, console plateforme) est câblé de bout en bout", () => {
  // Règles partagées : les tarifs du cahier des charges.
  const metier = lire("js/metier-plans.js");
  assert.match(metier, /PRIX_DEPASSEMENT_FCFA = 30/, "dépassement : 30 FCFA par colis");
  assert.match(metier, /quotaMensuel: 50/, "Gratuit : 50 colis par mois");
  assert.match(metier, /prixMensuelFCFA: 10_000/, "Pro : 10 000 FCFA par mois");
  assert.match(metier, /quotaMensuel: 500/, "Pro : 500 colis inclus");
  assert.match(metier, /surDevis: true/, "Réseau : sur devis");

  // Serveur : la facturation n'est consultée qu'à la CRÉATION d'un colis.
  const app = lire("lib/app.js");
  assert.equal((app.match(/reserverCreation\(/g) || []).length, 1, "un seul point de contrôle du quota (POST /api/colis)");
  const creation = app.slice(app.indexOf('app.post("/api/colis"'), app.indexOf('app.get("/api/colis/:id"'));
  assert.match(creation, /reserverCreation\(/, "le contrôle du quota est dans POST /api/colis");
  for (const route of [
    'app.get("/api/facturation"', 'app.post("/api/facturation/plan"', 'app.post("/api/facturation/abonnement"',
    'app.post("/api/plateforme/connexion"', 'app.post("/api/plateforme/deconnexion"', 'app.get("/api/plateforme"',
    'app.post("/api/plateforme/plan"', 'app.post("/api/plateforme/credit"'
  ]) {
    assert.ok(app.includes(route), `lib/app.js doit déclarer ${route}`);
  }
  assert.match(app, /requireGerantFacturation/, "changement d'abonnement réservé au gérant (garde serveur)");
  assert.match(app, /requirePlateforme/, "console protégée côté serveur");
  assert.doesNotMatch(app, /app\.delete\(/, "aucune suppression (journal du portefeuille immuable)");

  // Session plateforme séparée, débit atomique, solde jamais négatif.
  const auth = lire("lib/auth.js");
  assert.match(auth, /ce_plateforme/, "cookie distinct de celui des agences");
  assert.match(auth, /SameSite=Strict/);
  assert.match(auth, /DOMAINE_PLATEFORME/, "domaine de signature distinct");
  assert.match(lire("lib/facturation.js"), /portefeuille_fcfa >= \$2/, "débit conditionnel (prépayé)");
  const schema = lire("db/schema.sql");
  assert.match(schema, /CHECK \(portefeuille_fcfa >= 0\)/, "contrainte : jamais de solde négatif");
  for (const table of ["facturation_periodes", "portefeuille_mouvements", "plateforme_admins"]) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `table ${table} (migration idempotente)`);
  }

  // Vercel Hobby : routes à 2 segments repliées, aucune nouvelle fonction.
  const rewrites = JSON.parse(lire("vercel.json")).rewrites ?? [];
  for (const parent of ["facturation", "plateforme"]) {
    assert.ok(
      rewrites.some((r) => r.source === `/api/${parent}/:action` && r.destination === `/api/${parent}?action=:action`),
      `vercel.json doit replier /api/${parent}/:action`
    );
    assert.ok(!existsSync(path.join(RACINE, `api/${parent}`)), `pas de fichier api/${parent} : la route passe par api/[...path].js`);
  }

  // Interface agence : page Abonnement, lien de la barre latérale, rappel du quota.
  const abonnementHtml = lire("abonnement.html");
  for (const id of ["planActuel", "compteurColis", "soldePortefeuille", "statutAbonnement", "quotaBar", "plansGrid", "echeancesList", "mouvementsList", "periodesList"]) {
    assert.match(abonnementHtml, new RegExp(`id="${id}"`), `abonnement.html doit exposer #${id}`);
  }
  assert.match(abonnementHtml, /ne paie jamais pour les colis qu'elle reçoit/, "la règle « la destination ne paie jamais » est affichée");
  const abonnementJs = lire("js/abonnement.js");
  for (const appel of ["/api/facturation", "/api/facturation/plan", "/api/facturation/abonnement"]) {
    assert.ok(abonnementJs.includes(appel), `js/abonnement.js appelle ${appel}`);
  }
  assert.match(lire("js/layout.js"), /abonnement\.html/, "la barre latérale pointe vers abonnement.html");
  assert.match(lire("nouveau-colis.html"), /id="quotaNotice"/, "rappel du quota sur le formulaire");
  assert.match(lire("js/nouveau-colis.js"), /\/api\/facturation\?resume=1/);

  // Console plateforme : page autonome, non indexée, absente de l'interface agence.
  const consoleHtml = lire("plateforme.html");
  for (const id of ["loginPanel", "consolePanel", "fileList", "litigesList", "agencesList", "volumesList", "planForm", "creditForm"]) {
    assert.match(consoleHtml, new RegExp(`id="${id}"`), `plateforme.html doit exposer #${id}`);
  }
  assert.match(consoleHtml, /noindex/);
  const consoleJs = lire("js/plateforme.js");
  for (const appel of ["/api/plateforme", "/api/plateforme/connexion", "/api/plateforme/deconnexion", "/api/plateforme/plan", "/api/plateforme/credit"]) {
    assert.ok(consoleJs.includes(appel), `js/plateforme.js appelle ${appel}`);
  }
  assert.doesNotMatch(lire("js/layout.js"), /plateforme\.html/, "la console n'apparaît pas dans l'interface agence");

  // Compte plateforme de production : variables d'environnement, aucun secret dans le code.
  const script = lire("db/plateforme-admin.js");
  assert.match(script, /PLATEFORME_ADMIN_MOT_DE_PASSE/);
  assert.doesNotMatch(script, /demo1234/);
  assert.match(JSON.parse(lire("package.json")).scripts["plateforme-admin"], /db\/plateforme-admin\.js/);
  assert.ok(existsSync(path.join(RACINE, "db/init-db.js")), "npm run init-db (documenté) existe");

  // Démo : Bouaké proche du quota, Abidjan en Pro, litige > 7 j, compte plateforme.
  const seed = lire("db/db.js");
  assert.match(seed, /COMPTEUR_BOUAKE = 48/);
  assert.match(seed, /plateforme@colisexpress\.ci/);
  assert.match(seed, /'conteste', 'recherches'/);

  // README et docs.
  const readme = lire("README.md");
  assert.match(readme, /Gratuit/);
  assert.match(readme, /portefeuille/i);
  assert.match(readme, /console plateforme/i);
  assert.match(readme, /plateforme-admin/);
  assert.match(lire("docs/architecture.md"), /LOT 6/);
});

test("le LOT 7 (suivi personnalisé par agence + paiements SasPay) est câblé de bout en bout", () => {
  // Abstraction SasPay : contrats de la documentation officielle, clé côté serveur.
  const lib = lire("lib/paiements.js");
  assert.match(lib, /https:\/\/api\.saspay\.me\/api\/v1/, "base URL SasPay");
  assert.match(lib, /"\/checkout-sessions\/"/, "paiement hébergé : POST /checkout-sessions/");
  assert.match(lib, /\/checkout-sessions\/\$\{encodeURIComponent\(id\)\}\/status\//, "statut de session");
  assert.match(lib, /\/payments\/\$\{encodeURIComponent\(transactionId\)\}\/verify\//, "vérification de la transaction");
  assert.match(lib, /Authorization: `Bearer \$\{cle\}`/, "clé secrète en Bearer, côté serveur");
  assert.match(lib, /SASPAY_SECRET_KEY/);
  assert.match(lib, /SASPAY_WEBHOOK_SECRET|secret de signature/);
  assert.match(lib, /timingSafeEqual/, "signature comparée en temps constant");
  assert.match(lib, /TOLERANCE_WEBHOOK_S = 300/, "anti-rejeu : ± 300 s");
  assert.match(lib, /client: \{ nom: agency\.name, email: agency\.email \}/, "le client de la session est l'agence (aucune donnée client)");
  assert.doesNotMatch(lib, /sk_(test|live)_[A-Za-z0-9]{6,}/, "aucune clé réelle dans le code");
  assert.match(lib, /mode: "simulation"/, "mode simulation sans clé");

  const app = lire("lib/app.js");
  for (const route of [
    'app.get("/api/paiements"', 'app.post("/api/paiements"', 'app.post("/api/paiements/verifier"',
    'app.post("/api/paiements/simulation"', 'app.post("/api/paiements/webhook"',
    'app.get("/api/marque"', 'app.put("/api/marque"', 'app.get("/api/suivi/:code/logo"'
  ]) {
    assert.ok(app.includes(route), `lib/app.js doit déclarer ${route}`);
  }
  assert.match(app, /corpsBrut/, "corps brut conservé pour la signature du webhook");
  assert.match(app, /verifierSignatureWebhook\(/);
  assert.match(app, /marquePublique\(/, "le suivi public projette la marque (sans contact)");
  assert.doesNotMatch(app, /app\.delete\(/);

  const schema = lire("db/schema.sql");
  for (const table of ["paiements_en_ligne", "paiements_webhooks"]) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `table ${table}`);
  }
  assert.match(schema, /marque_couleur ~ '\^#\[0-9a-f\]\{6\}\$'/, "couleurs contrôlées en base");
  assert.match(schema, /effet_applique/, "application unique d'un paiement");

  // Vercel Hobby : routes repliées, aucune nouvelle fonction.
  const rewrites = JSON.parse(lire("vercel.json")).rewrites ?? [];
  for (const [source, destination] of [
    ["/api/paiements/:action", "/api/paiements?action=:action"],
    ["/api/suivi/:code/:action", "/api/suivi/:code?action=:action"]
  ]) {
    assert.ok(rewrites.some((r) => r.source === source && r.destination === destination), `vercel.json doit replier ${source}`);
  }
  for (const dossier of ["api/paiements", "api/marque"]) {
    assert.ok(!existsSync(path.join(RACINE, dossier)), `pas de fichier ${dossier} : la route passe par api/[...path].js`);
  }

  // Interface : suivi habillé, réglages, paiement du reste, de l'abonnement, recharge.
  const suivi = lire("js/suivi.js");
  assert.match(suivi, /variablesMarque/, "couleurs revalidées avant l'attribut style");
  assert.match(suivi, /\/logo\?v=/, "logo public servi par /api/suivi/:code/logo");
  const parametres = lire("parametres.html");
  for (const id of ["marqueForm", "marqueActive", "marqueNom", "marqueCouleur", "marqueCouleur2", "marqueLogo", "marqueApercu"]) {
    assert.match(parametres, new RegExp(`id="${id}"`), `parametres.html doit exposer #${id}`);
  }
  assert.match(lire("js/parametres-marque.js"), /method: "PUT"/);
  const abonnement = lire("js/abonnement.js");
  assert.match(abonnement, /objet: "abonnement"/);
  assert.match(abonnement, /objet: "recharge"/);
  assert.match(abonnement, /\/api\/paiements\/verifier/, "retour de paiement vérifié côté serveur");
  assert.match(lire("paiement-simulation.html"), /SIMULATION/);
  assert.match(lire("js/paiement-simulation.js"), /\/api\/paiements\/simulation/);

  // Démo : suivi habillé pour Abidjan (logo généré), défaut pour Bouaké.
  const seed = lire("db/db.js");
  assert.match(seed, /logoDemoPng/);
  assert.match(seed, /marque_active = TRUE/);

  // README et docs.
  const readme = lire("README.md");
  for (const motif of [/SasPay/, /SASPAY_SECRET_KEY/, /SASPAY_WEBHOOK_SECRET/, /suivi personnalisé/i, /simulation/i]) {
    assert.match(readme, motif);
  }
  assert.match(lire("docs/architecture.md"), /LOT 7/);
});

test("le LOT 8 (sécurité avant la mise en production) est câblé de bout en bout", () => {
  // a) Plus aucun paiement en ligne des colis : ni bouton, ni appel depuis la fiche colis.
  const colis = lire("js/colis.js");
  assert.doesNotMatch(colis, /payerEnLigne|Payer en ligne|SasPay/, "la fiche colis ne propose plus de paiement en ligne");
  assert.doesNotMatch(colis, /objet: "colis"/);
  assert.match(colis, /openEncaisser/, "l'encaissement au guichet reste");
  assert.doesNotMatch(lire("colis.html"), /Payer en ligne/);
  const metier = lire("js/metier-paiements.js");
  assert.match(metier, /OBJETS_PAIEMENT_CREATION = Object\.freeze\(\["abonnement", "recharge"\]\)/);
  assert.match(metier, /OBJETS_PAIEMENT = Object\.freeze\(\["colis", "abonnement", "recharge"\]\)/, "l'historique reconnaît encore l'objet colis");
  assert.match(lire("js/paiement-simulation.js"), /abonnement\.html/);
  assert.doesNotMatch(lire("js/paiement-simulation.js"), /\(colis\|abonnement\)/);
  const api = lire("lib/app.js");
  assert.match(api, /controle\.status \?\? 400/, "403 métier sur l'objet colis");
  assert.match(lire("db/schema.sql"), /objet IN \('colis', 'abonnement', 'recharge'\)/, "aucune migration destructive : les lignes historiques restent valides");

  // b) et c) Garde-fous SasPay et mode de frais.
  const paiements = lire("lib/paiements.js");
  assert.match(paiements, /VERCEL_ENV/);
  assert.match(paiements, /SASPAY_MODE_FRAIS/);
  assert.match(paiements, /fee_charge_mode: modeFrais/);
  assert.match(metier, /debited_amount/);
  assert.match(metier, /net_amount/);

  // d) Sessions : jamais de secret de secours hors démo locale.
  const auth = lire("lib/auth.js");
  assert.match(auth, /LONGUEUR_MIN_SECRET_SESSION = 32/);
  assert.match(auth, /ErreurConfigurationSession/);
  assert.match(auth, /secretSessionExige/);
  assert.match(api, /verifierSecretSession\(\)/);
  assert.match(api, /instanceof ErreurConfigurationSession/);

  // e) Amorçage du premier administrateur : routes repliées, UI, aucune nouvelle fonction api/.
  for (const route of ['app.get("/api/plateforme/amorcage"', 'app.post("/api/plateforme/amorcage"']) {
    assert.ok(api.includes(route), `lib/app.js doit déclarer ${route}`);
  }
  assert.ok(!existsSync(path.join(RACINE, "api/plateforme")), "aucun nouveau fichier api/ (limite Hobby)");
  const plateforme = lire("lib/plateforme.js");
  assert.match(plateforme, /PLATEFORME_PREMIER_ADMIN_JETON/);
  assert.match(plateforme, /timingSafeEqual/, "jeton comparé en temps constant");
  assert.match(plateforme, /ON CONFLICT \(cle\) DO NOTHING/, "création atomique");
  assert.match(lire("db/schema.sql"), /CREATE TABLE IF NOT EXISTS plateforme_amorcage/);
  const html = lire("plateforme.html");
  for (const id of ["amorcagePanel", "amorcageForm", "amorcageJeton", "amorcageEmail", "amorcageNom", "amorcagePassword", "amorcageButton"]) {
    assert.match(html, new RegExp(`id="${id}"`), `plateforme.html doit exposer #${id}`);
  }
  assert.match(lire("js/plateforme.js"), /\/api\/plateforme\/amorcage/);
  assert.match(lire("package.json"), /"plateforme-admin": "node db\/plateforme-admin.js"/, "le script reste disponible");

  // Docs.
  const readme = lire("README.md");
  for (const motif of [/PLATEFORME_PREMIER_ADMIN_JETON/, /SASPAY_MODE_FRAIS/, /SESSION_SECRET/, /n'encaisse jamais/i]) assert.match(readme, motif);
  assert.match(lire("docs/architecture.md"), /LOT 8/);
  assert.match(lire("docs/ameliorations.md"), /LOT 8/);
  assert.match(lire("docs/ameliorations.md"), /clé SasPay par agence/i, "option future notée");
});

test("le LOT 9 (mise en service assistée) est câblé de bout en bout", () => {
  // Guide pas à pas pour non-développeur, avec tableau des variables sans valeur réelle.
  const guide = lire("docs/mise-en-service.md");
  for (const motif of [
    /BLOB_READ_WRITE_TOKEN/, /branche Neon|Branches/, /Schema only/i, /SESSION_SECRET/, /PLATEFORME_PREMIER_ADMIN_JETON/,
    /KYC/, /sk_test_/, /sk_live_/, /\/api\/paiements\/webhook/, /transaction\.success/, /transaction\.failed/, /transaction\.cancelled/,
    /SASPAY_WEBHOOK_SECRET/, /APP_URL/, /SASPAY_MODE_FRAIS/, /CRON_SECRET/, /WHATSAPP_TOKEN/, /ORANGE_SMS_CLIENT_ID/,
    /crypto\.randomUUID\(\) \+ crypto\.randomUUID\(\)/, /## Tableau des variables/, /Vérifications finales/
  ]) {
    assert.match(guide, motif, `docs/mise-en-service.md doit mentionner ${motif}`);
  }
  assert.doesNotMatch(guide, /sk_live_[A-Za-z0-9]{8,}|postgresql:\/\/[^\s…]+:[^\s…]+@/, "aucune valeur réelle dans le guide");

  // Panneau console en lecture seule, route repliée, aucun nouveau fichier api/.
  const api = lire("lib/app.js");
  assert.ok(api.includes('app.get("/api/plateforme/mise-en-service"'), "route du panneau");
  assert.doesNotMatch(api, /app\.(post|put|patch)\("\/api\/plateforme\/mise-en-service"/, "lecture seule");
  assert.ok(!existsSync(path.join(RACINE, "api/plateforme")), "aucun nouveau fichier api/");
  const lib = lire("lib/mise-en-service.js");
  for (const motif of [/empreinteHoteBase/, /sha256/, /etatSecretSession/, /configurationPaiements/, /configurationNotifications/, /paiements_webhooks/, /taches_executions/, /SEUIL_ALERTE_QUOTA = 0\.8/]) {
    assert.match(lib, motif);
  }
  assert.doesNotMatch(lib, /env\.SASPAY_SECRET_KEY|env\.SESSION_SECRET\b(?!\s*\?\?)/, "le module ne manipule pas les valeurs de secret");
  assert.match(lire("db/schema.sql"), /CREATE TABLE IF NOT EXISTS taches_executions/);
  const html = lire("plateforme.html");
  for (const id of ["miseEnServicePanel", "miseEnServiceResume", "miseEnServiceList"]) {
    assert.match(html, new RegExp(`id="${id}"`), `plateforme.html doit exposer #${id}`);
  }
  assert.match(lire("js/plateforme.js"), /\/api\/plateforme\/mise-en-service/);
  assert.match(lire("README.md"), /mise-en-service\.md/);
  assert.match(lire("docs/architecture.md"), /LOT 9/);
  assert.match(lire("docs/ameliorations.md"), /LOT 9/);
});

test("le LOT 11 (tâche quotidienne Vercel Cron) est câblé de bout en bout", () => {
  const vercel = JSON.parse(lire("vercel.json"));
  assert.deepEqual(vercel.crons, [{ path: "/api/taches/quotidienne", schedule: "0 5 * * *" }]);
  assert.ok(vercel.rewrites.some((r) => r.source === "/api/taches/:action" && r.destination === "/api/taches?action=:action"));
  assert.ok(existsSync(path.join(RACINE, "api/taches.js")));
  assert.doesNotMatch(lire("api/taches.js"), /quotidienne\.js/, "aucune fonction ajoutée pour la route à trois segments");

  const api = lire("lib/app.js");
  assert.match(api, /app\.get\("\/api\/taches\/quotidienne"/);
  assert.match(api, /verifierAutorisationCron\(req\)/);
  assert.match(api, /timingSafeEqual/, "CRON_SECRET comparée en temps constant");
  assert.match(api, /app\.(get|post)\("\/api\/plateforme\/taches"/);
  const taches = lire("lib/taches-quotidiennes.js");
  for (const motif of [/balayerEcheances/, /ouvrirPeriode/, /niveauRappelAbonnement/, /taches_executions/, /LIMIT 10/]) assert.match(taches, motif);
  assert.match(lire("js/metier-notifications.js"), /abonnement_jmoins2/);
  assert.match(lire("js/metier-notifications.js"), /abonnement_echeance/);
  assert.match(lire("js/metier-notifications.js"), /abonnement_retard/);

  const html = lire("plateforme.html");
  for (const id of ["tachesQuotidiennesPanel", "executerTacheButton", "tachesExecutions"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(lire("js/plateforme.js"), /\/api\/plateforme\/taches/);
  assert.match(lire("lib/mise-en-service.js"), /05:00 UTC/);
  assert.match(lire("docs/mise-en-service.md"), /CRON_SECRET/);
  assert.match(lire("README.md"), /tâche quotidienne/i);
  assert.match(lire("docs/architecture.md"), /LOT 11/);
  assert.match(lire("docs/ameliorations.md"), /LOT 11/);
});

test("le LOT 12 (WhatsApp Cloud, Orange SMS, repli simulation et panneau console) est câblé", () => {
  const notifications = lire("lib/notifications.js");
  assert.match(notifications, /export async function envoyerWhatsApp/);
  assert.match(notifications, /graph\.facebook\.com/);
  assert.match(notifications, /WHATSAPP_TOKEN/);
  assert.match(notifications, /WHATSAPP_PHONE_ID/);
  assert.match(notifications, /export async function envoyerSmsOrange/);
  assert.match(notifications, /api\.orange\.com\/oauth\/v3\/token/);
  assert.match(notifications, /ORANGE_SMS_CLIENT_ID/);
  assert.match(notifications, /ORANGE_SMS_CLIENT_SECRET/);
  assert.match(notifications, /candidat === "sms"|\["whatsapp", "sms"\]/, "WhatsApp est tenté avant Orange SMS");
  assert.match(notifications, /canal = "simulation"/, "simulation en dernier repli");
  assert.match(notifications, /Authorization: `Bearer \${c\.token}`/, "jeton Meta envoyé seulement au fournisseur");
  assert.match(notifications, /Buffer\.from\(`\$\{c\.clientId\}:\$\{c\.clientSecret\}`\)/, "Orange utilise OAuth client credentials");

  const api = lire("lib/app.js");
  assert.match(api, /app\.get\("\/api\/plateforme\/notifications"/);
  assert.match(api, /SELECT type, titre, message, canal, statut, erreur, created_at_iso/);
  assert.doesNotMatch(api.match(/app\.get\("\/api\/plateforme\/notifications"[\s\S]*?\n  }\);/)?.[0] || "", /phone|email|client_secret|WHATSAPP_TOKEN/i, "projection console sans contacts ni valeurs de secrets");

  const html = lire("plateforme.html");
  for (const id of ["transportsNotificationsPanel", "transportsNotificationsEtat", "transportsNotificationsDetail", "transportsNotificationsListe"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(lire("js/plateforme.js"), /\/api\/plateforme\/notifications/);
  assert.match(lire("js/metier-notifications.js"), /abonnement_jmoins2/, "les rappels d'abonnement restent dans le catalogue métier");
  assert.match(lire("docs/mise-en-service.md"), /WHATSAPP_TOKEN/);
  assert.match(lire("docs/mise-en-service.md"), /ORANGE_SMS_CLIENT_SECRET/);
  assert.match(lire("docs/architecture.md"), /LOT 12/);
  assert.match(lire("docs/ameliorations.md"), /LOT 12/);
  assert.ok(!existsSync(path.join(RACINE, "api/notifications.js")), "aucune fonction Vercel supplémentaire");
});

test("le LOT 13 (relevés PDF mensuels) est câblé sans nouvelle fonction Vercel", () => {
  const app = lire("lib/app.js");
  assert.match(app, /app\.get\("\/api\/facturation\/releve"/);
  assert.match(app, /app\.get\("\/api\/plateforme\/releve"/);
  assert.match(app, /repondrePDFReleve/);
  assert.ok(!existsSync(path.join(RACINE, "api/releves.js")), "route PDF repliée, aucun point d'entrée supplémentaire");
  assert.match(lire("lib/releves.js"), /releves_mensuels/);
  assert.match(lire("lib/releves.js"), /ON CONFLICT \(agency_id, periode\) DO NOTHING/);
  assert.match(lire("lib/pdf.js"), /WinAnsiEncoding/);
  assert.doesNotMatch(lire("lib/pdf.js"), /from ["'](?:pdfkit|puppeteer|playwright)|require\(["'](?:pdfkit|puppeteer|playwright)/i, "PDF produit sans bibliothèque native ni navigateur headless");
  assert.match(lire("db/schema.sql"), /CREATE TABLE IF NOT EXISTS releves_mensuels/);
  assert.match(lire("lib/taches-quotidiennes.js"), /archiverRelevesMensuels/);
  assert.match(lire("lib/taches-quotidiennes.js"), /getUTCDate\(\) === 1/, "archive mensuelle le premier jour du mois");

  const abonnement = lire("abonnement.html");
  for (const id of ["relevesPanel", "releveForm", "relevePeriode", "telechargerReleveButton"]) assert.match(abonnement, new RegExp(`id="${id}"`));
  assert.match(lire("js/abonnement.js"), /\/api\/facturation\/releve/);
  const consoleHtml = lire("plateforme.html");
  for (const id of ["releveAgencePanel", "releveMoisConsole", "telechargerReleveConsole"]) assert.match(consoleHtml, new RegExp(`id="${id}"`));
  assert.match(lire("js/plateforme.js"), /\/api\/plateforme\/releve/);
  assert.match(lire("README.md"), /relevés mensuels PDF/i);
  assert.match(lire("docs/architecture.md"), /LOT 13/);
  assert.match(lire("docs/ameliorations.md"), /LOT 13/);
  assert.match(lire("docs/mise-en-service.md"), /relevés mensuels PDF/i);
});

test("le LOT 10 (compteur de colis en temps réel) est câblé de bout en bout", () => {
  // Une route légère, lecture seule, sans nouveau fichier api/.
  const api = lire("lib/app.js");
  assert.ok(api.includes('app.get("/api/resume"'), "route /api/resume");
  assert.doesNotMatch(api, /app\.(post|put|patch)\("\/api\/resume"/, "lecture seule");
  assert.ok(!existsSync(path.join(RACINE, "api/resume.js")), "aucun nouveau fichier api/");
  assert.match(api, /compteur = await resumeCompteur\(req\.agency\.id\)/, "POST /api/colis renvoie le compteur à jour");

  // Logique d'affichage partagée et testée dans js/metier-plans.js.
  const metier = lire("js/metier-plans.js");
  for (const motif of [/export function affichageCompteur/, /export function phraseProchainColis/, /SEUIL_ALERTE_COMPTEUR = 0\.8/]) assert.match(metier, motif);

  // Barre latérale + en-tête mobile : rafraîchissement 20 s onglet visible, retour sur l'onglet, BroadcastChannel.
  const layout = lire("js/layout.js");
  for (const motif of [/data-compteur/, /data-compteur-court/, /INTERVALLE_RESUME_MS = 20000/, /BroadcastChannel/, /visibilitychange/, /\/api\/resume/, /export function diffuserCompteur/, /export function surCompteur/]) {
    assert.match(layout, motif);
  }
  assert.doesNotMatch(layout, /new (WebSocket|EventSource)\(/, "pas de WebSocket ni de SSE (Vercel Hobby)");

  // Tableau de bord : carte « Mon forfait » ; formulaire : ligne permanente du prochain colis.
  const dashboard = lire("dashboard.html");
  for (const id of ["forfaitCard", "forfaitChiffre", "forfaitBarre", "forfaitDetail", "forfaitRecharger"]) assert.ok(dashboard.includes(`id="${id}"`), id);
  assert.match(lire("js/dashboard.js"), /surCompteur\(/);
  assert.ok(lire("nouveau-colis.html").includes('id="prochainColis"'));
  const nouveau = lire("js/nouveau-colis.js");
  assert.match(nouveau, /phraseProchainColis/);
  assert.match(nouveau, /diffuserCompteur\(compteur\)/, "le compteur renvoyé par POST /api/colis est diffusé");

  // Console : barre par agence, rafraîchissement 30 s.
  const console_ = lire("js/plateforme.js");
  assert.match(console_, /affichageCompteur/);
  assert.match(console_, /console-quota/);
  assert.match(console_, /30_000/);
  const css = lire("assets/css/style.css");
  for (const classe of [".compteur-colis", ".compteur-barre", ".forfait-card", ".prochain-colis", ".console-quota"]) assert.ok(css.includes(classe), classe);
  assert.match(lire("README.md"), /LOT 10/);
  assert.match(lire("docs/architecture.md"), /LOT 10/);
  assert.match(lire("docs/ameliorations.md"), /LOT 10/);
});
