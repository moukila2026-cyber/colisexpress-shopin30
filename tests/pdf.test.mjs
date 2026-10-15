/* Tests du générateur PDF pur Node (LOT 13), sans bibliothèque native. */
import assert from "node:assert/strict";
import test from "node:test";

import { genererRelevePDF } from "../lib/pdf.js";

function releve(overrides = {}) {
  return {
    periode: "2026-10",
    periodeLibelle: "octobre 2026",
    genereLeISO: "2026-11-01T05:00:00.000Z",
    agence: { nom: "Agence (Test) d'Abidjan", ville: "Abidjan" },
    resume: {
      colis: 1,
      valeurColisFCFA: 3500,
      encaissementsFCFA: 1000,
      horsForfait: 1,
      horsForfaitFCFA: 30,
      abonnementFCFA: 10000,
      abonnementLibelle: "Pro — Réglé",
      mouvements: 2
    },
    colis: [{
      code: "CLI-PDF001",
      origine: "Abidjan",
      destination: "Bouaké",
      statut: "Arrivé",
      dateISO: "2026-10-10T12:00:00.000Z",
      prixFCFA: 3500
    }],
    encaissements: [{
      code: "CLI-PDF001",
      dateISO: "2026-10-10T12:30:00.000Z",
      libelle: "Frais de magasinage",
      mode: "especes",
      montantFCFA: 1000
    }],
    mouvements: [{
      type: "depassement",
      libelle: "Colis hors forfait",
      montantFCFA: -30,
      soldeApresFCFA: 470,
      dateISO: "2026-10-10T12:40:00.000Z"
    }],
    ...overrides
  };
}

test("génère un PDF A4 WinAnsi valide, avec synthèse FCFA et échappement des parenthèses", () => {
  const pdf = genererRelevePDF(releve());
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 8).toString("ascii"), "%PDF-1.4");
  const texte = pdf.toString("ascii");
  assert.match(texte, /\/Encoding \/WinAnsiEncoding/);
  assert.match(texte, /COLIS EXPRESS/);
  assert.match(texte, /RELEV\\311 MENSUEL/, "titre français accentué en WinAnsi");
  assert.match(texte, /FCFA/);
  assert.match(texte, /CLI-PDF001/);
  assert.ok(texte.includes(String.raw`Agence \(Test\)`), "parenthèses échappées comme chaîne PDF");
  assert.match(texte, /\\351/, "accents français encodés WinAnsi");
  const xref = texte.match(/startxref\n(\d+)/);
  assert.ok(xref);
  assert.equal(texte.slice(Number(xref[1]), Number(xref[1]) + 4), "xref");
});

test("les relevés volumineux sont répartis sur plusieurs pages sans dépendance native", () => {
  const donnees = releve({
    colis: Array.from({ length: 150 }, (_, index) => ({
      code: `CLI-PDF${String(index).padStart(3, "0")}`,
      origine: "Abidjan",
      destination: "Bouaké",
      statut: "En transit",
      dateISO: "2026-10-10T12:00:00.000Z",
      prixFCFA: 3500
    }))
  });
  const texte = genererRelevePDF(donnees).toString("ascii");
  const pages = (texte.match(/\/Type \/Page\b/g) || []).length;
  assert.ok(pages >= 2, `150 colis doivent produire au moins deux pages, reçu ${pages}`);
  assert.match(texte, /Page 1 \/ [2-9]/);
});
