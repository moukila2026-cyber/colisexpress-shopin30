/*
 * Générateur PDF minimal en Node pur (LOT 13).
 * Pas de bibliothèque ni de dépendance native : utilise les polices PDF
 * standard Helvetica / Helvetica-Bold avec l'encodage WinAnsi.
 */
const LARGEUR = 595;
const HAUTEUR = 842;
const MARGE = 42;
const LIMITE_LIGNE = 96;

const CP1252 = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f]
]);

function octet(cp) {
  if (CP1252.has(cp)) return CP1252.get(cp);
  if (cp <= 0x7e || (cp >= 0xa0 && cp <= 0xff)) return cp;
  if (cp === 0x2192) return [0x2d, 0x3e]; // flèche vers la droite → ->
  return 0x3f; // caractère non représentable : ?
}

function pdfLiteral(value) {
  const brut = String(value ?? "").replace(/[\r\n\t]+/g, " ");
  let sortie = "(";
  for (const caractere of brut) {
    const valeur = octet(caractere.codePointAt(0));
    const octets = Array.isArray(valeur) ? valeur : [valeur];
    for (const byte of octets) {
      if (byte === 0x28) sortie += "\\(";
      else if (byte === 0x29) sortie += "\\)";
      else if (byte === 0x5c) sortie += "\\\\";
      else if (byte < 0x20 || byte > 0x7e) sortie += `\\${byte.toString(8).padStart(3, "0")}`;
      else sortie += String.fromCharCode(byte);
    }
  }
  return `${sortie})`;
}

function decouperTexte(value, maximum = LIMITE_LIGNE) {
  const mots = String(value ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!mots.length) return [""];
  const lignes = [];
  let ligne = "";
  for (const mot of mots) {
    if (mot.length > maximum) {
      if (ligne) lignes.push(ligne);
      ligne = "";
      for (let index = 0; index < mot.length; index += maximum) lignes.push(mot.slice(index, index + maximum));
      continue;
    }
    if (ligne && `${ligne} ${mot}`.length > maximum) {
      lignes.push(ligne);
      ligne = mot;
    } else {
      ligne = ligne ? `${ligne} ${mot}` : mot;
    }
  }
  if (ligne) lignes.push(ligne);
  return lignes.length ? lignes : [""];
}

function dessinerTexte(texte, x, y, taille, gras = false, couleur = "0.15 0.2 0.17") {
  const police = gras ? "F2" : "F1";
  return `${couleur} rg BT /${police} ${taille} Tf ${x} ${y.toFixed(2)} Td ${pdfLiteral(texte)} Tj ET`;
}

function libelleMontant(value) {
  const montant = Number(value) || 0;
  const nombre = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 })
    .format(montant)
    .replace(/[\u00a0\u202f]/g, " ");
  return `${nombre} FCFA`;
}

function dateFr(value) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Africa/Abidjan",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(value));
}

function lignesReleve(releve) {
  const resume = releve.resume || {};
  const lignes = [
    { type: "titre", texte: "COLIS EXPRESS" },
    { type: "sous-titre", texte: `RELEVÉ MENSUEL — ${releve.periodeLibelle || releve.periode || "—"}` },
    { type: "corps", texte: `Agence : ${releve.agence?.nom || "—"} — ${releve.agence?.ville || "—"}` },
    { type: "corps", texte: `Période : ${releve.periodeLibelle || releve.periode || "—"} · Généré le ${dateFr(releve.genereLeISO || new Date())}` },
    { type: "separateur" },
    { type: "section", texte: "SYNTHÈSE" },
    { type: "corps", texte: `Colis enregistrés par l'agence : ${Number(resume.colis) || 0}` },
    { type: "corps", texte: `Valeur des colis enregistrés : ${libelleMontant(resume.valeurColisFCFA)}` },
    { type: "corps", texte: `Encaissements du mois : ${libelleMontant(resume.encaissementsFCFA)}` },
    { type: "corps", texte: `Colis hors forfait : ${Number(resume.horsForfait) || 0} · ${libelleMontant(resume.horsForfaitFCFA)}` },
    { type: "corps", texte: `Abonnement : ${resume.abonnementLibelle || "Sans abonnement"} · ${libelleMontant(resume.abonnementFCFA)}` },
    { type: "corps", texte: `Mouvements du portefeuille : ${Number(resume.mouvements) || 0}` },
    { type: "note", texte: "Shopin30 n'encaisse jamais le prix des colis : les encaissements de colis sont perçus par l'agence." },
    { type: "espace" },
    { type: "section", texte: "COLIS ENREGISTRÉS" }
  ];

  const colis = Array.isArray(releve.colis) ? releve.colis : [];
  if (!colis.length) lignes.push({ type: "corps", texte: "Aucun colis enregistré pendant cette période." });
  for (const item of colis) {
    lignes.push({
      type: "ligne",
      texte: `${dateFr(item.dateISO)} | ${item.code || "—"} | ${item.origine || "—"} -> ${item.destination || "—"} | ${item.statut || "—"} | ${libelleMontant(item.prixFCFA)}`
    });
  }

  lignes.push({ type: "espace" }, { type: "section", texte: "ENCAISSEMENTS" });
  const encaissements = Array.isArray(releve.encaissements) ? releve.encaissements : [];
  if (!encaissements.length) lignes.push({ type: "corps", texte: "Aucun encaissement pendant cette période." });
  for (const item of encaissements) {
    const mode = item.mode === "mobile_money" ? "Mobile Money" : item.mode === "especes" ? "Espèces" : item.mode || "—";
    lignes.push({
      type: "ligne",
      texte: `${dateFr(item.dateISO)} | ${item.code || "—"} | ${item.libelle || "Encaissement"} | ${mode} | ${libelleMontant(item.montantFCFA)}`
    });
  }

  lignes.push({ type: "espace" }, { type: "section", texte: "MOUVEMENTS DU PORTEFEUILLE" });
  const mouvements = Array.isArray(releve.mouvements) ? releve.mouvements : [];
  if (!mouvements.length) lignes.push({ type: "corps", texte: "Aucun mouvement pendant cette période." });
  for (const item of mouvements) {
    const signe = Number(item.montantFCFA) > 0 ? "+" : "";
    lignes.push({
      type: "ligne",
      texte: `${dateFr(item.dateISO)} | ${item.libelle || item.type || "Mouvement"} | ${signe}${libelleMontant(item.montantFCFA)} | Solde après : ${libelleMontant(item.soldeApresFCFA)}`
    });
  }
  return lignes;
}

