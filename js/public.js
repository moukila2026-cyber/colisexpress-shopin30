import { normalizeTrackingCode, isTrackingCodeValid, showPageMessage, clearPageMessage } from "./utils.js";

const form = document.getElementById("trackingHomeForm");
const input = document.getElementById("trackingCode");
const message = document.getElementById("trackingMessage");

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  clearPageMessage(message);
  const code = normalizeTrackingCode(input.value);
  if (!isTrackingCodeValid(code)) {
    showPageMessage(message, "Saisissez un code valide au format CLI-XXXXXX.");
    input.focus();
    return;
  }
  window.location.href = `suivi.html?code=${encodeURIComponent(code)}`;
});

input?.addEventListener("input", () => {
  input.value = normalizeTrackingCode(input.value);
});
