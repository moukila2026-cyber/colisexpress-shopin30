/*
 * Règles métier du LOT 7 — suivi personnalisé (js/metier-marque.js) :
 * couleurs strictes, contraste lisible, validation, logos vérifiés sur leurs
 * octets, projection publique sans aucune donnée de contact.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  COULEUR_ACCENT_DEFAUT,
  COULEUR_DEFAUT,
  MAX_LOGO_OCTETS,
  contraste,
  couleurTexteSur,
  estCouleurHex,
  marquePublique,
  normaliserCouleur,
  typeImageDepuisOctets,
  validerLogo,
  validerMarque,
  variablesMarque
} from "../js/metier-marque.js";
import { logoDemoPng } from "../db/logo-demo.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ", "latin1");
const SVG = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");

test("couleurs : uniquement #rrggbb, normalisées en minuscules (aucune injection CSS)", () => {
  assert.ok(estCouleurHex("#0B5D46"));
  assert.equal(normaliserCouleur(" #0B5D46 "), "#0b5d46");
  for (const mauvaise of ["red", "#fff", "#12345g", "#123456;}", "url(javascript:x)", "#1234567", "", null, 42]) {
    assert.equal(normaliserCouleur(mauvaise), null, `« ${mauvaise} » refusée`);
  }
});

test("contraste : le texte posé sur la couleur de l'agence reste lisible", () => {
  assert.equal(couleurTexteSur("#1d3a8a"), "#ffffff", "bleu foncé → texte blanc");
  assert.equal(couleurTexteSur("#f5e663"), "#111111", "jaune clair → texte foncé");
  assert.equal(couleurTexteSur("#ffffff"), "#111111");
  assert.ok(contraste("#000000", "#ffffff") > 20);
  for (const couleur of ["#1d3a8a", "#f5e663", "#0b5d46", "#f27622", "#777777"]) {
    assert.ok(contraste(couleur, couleurTexteSur(couleur)) >= 4.4, `${couleur} : contraste suffisant`);
  }
});

test("validation des réglages : nom par défaut, couleurs par défaut, erreurs en français", () => {
  assert.deepEqual(validerMarque({ active: true }, { nomAgence: "Shopin30 Abidjan" }).valeur, {
    active: true, nom: "Shopin30 Abidjan", couleur: COULEUR_DEFAUT, couleur2: COULEUR_ACCENT_DEFAUT
  });
  assert.deepEqual(validerMarque({ active: "oui", nom: "  Pay   Express ", couleur: "#ABCDEF", couleur2: "#123456" }).valeur, {
    active: false, nom: "Pay Express", couleur: "#abcdef", couleur2: "#123456"
  }, "seul true active la personnalisation");
  assert.match(validerMarque({ couleur: "red;}</style>" }, { nomAgence: "Agence" }).error, /couleur principale.*#RRGGBB/);
  assert.match(validerMarque({ couleur2: "#zzz" }, { nomAgence: "Agence" }).error, /couleur d'accent/);
  assert.match(validerMarque({ nom: "X" }).error, /2 à 60 caractères/);
  assert.match(validerMarque({ nom: "X".repeat(61) }).error, /2 à 60 caractères/);
});

test("logo : type réel lu dans les octets (PNG, JPEG, WebP), jamais de SVG, 300 Ko maximum", () => {
  assert.equal(typeImageDepuisOctets(PNG), "image/png");
  assert.equal(typeImageDepuisOctets(JPEG), "image/jpeg");
  assert.equal(typeImageDepuisOctets(WEBP), "image/webp");
  assert.equal(typeImageDepuisOctets(SVG), null);
  assert.equal(typeImageDepuisOctets(Buffer.alloc(4)), null);
  assert.deepEqual(validerLogo({ type: "image/png", octets: PNG }).valeur, { type: "image/png" });
  assert.match(validerLogo({ type: "image/svg+xml", octets: SVG }).error, /PNG, JPEG ou WebP/);
  assert.match(validerLogo({ type: "image/png", octets: JPEG }).error, /ne correspond pas/, "type déclaré ≠ octets");
  assert.match(validerLogo({ type: "image/png", octets: Buffer.alloc(0) }).error, /vide/);
  const lourd = Buffer.concat([PNG, Buffer.alloc(MAX_LOGO_OCTETS)]);
  assert.match(validerLogo({ type: "image/png", octets: lourd }).error, /300 Ko/);
  // Le logo de démonstration est un vrai PNG valide et léger.
  const demo = logoDemoPng();
  assert.equal(typeImageDepuisOctets(demo), "image/png");
  assert.ok(demo.length < 5000);
});

test("projection publique : seulement si activée, identité commerciale sans contact ni clé de stockage", () => {
  const ligne = {
    name: "Shopin30 Abidjan", email: "demo@colisexpress.ci", phone: "0700000001",
    marque_active: true, marque_nom: "Shopin30 Abidjan", marque_couleur: "#1d3a8a", marque_couleur_2: "#f5b301",
    marque_logo_cle: "marques/demo-abidjan/logo.png", marque_maj_iso: "2026-10-15T08:00:00.000Z"
  };
  assert.deepEqual(marquePublique(ligne), {
    nom: "Shopin30 Abidjan", couleur: "#1d3a8a", couleur2: "#f5b301", couleurTexte: "#ffffff", logo: true, version: "2026-10-15T08:00:00.000Z"
  });
  const brut = JSON.stringify(marquePublique(ligne));
  for (const prive of ["demo@colisexpress.ci", "0700000001", "marques/"]) assert.ok(!brut.includes(prive), `${prive} n'est jamais public`);
  assert.equal(marquePublique({ ...ligne, marque_active: false }), null);
  assert.equal(marquePublique(null), null);
  assert.equal(marquePublique({ ...ligne, marque_couleur: "red;}" }).couleur, COULEUR_DEFAUT, "valeur corrompue → couleur par défaut");
  assert.equal(variablesMarque({ couleur: "#1d3a8a", couleur2: "#f5b301" }), "--marque:#1d3a8a;--marque-2:#f5b301;--marque-texte:#ffffff");
  assert.equal(variablesMarque({ couleur: "red;} body{display:none", couleur2: "x" }), `--marque:${COULEUR_DEFAUT};--marque-2:${COULEUR_ACCENT_DEFAUT};--marque-texte:#ffffff`);
  assert.equal(variablesMarque(null), "");
});
