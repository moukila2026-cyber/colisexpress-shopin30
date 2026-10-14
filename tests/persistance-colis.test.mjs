import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../js/persistance-colis.js", import.meta.url), "utf8");
const { enregistrerColisAtomiquement } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

function contexte(exists = false) {
  const appels = [];
  const params = {
    db: {}, parcelRef: {}, trackingRef: {},
    parcel: { destinationAgencyId: null }, publicTracking: { code: "CLI-ABC234" },
    runTransaction: async (db, callback) => {
      assert.equal(db, params.db);
      await callback({
        get: async (ref) => { appels.push(["get", ref]); return { exists: () => exists }; },
        set: (ref, data) => { appels.push(["set", ref, data]); }
      });
    }
  };
  return { params, appels };
}

for (const destinationAgencyId of [null, "agence-b"]) {
  test(`enregistrement atomique via l'API Web, destination ${destinationAgencyId}`, async () => {
    const { params, appels } = contexte();
    params.parcel.destinationAgencyId = destinationAgencyId;
    await enregistrerColisAtomiquement(params);
    assert.deepEqual(appels, [
      ["get", params.trackingRef],
      ["set", params.parcelRef, params.parcel],
      ["set", params.trackingRef, params.publicTracking]
    ]);
  });
}

test("collision : aucune écriture et message invitant à réessayer", async () => {
  const { params, appels } = contexte(true);
  await assert.rejects(enregistrerColisAtomiquement(params), /Réessayez/);
  assert.deepEqual(appels, [["get", params.trackingRef]]);
});

test("échec du commit : l'erreur remonte à la page", async () => {
  const { params } = contexte();
  const erreur = new Error("permission-denied");
  const original = params.runTransaction;
  params.runTransaction = async (...args) => { await original(...args); throw erreur; };
  await assert.rejects(enregistrerColisAtomiquement(params), (error) => error === erreur);
});

test("rejeu simulé : une collision concurrente bloque la nouvelle tentative", async () => {
  const { params } = contexte();
  let lectures = 0;
  let ecritures = 0;
  params.runTransaction = async (_, callback) => {
    const transaction = {
      get: async () => ({ exists: () => ++lectures > 1 }),
      set: () => { ecritures++; }
    };
    await callback(transaction); // première tentative, non validée par le faux SDK
    await callback(transaction); // rejeu après concurrence
  };
  await assert.rejects(enregistrerColisAtomiquement(params), /Réessayez/);
  assert.equal(lectures, 2);
  assert.equal(ecritures, 2); // aucune nouvelle écriture au rejeu
});

test("la page attend la transaction avant d'afficher le reçu", () => {
  const page = readFileSync(new URL("../js/nouveau-colis.js", import.meta.url), "utf8");
  assert.doesNotMatch(page, /batch\.create\(|writeBatch/);
  assert.match(page, /await enregistrerColisAtomiquement\(/);
  assert.ok(page.indexOf("await enregistrerColisAtomiquement(") < page.indexOf("    showReceipt(parcel);"));
});
