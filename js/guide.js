import { api } from "./api.js";
import { requireAgency } from "./auth.js";
import { agencySidebar, initAgencyLayout, mobileAgencyHeader } from "./layout.js";
import { escapeHTML } from "./utils.js";

const checklistGrid = document.getElementById("guideChecklistGrid");
const progressBadge = document.getElementById("checklistProgressBadge");
const searchInput = document.getElementById("guideSearchInput");
const filterTabs = document.getElementById("guideFilterTabs");
const noResult = document.getElementById("guideNoResult");
const resetBtn = document.getElementById("resetGuideSearch");

let activeFilter = "tout";

function mountLayout() {
  document.getElementById("sidebarMount").innerHTML = agencySidebar();
  document.getElementById("topbarMount").innerHTML = mobileAgencyHeader(
    "Mode d'emploi",
    '<a class="button button-small button-orange" href="nouveau-colis.html">＋ <span>Nouveau</span></a>'
  );
}

function renderChecklist({ agency, tarifs = [], agents = [], points = [], parcels = [] }) {
  if (!checklistGrid) return;
  const profilOk = Boolean(agency?.name && agency?.city && agency?.phone);
  const tarifsActifs = tarifs.filter((t) => t.active !== false).length;
  const tarifsOk = tarifsActifs > 0;
  const equipeActifs = agents.filter((a) => a.active !== false).length;
  const equipeOk = equipeActifs > 0;
  const colisOk = parcels.length > 0;

  const etapes = [
    {
      num: 1,
      done: profilOk,
      titre: "Profil de l'agence",
      detail: profilOk
        ? `${agency.name} (${agency.city}) est prêt.`
        : "Complétez le nom, la ville et le téléphone de votre agence.",
      href: "parametres.html",
      cta: profilOk ? "Voir le profil" : "Compléter en 30 s"
    },
    {
      num: 2,
      done: tarifsOk,
      titre: "Grille de prix ivoirienne",
      detail: tarifsOk
        ? `${tarifsActifs} ligne${tarifsActifs > 1 ? "s" : ""} tarifaire${tarifsActifs > 1 ? "s" : ""} active${tarifsActifs > 1 ? "s" : ""}.`
        : "Pré-remplissez tous vos tarifs en 1 clic dans Paramètres.",
      href: "parametres.html",
      cta: tarifsOk ? "Ajuster mes tarifs" : "⚡ Pré-remplir en 1 clic"
    },
    {
      num: 3,
      done: equipeOk,
      titre: "Gérants & Agents (Points CI)",
      detail: equipeOk
        ? `${equipeActifs} membre${equipeActifs > 1 ? "s" : ""} actif${equipeActifs > 1 ? "s" : ""} sur ${Math.max(1, points.length)} point${points.length > 1 ? "s" : ""} en CI.`
        : "Invitez vos gérants (2 Gratuit, 5 Pro, illimité Réseau) et vos agents.",
      href: "parametres.html",
      cta: equipeOk ? "Gérer l'équipe" : "＋ Inviter un membre"
    },
    {
      num: 4,
      done: colisOk,
      titre: "Premier colis enregistré",
      detail: colisOk
        ? `${parcels.length} colis suivi${parcels.length > 1 ? "s" : ""} dans votre espace.`
        : "Créez un premier envoi au guichet pour tester le reçu QR.",
      href: "nouveau-colis.html",
      cta: colisOk ? "＋ Nouveau colis" : "🚀 Créer mon 1er colis"
    }
  ];

  const termines = etapes.filter((e) => e.done).length;
  if (progressBadge) {
    progressBadge.textContent = `${termines} / ${etapes.length} étapes complétées`;
  }

  checklistGrid.innerHTML = etapes.map((etape) => `
    <article class="guide-check-card${etape.done ? " is-done" : ""}">
      <div class="guide-check-head">
        <span class="guide-check-step">${etape.done ? "✓" : etape.num}</span>
        <strong>${escapeHTML(etape.titre)}</strong>
        <span class="guide-check-status">${etape.done ? "Prêt" : "À faire"}</span>
      </div>
      <p>${escapeHTML(etape.detail)}</p>
      <a class="button ${etape.done ? "button-outline" : "button-orange"} button-small" href="${escapeHTML(etape.href)}">${escapeHTML(etape.cta)}</a>
    </article>
  `).join("");
}

function filtrerSections() {
  const query = (searchInput?.value || "").trim().toLowerCase();
  const sections = [...document.querySelectorAll(".guide-topic-card")];
  let visibles = 0;

  sections.forEach((section) => {
    const cat = section.dataset.guideCategory || "";
    const matchCat = activeFilter === "tout" || cat === activeFilter;
    const matchText = !query || (section.textContent || "").toLowerCase().includes(query);
    const afficher = matchCat && matchText;
    section.hidden = !afficher;
    if (afficher) visibles += 1;
  });

  if (noResult) noResult.hidden = visibles > 0;
}

filterTabs?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-guide-filter]");
  if (!btn) return;
  activeFilter = btn.dataset.guideFilter || "tout";
  document.querySelectorAll("[data-guide-filter]").forEach((b) => {
    b.classList.toggle("is-active", b === btn);
  });
  filtrerSections();
});

searchInput?.addEventListener("input", filtrerSections);

resetBtn?.addEventListener("click", () => {
  activeFilter = "tout";
  if (searchInput) searchInput.value = "";
  document.querySelectorAll("[data-guide-filter]").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.guideFilter === "tout");
  });
  filtrerSections();
});

async function boot() {
  mountLayout();
  const user = await requireAgency();
  if (!user) return;
  const agency = await initAgencyLayout(user, "guide");
  if (!agency) return;

  try {
    const [tarifsRes, agentsRes, colisRes] = await Promise.all([
      api("/api/tarifs").catch(() => ({ tarifs: [] })),
      api("/api/agents").catch(() => ({ agents: [], points: [] })),
      api("/api/colis").catch(() => ({ parcels: [] }))
    ]);
    renderChecklist({
      agency,
      tarifs: tarifsRes.tarifs || [],
      agents: agentsRes.agents || [],
      points: agentsRes.points || [],
      parcels: colisRes.parcels || []
    });
  } catch {
    renderChecklist({ agency });
  }
}

boot();
