/*
 * Logo de démonstration (LOT 7) : un PNG 160×160 dessiné en mémoire — carré
 * arrondi aux couleurs de l'agence, colis blanc et ruban d'accent — sans
 * aucune dépendance (zlib de Node + CRC32). Utilisé par le seed de démo pour
 * montrer le suivi personnalisé ; jamais en production.
 */
import { deflateSync } from "node:zlib";

const TABLE_CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(octets) {
  let c = 0xffffffff;
  for (const octet of octets) c = TABLE_CRC[(c ^ octet) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function bloc(type, donnees) {
  const longueur = Buffer.alloc(4);
  longueur.writeUInt32BE(donnees.length);
  const typeEtDonnees = Buffer.concat([Buffer.from(type, "ascii"), donnees]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeEtDonnees));
  return Buffer.concat([longueur, typeEtDonnees, crc]);
}

/** PNG RGBA du logo : `fond` et `ruban` en [r, g, b]. */
export function logoDemoPng({ taille = 160, fond = [29, 58, 138], ruban = [245, 179, 1] } = {}) {
  const pixels = Buffer.alloc(taille * taille * 4);
  const rayon = taille * 0.2;
  const dansCarreArrondi = (x, y) => {
    const cx = Math.min(Math.max(x, rayon), taille - 1 - rayon);
    const cy = Math.min(Math.max(y, rayon), taille - 1 - rayon);
    return (x - cx) ** 2 + (y - cy) ** 2 <= rayon ** 2;
  };
  const colis = { x0: taille * 0.27, x1: taille * 0.73, y0: taille * 0.34, y1: taille * 0.74 };
  const couvercle = taille * 0.44;
  for (let y = 0; y < taille; y += 1) {
    for (let x = 0; x < taille; x += 1) {
      const i = (y * taille + x) * 4;
      if (!dansCarreArrondi(x, y)) continue; // transparent
      let couleur = fond;
      if (x >= colis.x0 && x <= colis.x1 && y >= colis.y0 && y <= colis.y1) {
        couleur = [255, 255, 255];
        if (Math.abs(x - taille / 2) <= taille * 0.045) couleur = ruban; // ruban vertical
        if (Math.abs(y - couvercle) <= 1.2) couleur = fond.map((v) => Math.round(v * 0.6 + 255 * 0.4)); // rabat
      }
      pixels[i] = couleur[0];
      pixels[i + 1] = couleur[1];
      pixels[i + 2] = couleur[2];
      pixels[i + 3] = 255;
    }
  }
  const lignes = Buffer.alloc(taille * (taille * 4 + 1));
  for (let y = 0; y < taille; y += 1) {
    lignes[y * (taille * 4 + 1)] = 0; // filtre « None »
    pixels.copy(lignes, y * (taille * 4 + 1) + 1, y * taille * 4, (y + 1) * taille * 4);
  }
  const entete = Buffer.alloc(13);
  entete.writeUInt32BE(taille, 0);
  entete.writeUInt32BE(taille, 4);
  entete[8] = 8; // 8 bits par canal
  entete[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloc("IHDR", entete),
    bloc("IDAT", deflateSync(lignes, { level: 9 })),
    bloc("IEND", Buffer.alloc(0))
  ]);
}