function commandesPages(lignes, periode) {
  const pages = [];
  let commandes = [];
  let y = HAUTEUR - 48;
  let page = 1;

  const nouvellePage = () => {
    if (commandes.length) pages.push(commandes);
    commandes = [];
    y = HAUTEUR - 48;
    if (page > 1) {
      commandes.push(dessinerTexte(`COLIS EXPRESS — Relevé ${periode} (suite)`, MARGE, y, 9, true, "0.12 0.31 0.22"));
      y -= 18;
    }
    page += 1;
  };

  for (const item of lignes) {
    if (item.type === "separateur") {
      y -= 4;
      commandes.push(`0.7 0.82 0.76 RG 1 w ${MARGE} ${y.toFixed(2)} m ${LARGEUR - MARGE} ${y.toFixed(2)} l S`);
      y -= 12;
      continue;
    }
    if (item.type === "espace") { y -= 8; continue; }

    const titre = item.type === "titre";
    const sousTitre = item.type === "sous-titre";
    const section = item.type === "section";
    const note = item.type === "note";
    const taille = titre ? 19 : sousTitre ? 13 : section ? 10 : note ? 8 : 8.5;
    const interligne = titre ? 24 : sousTitre ? 18 : section ? 15 : note ? 12 : 12;
    const gras = titre || sousTitre || section;
    const couleur = section || titre ? "0.08 0.31 0.21" : note ? "0.35 0.4 0.37" : "0.15 0.2 0.17";
    const lignesTexte = decouperTexte(item.texte, titre ? 70 : LIMITE_LIGNE);
    for (const texte of lignesTexte) {
      if (y < 45 + interligne) nouvellePage();
      commandes.push(dessinerTexte(texte, MARGE, y, taille, gras, couleur));
      y -= interligne;
    }
    if (section) y -= 2;
  }
  if (commandes.length) pages.push(commandes);

  return pages.map((contenu, index) => [
    ...contenu,
    `0.72 0.78 0.74 RG 0.6 w ${MARGE} 34 m ${LARGEUR - MARGE} 34 l S`,
    dessinerTexte(`COLIS EXPRESS · ${periode} · Page ${index + 1} / ${pages.length}`, MARGE, 21, 7.5, false, "0.38 0.43 0.4")
  ].join("\n"));
}

/** Génère un relevé PDF mensuel autonome en FCFA, sans donnée client. */
export function genererRelevePDF(releve = {}) {
  const periode = String(releve.periode || "");
  const pages = commandesPages(lignesReleve(releve), periode || "—");
  const objets = [];
  objets[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const referencesPages = pages.map((_, index) => `${5 + index * 2} 0 R`).join(" ");
  objets[2] = `<< /Type /Pages /Kids [${referencesPages}] /Count ${pages.length} >>`;
  objets[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objets[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  pages.forEach((contenu, index) => {
    const pageObjet = 5 + index * 2;
    const contenuObjet = pageObjet + 1;
    objets[pageObjet] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${LARGEUR} ${HAUTEUR}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contenuObjet} 0 R >>`;
    objets[contenuObjet] = `<< /Length ${Buffer.byteLength(contenu, "ascii")} >>\nstream\n${contenu}\nendstream`;
  });

  let sortie = "%PDF-1.4\n%COLIS-EXPRESS\n";
  const offsets = [0];
  for (let index = 1; index < objets.length; index += 1) {
    offsets[index] = Buffer.byteLength(sortie, "ascii");
    sortie += `${index} 0 obj\n${objets[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(sortie, "ascii");
  sortie += `xref\n0 ${objets.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objets.length; index += 1) {
    sortie += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  sortie += `trailer\n<< /Size ${objets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(sortie, "ascii");
}
