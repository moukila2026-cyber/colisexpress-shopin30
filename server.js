/*
 * Serveur de développement / démo : sert l'API et les fichiers statiques.
 * Sans DATABASE_URL, la base est PGlite (Postgres WASM en mémoire) avec des
 * données de démonstration — voir README.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import app from "./lib/app.js";
import { getDb, modeDemo } from "./db/db.js";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);

// Fichiers statiques (pages HTML, js/, assets/) — après l'API.
app.use(express.static(ICI, { index: "index.html" }));

await getDb(); // initialise le schéma (et la démo) avant d'écouter

app.listen(PORT, "0.0.0.0", () => {
  const url = `http://0.0.0.0:${PORT}`;
  console.log(`COLIS EXPRESS — ${url}`);
  if (modeDemo()) {
    console.log("Base : PGlite (démo, données en mémoire). Définissez DATABASE_URL pour utiliser Neon.");
    console.log("Comptes de démonstration : demo@colisexpress.ci / demo1234  et  bouake@colisexpress.ci / demo1234");
  } else {
    console.log("Base : Postgres (DATABASE_URL détectée).");
  }
});
