/*
 * Intégrité statique de l'application : syntaxe, imports/exports entre modules
 * locaux, identifiants DOM réellement présents dans les pages, liens internes et
 * version du SDK Firebase. Ces vérifications remplacent ce que le navigateur
 * refuserait de faire (module introuvable, export mal orthographié, getElementById
 * qui renvoie null) dans un sandbox sans Firebase.
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
  "parametres.html": "js/parametres.js"
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

test("les modules du vendor et le SDK Firebase sont cohérents", () => {
  const versions = new Set();
  for (const fichier of fichiersJs()) {
    for (const match of lire(fichier).matchAll(/gstatic\.com\/firebasejs\/([^/]+)\//g)) versions.add(match[1]);
  }
  assert.equal(versions.size, 1, "toutes les pages doivent charger la même version du SDK");
  assert.match([...versions][0], /^\d+\.\d+\.\d+$/);
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
  assert.match(lire("js/colis.js"), /changementsRattachement/);
  assert.match(lire("js/colis.js"), /Agence de destination à rattacher/);
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

test("les règles de protection sont rappelées dans le README", () => {
  const readme = lire("README.md");
  assert.match(readme, /firestore\.rules/);
  assert.match(readme, /Republish|republier/i);
  assert.match(readme, /rattachement/i);
});
