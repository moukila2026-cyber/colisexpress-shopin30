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
  "bordereau.html": "js/bordereau-public.js"
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
  assert.ok(existsSync(path.join(RACINE, "api/[...path].js")), "api/[...path].js doit exister (routes à un segment)");
  assert.ok(!existsSync(path.join(RACINE, "api/[[...path]].js")), "api/[[...path]].js ne capte qu'un seul segment hors Next.js : les routes imbriquées finissent en 404 plateforme");
  assert.match(lire("api/[...path].js"), /lib\/app\.js/, "le point d'entrée Vercel doit exporter l'application Express");

  const entreesImbriquees = {
    "api/colis/[id].js": "../../lib/app.js",
    "api/colis/[id]/attach.js": "../../../lib/app.js",
    "api/colis/[id]/progress.js": "../../../lib/app.js",
    "api/suivi/[code].js": "../../lib/app.js",
    "api/agents/[id].js": "../../../lib/app.js",
    "api/colis/[id]/encaisser.js": "../../../lib/app.js",
    "api/tarifs/[id].js": "../../lib/app.js",
    "api/caisse/cloture.js": "../../lib/app.js",
    "api/clients/[id].js": "../../lib/app.js",
    "api/bordereaux/[id].js": "../../lib/app.js",
    "api/bordereaux/[id]/remettre.js": "../../../lib/app.js",
    "api/bordereaux/[id]/controle.js": "../../../lib/app.js",
    "api/suivi-bordereau/[code].js": "../../lib/app.js",
    "api/colis/[id]/incidents.js": "../../../lib/app.js",
    "api/colis/[id]/photos.js": "../../../lib/app.js",
    "api/colis/[id]/retour.js": "../../../lib/app.js",
    "api/incidents/[id].js": "../../lib/app.js",
    "api/photos/[id].js": "../../lib/app.js"
  };
  for (const [fichier, cible] of Object.entries(entreesImbriquees)) {
    assert.ok(existsSync(path.join(RACINE, fichier)), `${fichier} doit exister : sinon Vercel répond 404 NOT_FOUND sur cette route`);
    assert.ok(lire(fichier).includes(cible), `${fichier} doit réexporter ${cible} (l'application Express)`);
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
