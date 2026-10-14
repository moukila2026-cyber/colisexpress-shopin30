/*
 * Client HTTP de l'API COLIS EXPRESS : toutes les pages passent par ici.
 * Les erreurs serveur sont renvoyées avec le message français prêt à afficher.
 */
export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    const error = new Error("Connexion internet instable. Vérifiez votre réseau puis réessayez.");
    error.status = 0;
    throw error;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || "Le service est momentanément indisponible. Réessayez.");
    error.status = res.status;
    throw error;
  }
  return data;
}
