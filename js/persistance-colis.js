/**
 * Adaptateur de persistance : SDK injecté pour tester le protocole sans réseau.
 * Le contrôle préalable du code dans la page ne suffit pas : une autre agence
 * peut prendre le même code entre cette lecture et l'écriture.
 */
export async function enregistrerColisAtomiquement({
  runTransaction, db, parcelRef, trackingRef, parcel, publicTracking
}) {
  await runTransaction(db, async (transaction) => {
    // Lire le suivi public, pas un colis inexistant dont la lecture est interdite.
    const existing = await transaction.get(trackingRef);
    if (existing.exists()) {
      throw new Error("Ce code de suivi vient d'être attribué. Réessayez l'enregistrement.");
    }
    // API du SDK Web : set(), et non create(). Firestore rejoue cette lecture
    // en cas de concurrence ; aucun suivi existant ne doit être écrasé.
    transaction.set(parcelRef, parcel);
    transaction.set(trackingRef, publicTracking);
  });
}
