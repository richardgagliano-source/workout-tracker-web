console.log("APP VERSION: 2026-02-16-F");
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// --- Supabase config (your project) ---
const SUPABASE_URL = "https://doxyazdbbqpjcbfwcvzr.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRveHlhemRiYnFwamNiZndjdnpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3ODUwODYsImV4cCI6MjA4NjM2MTA4Nn0.efJGioFAoeOzu5RnFrkKFEMz8GZRttBvMaywYnxdhyc";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.sb = sb;

// --- Session state (store access token + user id for RLS) ---
let currentUserId = null;
let currentAccessToken = null;
function getUserIdOrThrow() {
  if (!currentUserId) throw new Error("Not signed in.");
  return currentUserId;
}

// --- App state ---
let cachedTemplates = [];

let openProgramIds = new Set();
let programSearchTerms = new Map(); // template_id -> last search term
let lastProgramFocusId = null;
let activeWorkout = null; // { workoutId, items: [{ workoutExerciseId, exerciseId, exerciseName, sets: [{set_index, weight, reps}] }] }

// --- DOM helpers ---
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
function setAuthMsg(msg) { $("authMsg").textContent = msg || ""; }
function setWorkoutMsg(msg) { $("workoutMsg").textContent = msg || ""; }

// ----------------------------
// Supersets (client-side metadata)
// NOTE: This stores superset grouping in localStorage (no DB migration required).
// Keyed by templateId so each program can have its own grouping.
// ----------------------------
function getSupersetStoreKey(templateId) {
  return `supersets:${templateId}`;
}

function loadSupersetMap(templateId) {
  try {
    const raw = localStorage.getItem(getSupersetStoreKey(templateId));
    if (!raw) return new Map();
    const obj = JSON.parse(raw);
    return new Map(Object.entries(obj || {}));
  } catch {
    return new Map();
  }
}

function saveSupersetMap(templateId, map) {
  try {
    const obj = Object.fromEntries(map.entries());
    localStorage.setItem(getSupersetStoreKey(templateId), JSON.stringify(obj));
  } catch {
    // ignore
  }
}

// Ensure group ids are stable strings
function newSupersetId() {
  return `ss_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function groupSize(map, groupId) {
  let n = 0;
  for (const [, gid] of map.entries()) if (gid === groupId) n++;
  return n;
}

function cleanupSupersetMap(templateId, map) {
  // Remove groups with <2 exercises
  const counts = new Map();
  for (const [, gid] of map.entries()) counts.set(gid, (counts.get(gid) || 0) + 1);
  for (const [exId, gid] of map.entries()) {
    if ((counts.get(gid) || 0) < 2) map.delete(exId);
  }
  saveSupersetMap(templateId, map);
}




// --------------------
// Hamburger menu: open/close + tab navigation
// --------------------
function closeHamburger() {
  const menu = document.getElementById("hamburgerMenu");
  if (menu) menu.classList.add("hidden");
}

function toggleHamburger() {
  const menu = document.getElementById("hamburgerMenu");
  if (!menu) return;
  menu.classList.toggle("hidden");
}

// Attach hamburger handlers AFTER the DOM exists (works on iPhone)
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("hamburgerBtn");
  const menu = document.getElementById("hamburgerMenu");
  if (!btn || !menu) {
    console.warn("Hamburger elements not found", { btn, menu });
    return;
  }

const onToggle = (e) => {
  e.preventDefault();
  e.stopPropagation();
  toggleHamburger();
};

btn.addEventListener("click", onToggle);
btn.addEventListener("touchend", onToggle, { passive: false });


  // Close when tapping outside
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("hidden") && !menu.contains(e.target) && e.target !== btn) {
      closeHamburger();
    }
  });

  // Close after clicking a menu item
  menu.querySelectorAll(".menu-item").forEach((el) => {
    el.addEventListener("click", () => closeHamburger());
  });
});


// Close when clicking outside
document.addEventListener("click", () => closeHamburger());

// Use hamburger items to drive your existing tab logic
document.querySelectorAll(".menu-item[data-tab]").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const tab = btn.dataset.tab;
    document.querySelector(`.tab[data-tab="${tab}"]`)?.click();
    closeHamburger();
  });
});
// --- Timeout helper (prevents "Loading..." forever) ---
function withTimeout(promise, ms, label = "Operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}


// --- REST helper (uses user JWT if available) ---
async function fetchJSON(path, { method = "GET", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const authToken = currentAccessToken || SUPABASE_ANON_KEY;

  try {
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      method,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`Request timed out: ${method} ${path}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// --------------------
// Small helpers
// --------------------
function uniq(arr) {
  return [...new Set(arr)];
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function numOrNull(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Estimated 1RM (Epley). If reps missing, return null.
function epley1RM(weight, reps) {
  const w = Number(weight);
  const r = Number(reps);
  if (!Number.isFinite(w) || !Number.isFinite(r) || w <= 0 || r <= 0) return null;
  return w * (1 + r / 30);
}

// Best set selection for “top set” style display
function bestSet(sets) {
  // Prefer highest e1RM, tie-break on weight
  let best = null;
  for (const s of sets) {
    const w = s.weight;
    const r = s.reps;
    const e1 = epley1RM(w, r);
    const cand = { ...s, e1rm: e1 };
    if (!best) { best = cand; continue; }
    const be = best.e1rm ?? -Infinity;
    const ce = cand.e1rm ?? -Infinity;
    if (ce > be) best = cand;
    else if (ce === be && (cand.weight ?? -Infinity) > (best.weight ?? -Infinity)) best = cand;
  }
  return best;
}

// --------------------
// Tabs UI
// --------------------
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    ["templates", "workout", "library", "history", "progress"].forEach((t) => hide($(`tab-${t}`)));
    show($(`tab-${tab}`));
  });
});

// --------------------
// Auth
// --------------------
$("signInBtn").addEventListener("click", async () => {
  setAuthMsg("");
  const { error } = await sb.auth.signInWithPassword({
    email: $("email").value.trim(),
    password: $("password").value,
  });
  if (error) setAuthMsg(error.message);
});

$("signUpBtn").addEventListener("click", async () => {
  setAuthMsg("");
  const { error } = await sb.auth.signUp({
    email: $("email").value.trim(),
    password: $("password").value,
  });
  if (error) setAuthMsg(error.message);
  else setAuthMsg("Signed up! Now sign in.");
});

async function signOut() { await sb.auth.signOut(); }

function renderUserBar(user) {
  const el = $("userBar");
  el.innerHTML = "";
  if (!user) return;

  const span = document.createElement("span");
  span.className = "small";
  span.textContent = `Signed in as ${user.email}`;

  const btn = document.createElement("button");
  btn.className = "secondary";
  btn.textContent = "Sign out";
  btn.onclick = signOut;

  el.append(span, btn);
}

// --------------------
// Exercises (library)
// --------------------
async function loadExercises(search = "") {
  const term = search.trim();
  const params = new URLSearchParams();
  params.set("select", "id,name,video_link");
  params.set("order", "name.asc");
  params.set("limit", "80");
  if (term) params.set("name", `ilike.*${term.replaceAll("*", "")}*`);
  return await fetchJSON(`/rest/v1/exercises?${params.toString()}`);
}


// --- YouTube helper (for exercise video thumbnails) ---
function getYouTubeId(url) {
  try {
    const u = new URL(url);
    // youtu.be/<id>
    if (u.hostname.includes("youtu.be")) return u.pathname.replace("/", "") || null;
    // youtube.com/watch?v=<id>
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    // youtube.com/shorts/<id>
    const parts = u.pathname.split("/").filter(Boolean);
    const shortsIdx = parts.indexOf("shorts");
    if (shortsIdx >= 0 && parts[shortsIdx + 1]) return parts[shortsIdx + 1];
    // youtube.com/embed/<id>
    const embedIdx = parts.indexOf("embed");
    if (embedIdx >= 0 && parts[embedIdx + 1]) return parts[embedIdx + 1];
    return null;
  } catch {
    return null;
  }
}

function renderVideoThumb(url) {
  if (!url) return "";
  const id = getYouTubeId(url);
  if (!id) {
    // Non-YouTube link fallback
    const safe = String(url).replace(/"/g, "&quot;");
    return `<a class="videoLink" href="${safe}" target="_blank" rel="noopener noreferrer">Video</a>`;
  }
  const thumb = `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
  const safeUrl = String(url).replace(/"/g, "&quot;");
  return `
    <a class="videoThumb" style="display:inline-block;" href="${safeUrl}" target="_blank" rel="noopener noreferrer" title="Open video">
      <img src="${thumb}" alt="Video thumbnail" loading="lazy" style="width: 180px; max-width: 100%; height: auto; border-radius: 12px; margin-top: 8px; display: block;" />
    </a>
  `;
}

$("exerciseSearch").addEventListener("input", async () => {
  const term = $("exerciseSearch").value.trim();
  const list = $("exerciseList");
  list.innerHTML = "Loading...";
  try {
    const ex = await loadExercises(term);
    list.innerHTML = "";
    (ex || []).slice(0, 80).forEach((e) => {
      const card = document.createElement("div");
      card.className = "item";
     card.innerHTML = `
  <h3>${e.name}</h3>
  ${renderVideoThumb(e.video_link)}
`;

      list.appendChild(card);
    });
    if (!ex || ex.length === 0) list.innerHTML = `<div class="muted">No exercises found.</div>`;
  } catch (err) {
    console.error(err);
    list.innerHTML = `<div class="muted">Error: ${String(err.message || err)}</div>`;
  }
});
// ---- Library: Add Exercise UI (insert after exerciseSearch handler) ----
(function setupAddExerciseUI() {
  const libTab = $("tab-library"); // library tab container
  if (!libTab) return; // safety

  // Create a small container above the search/results area
  const addWrap = document.createElement("div");
  addWrap.className = "item";
  addWrap.style.display = "flex";
  addWrap.style.flexDirection = "column";
  addWrap.style.gap = "8px";
  addWrap.style.marginBottom = "12px";

  // Header row with button
  const headerRow = document.createElement("div");
  headerRow.style.display = "flex";
  headerRow.style.justifyContent = "space-between";
  headerRow.style.alignItems = "center";
  headerRow.style.gap = "12px";

  const title = document.createElement("div");
  title.innerHTML = `<b>Add new exercise</b>`;
  headerRow.appendChild(title);

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "secondary";
  toggleBtn.type = "button";
  toggleBtn.textContent = "Add exercise";
  headerRow.appendChild(toggleBtn);

  // Form (hidden by default)
  const form = document.createElement("div");
  form.className = "stack hidden";
  form.style.padding = "8px 0";

  const nameInput = document.createElement("input");
  nameInput.placeholder = "Exercise name (required)";
  nameInput.style.width = "100%";
  form.appendChild(nameInput);

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "8px";

  const muscleInput = document.createElement("input");
  muscleInput.placeholder = "Primary muscle (optional)";
  muscleInput.style.flex = "1";
  row.appendChild(muscleInput);

  form.appendChild(row);

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "8px";

  const saveBtn = document.createElement("button");
  saveBtn.className = "primary";
  saveBtn.textContent = "Save";
  actions.appendChild(saveBtn);

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "secondary";
  cancelBtn.textContent = "Cancel";
  actions.appendChild(cancelBtn);

  const msg = document.createElement("div");
  msg.className = "small muted";
  form.appendChild(actions);
  form.appendChild(msg);

  addWrap.appendChild(headerRow);
  addWrap.appendChild(form);

  // Insert the addWrap at the top of the library tab (before search + results)
  // If exerciseList exists, insert before it; otherwise append to libTab
  const exerciseList = $("exerciseList");
  if (exerciseList && exerciseList.parentNode === libTab) {
    libTab.insertBefore(addWrap, exerciseList);
  } else {
    libTab.appendChild(addWrap);
  }

  // Toggle show/hide
  toggleBtn.addEventListener("click", () => {
    const hidden = form.classList.contains("hidden");
    if (hidden) {
      form.classList.remove("hidden");
      toggleBtn.textContent = "Hide";
      nameInput.focus();
    } else {
      form.classList.add("hidden");
      toggleBtn.textContent = "Add exercise";
      msg.textContent = "";
    }
  });

  cancelBtn.addEventListener("click", () => {
    form.classList.add("hidden");
    toggleBtn.textContent = "Add exercise";
    msg.textContent = "";
  });

  // Save handler
  saveBtn.addEventListener("click", async () => {
    msg.textContent = "";
    const name = nameInput.value.trim();
    const video_link = muscleInput.value.trim() || null;

    if (!name) {
      msg.textContent = "Please enter a name.";
      return;
    }

    // Make sure user is signed in (RLS requires authenticated)
    try {
      getUserIdOrThrow();
    } catch (e) {
      alert("You must be signed in to add exercises.");
      return;
    }

    // Prevent obvious duplicates: check existing results for same name (case-insensitive)
    const existing = (await loadExercises(name)).find((e) => (e.name || "").toLowerCase() === name.toLowerCase());
    if (existing) {
      msg.textContent = "An exercise with that name already exists.";
      return;
    }

    // Create exercise via REST helper
    try {
const userId = getUserIdOrThrow();

await fetchJSON("/rest/v1/exercises", {
  method: "POST",
  body: [{
    name,
    video_link: video_link || null,
    notes: null,
    is_system: false,
    owner_user_id: userId
  }],
});

      // Clear form, hide and refresh visible list
      nameInput.value = "";
      form.classList.add("hidden");
      toggleBtn.textContent = "Add exercise";
      msg.textContent = "";

      // Refresh library results: if there is a search term, re-run it, otherwise reload top list
      const term = $("exerciseSearch")?.value?.trim() || "";
      const list = $("exerciseList");
      if (list) {
        list.innerHTML = "Loading...";
        const ex = await loadExercises(term);
        list.innerHTML = "";
        (ex || []).slice(0, 80).forEach((e) => {
          const card = document.createElement("div");
          card.className = "item";
          card.innerHTML = `
  <h3>${e.name}</h3>
  ${renderVideoThumb(e.video_link)}
`;
          list.appendChild(card);
        });
        if (!ex || ex.length === 0) list.innerHTML = `<div class="muted">No exercises found.</div>`;
      }
      // show success toast-like text briefly
      msg.textContent = "Saved!";
      setTimeout(() => (msg.textContent = ""), 1500);
    } catch (err) {
      console.error(err);
      alert("Failed to add exercise: " + String(err.message || err));
    }
  });
})();
// --------------------
// Templates (user-owned)
// --------------------
async function loadTemplatesFull(userId) {
  // 1) Templates
  const tParams = new URLSearchParams();
tParams.set("select", "id,name,split_type,created_at");
// ✅ shared programs: do NOT filter by user
// tParams.set("user_id", `eq.${userId}`);
tParams.set("order", "created_at.desc");
tParams.set("limit", "200");

  const templates =
    (await fetchJSON(`/rest/v1/workout_templates?${tParams.toString()}`)) || [];
  if (!templates.length) return [];

  // 2) Template exercises rows
  const tplIds = templates.map((t) => t.id).join(",");
  const teParams = new URLSearchParams();
  teParams.set("select", "id,template_id,exercise_id,order_index,group_id,group_order,group_label,notes");
  teParams.set("template_id", `in.(${tplIds})`);
  teParams.set("order", "order_index.asc");
  teParams.set("limit", "5000");

  const wte =
    (await fetchJSON(`/rest/v1/workout_template_exercises?${teParams.toString()}`)) ||
    [];

  // 3) Exercise names
  const exIds = [...new Set(wte.map((r) => r.exercise_id).filter(Boolean))];
  let exMap = new Map();
  if (exIds.length) {
    const exParams = new URLSearchParams();
    exParams.set("select", "id,name");
    exParams.set("id", `in.(${exIds.join(",")})`);
    exParams.set("limit", "5000");

    const exRows =
      (await fetchJSON(`/rest/v1/exercises?${exParams.toString()}`)) || [];
    exMap = new Map(exRows.map((e) => [e.id, e.name]));
  }

  // Group template_exercises by template_id
  const byTpl = new Map();
  for (const row of wte) {
    const arr = byTpl.get(row.template_id) || [];
    arr.push(row);
    byTpl.set(row.template_id, arr);
  }

  // Final shape: keep BOTH (raw-ish rows + simplified list)
  return templates.map((t) => {
    const rows = (byTpl.get(t.id) || [])
      .slice()
      .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));

    const workout_template_exercises = rows.map((r) => ({
      ...r,
      exercises: {
        id: r.exercise_id,
        name: exMap.get(r.exercise_id) || "(unknown exercise)",
      },
    }));

    const exercises = workout_template_exercises.map((r) => ({
      wte_id: r.id,
      template_id: r.template_id,
      exercise_id: r.exercise_id,
      order_index: r.order_index,
      name: r.exercises?.name || "(unknown exercise)",
    }));

    // ALSO: provide "items" so your Workout Start code won’t break
    // Include superset fields so workouts can render grouped cards.
    const items = workout_template_exercises.map((r) => ({
      exercise_id: r.exercise_id,
      order_index: r.order_index ?? 0,
      exercise_name: r.exercises?.name || "(unknown exercise)",
      group_id: r.group_id ?? null,
      group_order: r.group_order ?? null,
      group_label: r.group_label ?? null,
      notes: r.notes ?? null,
      // keep for editor convenience
      wte_id: r.id,
    }));

    return {
      ...t,
      workout_template_exercises,
      exercises,
      items,
      exercise_count: exercises.length,
    };
  });
}

async function createTemplate(userId, name, split_type) {
  const body = [{
    user_id: userId,      // <-- REQUIRED by your DB
    name,
    split_type
  }];

  const created = await fetchJSON(`/rest/v1/workout_templates`, {
    method: "POST",
    body
  });

  return created?.[0];
}


function refreshStartWorkoutDropdown() {
  const sel = $("startTplSelect");
  sel.innerHTML = "";
  const templates = (cachedTemplates || []);
  if (!templates.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Create a template first";
    sel.appendChild(opt);
    return;
  }
  templates.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = `${t.name} (${t.split_type})`;
    sel.appendChild(opt);
  });
}

async function refreshTemplates() {
  const list = $("templatesList");
  list.innerHTML = "Loading...";

  let userId;
  try {
    userId = getUserIdOrThrow();
  } catch {
    list.innerHTML = `<div class="muted">Not signed in.</div>`;
    return;
  }

  try {
    cachedTemplates = await loadTemplatesFull(userId);
  } catch (err) {
    console.error("Templates load failed:", err);
    list.innerHTML = `<div class="muted">Error loading templates: ${String(err.message || err)}</div>`;
    return;
  }

  refreshStartWorkoutDropdown();

  list.innerHTML = "";
  if (!cachedTemplates.length) {
    list.innerHTML = `<div class="muted">No programs yet. Add one, bb!.</div>`;
    return;
  }

  for (const t of cachedTemplates) {
    const card = document.createElement("div");
    card.className = "item";

    // Header row
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.gap = "12px";
    header.style.cursor = "pointer";

    const left = document.createElement("div");

    const h = document.createElement("h3");
    h.style.margin = "0";
    h.textContent = t.name;

    const meta = document.createElement("div");
    meta.className = "small";
    const exCount = (t.workout_template_exercises || []).length;
    meta.textContent = `${exCount} exercise${exCount === 1 ? "" : "s"}`;

    left.appendChild(h);
    left.appendChild(meta);

    const chevron = document.createElement("div");
    chevron.className = "small";

    header.appendChild(left);
    header.appendChild(chevron);

    // Details
    const details = document.createElement("div");
    details.className = "stack";

    const isOpen = openProgramIds.has(t.id);
    if (!isOpen) details.classList.add("hidden");
    chevron.textContent = isOpen ? "Hide ▴" : "Show ▾";

    const current = (t.workout_template_exercises || [])
      .slice()
      .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
    const ssMap = loadSupersetMap(t.id);


    // exercise list
    const ul = document.createElement("div");
    ul.className = "stack";

    current.forEach((x, idx) => {
      const row = document.createElement("div");
      row.className = "item";
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.gap = "12px";

      const name = x.exercises?.name || "Exercise";
      const leftText = document.createElement("div");
      leftText.innerHTML = `<b>${idx + 1}.</b> ${name}`;

      const actions = document.createElement("div");
      actions.style.display = "flex";
      actions.style.gap = "8px";

      // Superset grouping controls (stored locally per program)
      const exId = String(x.exercise_id);
      const gid = ssMap.get(exId) || null;

      const ssBtn = document.createElement("button");
      ssBtn.className = "secondary";

      if (!gid) {
        ssBtn.textContent = "Add next to SuperSet";
        ssBtn.onclick = () => {
          const next = current[idx + 1];
          if (!next) return alert("Put another exercise below this one to create a superset.");
          const nextId = String(next.exercise_id);
          const nextGid = ssMap.get(nextId) || null;

          const useGid = nextGid || newSupersetId();
          if (groupSize(ssMap, useGid) >= 3) return alert("Supersets are limited to 3 exercises.");

          ssMap.set(exId, useGid);
          ssMap.set(nextId, useGid);
          cleanupSupersetMap(t.id, ssMap);
          refreshTemplates();
        };
      } else {
        const next = current[idx + 1] || null;
        const canAddNext =
          !!next && groupSize(ssMap, gid) < 3 && !ssMap.get(String(next.exercise_id));

        ssBtn.textContent = canAddNext ? "Add next" : "In superset";
        ssBtn.disabled = !canAddNext;
        ssBtn.onclick = () => {
          if (!next) return;
          const nextId = String(next.exercise_id);
          if (ssMap.get(nextId)) return;
          if (groupSize(ssMap, gid) >= 3) return;
          ssMap.set(nextId, gid);
          cleanupSupersetMap(t.id, ssMap);
          refreshTemplates();
        };
      }

      actions.appendChild(ssBtn);

      if (gid) {
        const ungroupBtn = document.createElement("button");
        ungroupBtn.className = "secondary";
        ungroupBtn.textContent = "Ungroup";
        ungroupBtn.onclick = () => {
          ssMap.delete(exId);
          cleanupSupersetMap(t.id, ssMap);
          refreshTemplates();
        };
        actions.appendChild(ungroupBtn);
      }


      // UP button
      const up = document.createElement("button");
      up.className = "secondary";
      up.textContent = "↑";
      up.disabled = idx === 0;

      // DOWN button  
      const down = document.createElement("button");
      down.className = "secondary";
      down.textContent = "↓";
      down.disabled = idx === current.length - 1;

      // temp swap helper
      const TEMP = -999999;

      up.onclick = async (e) => {
        e.stopPropagation();
        const above = current[idx - 1];
        const me = x;
        if (!above) return;

        const a = above.order_index ?? (idx - 1);
        const b = me.order_index ?? idx;

        // above -> TEMP
        let res = await sb.from("workout_template_exercises").update({ order_index: TEMP }).eq("id", above.id);
        if (res.error) { alert("Move failed: " + res.error.message); return; }

        // me -> a
        res = await sb.from("workout_template_exercises").update({ order_index: a }).eq("id", me.id);
        if (res.error) { alert("Move failed: " + res.error.message); return; }

        // above(TEMP) -> b
        res = await sb.from("workout_template_exercises").update({ order_index: b }).eq("id", above.id);
        if (res.error) { alert("Move failed: " + res.error.message); return; }

        openProgramIds.add(t.id);
        lastProgramFocusId = t.id;
        await refreshTemplates();
      };

      down.onclick = async (e) => {
        e.stopPropagation();
        const below = current[idx + 1];
        const me = x;
        if (!below) return;

        const a = below.order_index ?? (idx + 1);
        const b = me.order_index ?? idx;

        // below -> TEMP
        let res = await sb.from("workout_template_exercises").update({ order_index: TEMP }).eq("id", below.id);
        if (res.error) { alert("Move failed: " + res.error.message); return; }

        // me -> a
        res = await sb.from("workout_template_exercises").update({ order_index: a }).eq("id", me.id);
        if (res.error) { alert("Move failed: " + res.error.message); return; }

        // below(TEMP) -> b
        res = await sb.from("workout_template_exercises").update({ order_index: b }).eq("id", below.id);
        if (res.error) { alert("Move failed: " + res.error.message); return; }

        openProgramIds.add(t.id);
        lastProgramFocusId = t.id;
        await refreshTemplates();
      };

      const del = document.createElement("button");
      del.className = "secondary";
      del.textContent = "Remove";
      del.onclick = async (e) => {
        e.stopPropagation();
        const ok = confirm("Remove this exercise from the program?");
        if (!ok) return;

        const { error } = await sb.from("workout_template_exercises").delete().eq("id", x.id);
        if (error) alert(error.message);

        openProgramIds.add(t.id);
        lastProgramFocusId = t.id;
        await refreshTemplates();
      };

      actions.append(up, down, del);
      row.append(leftText, actions);
      ul.appendChild(row);
    });

    // search to add
    const search = document.createElement("input");
    search.placeholder = "Search exercises to add…";
    search.value = programSearchTerms.get(t.id) || "";

    const results = document.createElement("div");
    results.className = "stack";

    let searchReqId = 0;
    let searchTimer = null;

    search.addEventListener("input", (e) => {
      e.stopPropagation();
      clearTimeout(searchTimer);

      searchTimer = setTimeout(async () => {
        const term = search.value.trim();
        programSearchTerms.set(t.id, term);

        results.innerHTML = "";
        if (term.length < 2) return;

        const myReqId = ++searchReqId;

        let ex = [];
        try {
          ex = await loadExercises(term);
        } catch (err) {
          console.error(err);
          results.innerHTML = `<div class="muted">Error: ${String(err.message || err)}</div>`;
          return;
        }

        if (myReqId !== searchReqId) return;

        const seen = new Set();
        (ex || []).slice(0, 10).forEach((exRow) => {
          if (!exRow?.id || seen.has(exRow.id)) return;
          seen.add(exRow.id);

          const b = document.createElement("button");
          b.className = "secondary";
          b.textContent = `Add: ${exRow.name}`;

          b.onclick = async (ev) => {
            ev.stopPropagation();

            const already = current.some((r) => r.exercise_id === exRow.id);
            if (already) { alert("That exercise is already in this program."); return; }

            const { data: lastRow, error: lastErr } = await sb
              .from("workout_template_exercises")
              .select("order_index")
              .eq("template_id", t.id)
              .order("order_index", { ascending: false })
              .limit(1);

            if (lastErr) { alert(lastErr.message); return; }

            const nextIndex = (lastRow?.[0]?.order_index ?? -1) + 1;

            const { error: insErr } = await sb.from("workout_template_exercises").insert({
              template_id: t.id,
              exercise_id: exRow.id,
              order_index: nextIndex,
            });

            if (insErr) { alert(insErr.message); return; }

            openProgramIds.add(t.id);
            lastProgramFocusId = t.id;
            await refreshTemplates();
          };

          results.appendChild(b);
        });
      }, 120);
    });

    // Keep the program open + keep search/results after refresh
    if (isOpen && search.value.trim().length >= 2) {
      search.dispatchEvent(new Event("input"));
    }
    if (lastProgramFocusId === t.id) {
      setTimeout(() => search.focus(), 0);
      lastProgramFocusId = null;
    }

    const delTpl = document.createElement("button");
    delTpl.className = "secondary";
    delTpl.textContent = "Delete program";
    delTpl.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this program?")) return;

      const { error } = await sb.from("workout_templates").delete().eq("id", t.id);
      if (error) alert(error.message);

      openProgramIds.delete(t.id);
      programSearchTerms.delete(t.id);
      if (lastProgramFocusId === t.id) lastProgramFocusId = null;

      await refreshTemplates();
    };

    details.append(ul, search, results, delTpl);

    header.addEventListener("click", () => {
      const isHidden = details.classList.contains("hidden");
      if (isHidden) {
        details.classList.remove("hidden");
        chevron.textContent = "Hide ▴";
        openProgramIds.add(t.id);
      } else {
        details.classList.add("hidden");
        chevron.textContent = "Show ▾";
        openProgramIds.delete(t.id);
      }
    });

    card.append(header, details);
    list.appendChild(card);
  }
}

$("createTplBtn").addEventListener("click", async () => {
  const name = $("tplName").value.trim();
  if (!name) return;

  try {
    const userId = getUserIdOrThrow();

    await createTemplate(userId, name, "program"); // <-- NOT NULL now

    $("tplName").value = "";
    await refreshTemplates();
  } catch (err) {
    alert(String(err.message || err));
  }
});

// --------------------
// AUTOFILL: Two-call approach with simple order syntax
// --------------------
async function loadLastSetsByExercise(userId, exerciseIds) {
  if (!exerciseIds.length) return new Map();

  const idsStr = exerciseIds.join(",");

  // 1) Pull a bunch of recent workout_exercises for each exercise
  const weParams = new URLSearchParams();
  weParams.set("select", "id,exercise_id,workout_id");
  weParams.set("exercise_id", `in.(${idsStr})`);
  weParams.set("order", "workout_id.desc");
  weParams.set("limit", "10000");

  const weRows = (await fetchJSON(`/rest/v1/workout_exercises?${weParams.toString()}`)) || [];
  if (!weRows.length) return new Map();

  // 2) Fetch sets for ALL those workout_exercise ids
  const weIds = weRows.map((r) => r.id);
  const setParams = new URLSearchParams();
  setParams.set("select", "workout_exercise_id,weight,reps,set_index");
  setParams.set("workout_exercise_id", `in.(${weIds.join(",")})`);
  setParams.set("order", "workout_exercise_id.asc,set_index.asc");
  setParams.set("limit", "20000");

  const setRows = (await fetchJSON(`/rest/v1/sets?${setParams.toString()}`)) || [];

  const setsByWE = new Map();
  for (const s of setRows) {
    const arr = setsByWE.get(s.workout_exercise_id) || [];
    arr.push({
      set_index: s.set_index ?? 0,
      weight: s.weight ?? "",
      reps: s.reps ?? "",
    });
    setsByWE.set(s.workout_exercise_id, arr);
  }

  // 3) For each exercise, pick the newest workout_exercise that has sets
  const out = new Map();

  const wesByExercise = new Map();
  for (const r of weRows) {
    const arr = wesByExercise.get(r.exercise_id) || [];
    arr.push(r);
    wesByExercise.set(r.exercise_id, arr);
  }

  for (const exerciseId of exerciseIds) {
    const candidates = (wesByExercise.get(exerciseId) || []).sort(
      (a, b) => (b.workout_id ?? 0) - (a.workout_id ?? 0)
    );
    const withSets = candidates.find((we) => (setsByWE.get(we.id) || []).length > 0);
    if (!withSets) continue;

    const sets = (setsByWE.get(withSets.id) || [])
      .sort((a, b) => (a.set_index ?? 0) - (b.set_index ?? 0))
      .map((s, i) => ({ set_index: i, weight: s.weight ?? "", reps: s.reps ?? "" }));

    if (sets.length) out.set(exerciseId, sets);
  }

  return out;
}

// --------------------
// Workouts: create + add exercises + save sets
// --------------------
async function createWorkout(userId) {
  const body = [{ user_id: userId, performed_at: new Date().toISOString(), notes: null }];
  const created = await fetchJSON(`/rest/v1/workouts`, { method: "POST", body });
  return created?.[0];
}

async function createWorkoutExercises(workoutId, templateItems) {
  const body = templateItems.map((it) => ({
    workout_id: workoutId,
    exercise_id: it.exercise_id,
    order_index: it.order_index,
    group_id: it.group_id ?? null,
    group_order: it.group_order ?? null,
    original_group: it.group_id ?? null,
    is_skipped: false,
  }));

  const created = await fetchJSON(`/rest/v1/workout_exercises`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body,
  });

  return created || [];
}

async function insertSets(rows) {
  if (!rows.length) return;
  await fetchJSON(`/rest/v1/sets`, { method: "POST", body: rows });
}


function renderActiveWorkout() {
  const host = $("activeWorkout");
  if (!host) return;
  host.innerHTML = "";
  if (!activeWorkout) {
    host.innerHTML = `<div class="muted">Select a workout and get that pussy a poppin'!</div>`;
    return;
  }

  // Helpers for per-exercise sets UI
  function renderSetsUI(item, setsBox) {
    setsBox.innerHTML = "";
    item.sets.forEach((s, si) => {
      const row = document.createElement("div");
      row.className = "row";

      const w = document.createElement("input");
      w.placeholder = "weight";
      w.inputMode = "decimal";
      w.value = s.weight ?? "";
      w.oninput = () => (s.weight = w.value);

      const r = document.createElement("input");
      r.placeholder = "reps";
      r.inputMode = "numeric";
      r.value = s.reps ?? "";
      r.oninput = () => (s.reps = r.value);

const del = document.createElement("button");
del.className = "btn-set-remove";
del.textContent = "− set";
      del.onclick = () => {
        item.sets = item.sets
          .filter((_, j) => j !== si)
          .map((x, j) => ({ ...x, set_index: j }));
        renderSetsUI(item, setsBox);
      };

      row.append(w, r, del);
      setsBox.appendChild(row);
    });
  }

  function addSetButton(item, setsBox) {
    const addSet = document.createElement("button");
addSet.className = "btn-set-add";
addSet.textContent = "+ set";
    addSet.onclick = () => {
      item.sets.push({ set_index: item.sets.length, weight: "", reps: "" });
      renderSetsUI(item, setsBox);
    };
    return addSet;
  }

  // Group items by group_id (supersets). group_id null => standalone
  const items = (activeWorkout.items || []).filter((it) => !it.is_skipped);
  const groups = [];
  const seen = new Set();

  // deterministic order by order_index (or fallback)
  const ordered = [...items].sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));

  
  // DEBUG: show group ids on mobile

  for (const it of ordered) {
    if (seen.has(it.workoutExerciseId)) continue;

const gid = it.group_id ?? it.groupId ?? null;    if (!gid) {
      groups.push({ type: "single", items: [it] });
      seen.add(it.workoutExerciseId);
      continue;
    }

    const members = ordered
  .filter((x) => (x.group_id ?? x.groupId ?? null) === gid)
.sort((a, b) => ((a.group_order ?? a.groupOrder ?? 0) - (b.group_order ?? b.groupOrder ?? 0)));

    members.forEach((m) => seen.add(m.workoutExerciseId));
    groups.push({ type: "superset", group_id: gid, items: members.slice(0, 3) });
  }

  for (const g of groups) {
    if (g.type === "single") {
      const item = g.items[0];

      const card = document.createElement("div");
      card.className = "item";

      const h = document.createElement("div");
      h.className = "row";
      h.style.justifyContent = "space-between";
      h.style.alignItems = "center";

      const title = document.createElement("h3");
      title.textContent = item.exerciseName || "Exercise";

      const removeEx = document.createElement("button");
      removeEx.className = "secondary";
      removeEx.textContent = "Skip ⏭";
      removeEx.onclick = () => {
        // session-only: hide this exercise
        item.is_skipped = true;
        renderActiveWorkout();
      };

      h.append(title, removeEx);

      const setsBox = document.createElement("div");
      setsBox.className = "stack";
      renderSetsUI(item, setsBox);

      card.append(h, setsBox, addSetButton(item, setsBox));
      host.appendChild(card);
      continue;
    }

    // Superset card
    const members = g.items;

    const card = document.createElement("div");
    card.className = "item";
    card.classList.add("superset-card");

    const head = document.createElement("div");
    head.className = "row";
    head.style.justifyContent = "space-between";
    head.style.alignItems = "center";

    const label = document.createElement("h3");
    label.textContent = members.length === 2 ? "Superset" : "Tri-set";

    const ungroupBtn = document.createElement("button");
    ungroupBtn.className = "secondary";
    ungroupBtn.textContent = "Ungroup";
    ungroupBtn.onclick = () => {
      // session-only: remove grouping (does not touch the program/template)
      members.forEach((m) => {
        m.group_id = null;
        m.group_order = null;
      });
      renderActiveWorkout();
    };

    head.append(label, ungroupBtn);

    const grid = document.createElement("div");
    grid.className = "superset-grid";
    // inline fallback so it works even if css isn't updated yet
    grid.style.display = "grid";
    grid.style.gap = "12px";
    grid.style.gridTemplateColumns = `repeat(${members.length}, minmax(0, 1fr))`;

    members.forEach((item, idx) => {
      const col = document.createElement("div");
      col.className = "superset-col";

      const colHead = document.createElement("div");
      colHead.className = "row";
      colHead.style.justifyContent = "space-between";
      colHead.style.alignItems = "center";

      const t = document.createElement("div");
      t.style.fontWeight = "700";
      t.textContent = item.exerciseName || `Exercise ${idx + 1}`;

      const hideBtn = document.createElement("button");
      hideBtn.className = "secondary";
      hideBtn.textContent = "Remove";
      hideBtn.onclick = () => {
        item.is_skipped = true; // session-only
        renderActiveWorkout();
      };

      colHead.append(t, hideBtn);

      const setsBox = document.createElement("div");
      setsBox.className = "stack";
      renderSetsUI(item, setsBox);

      col.append(colHead, setsBox, addSetButton(item, setsBox));
      grid.appendChild(col);
    });

    card.append(head, grid);
    host.appendChild(card);
  }
}
// Start workout (autofill last set if available)
$("startWorkoutBtn").addEventListener("click", async () => {
  const btn = $("startWorkoutBtn");
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "Loading...";

  try {
    setWorkoutMsg("");

    const templateId = $("startTplSelect").value;
    if (!templateId) throw new Error("Pick a template first.");

    const tpl = (cachedTemplates || []).find((t) => t.id === templateId);
    if (!tpl) throw new Error("Template not found. Go to Templates tab and refresh.");
    if (!tpl.items || tpl.items.length === 0) throw new Error("This template has no exercises yet.");

    const userId = getUserIdOrThrow();

    // AUTOFILL attempt (non-blocking)
    const exerciseIds = (tpl.items || []).map((it) => it.exercise_id).filter(Boolean);
    let lastSetsMap = new Map();
    try {
      lastSetsMap = await loadLastSetsByExercise(userId, exerciseIds);
    } catch (e) {
      console.warn("Autofill failed (non-blocking):", e);
      lastSetsMap = new Map();
    }

    const workout = await createWorkout(userId);
    if (!workout?.id) throw new Error("Failed to create workout.");

    const weInserted = await createWorkoutExercises(workout.id, tpl.items);

    const nameByExerciseId = new Map((tpl.items || []).map((it) => [it.exercise_id, it.exercise_name]));

    // ✅ Map template item by exercise_id (used to pull group_id/group_order if DB insert doesn't return them)
    const tplByExerciseId = new Map((tpl.items || []).map((it) => [String(it.exercise_id), it]));

    // ✅ Superset grouping from localStorage (fallback)
    const ssMap = loadSupersetMap(templateId);

    activeWorkout = {
      workoutId: workout.id,
      items: (weInserted || [])
        .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
        .map((we) => {
          const prevSets = lastSetsMap.get(we.exercise_id) || [];
          const tplItem = tplByExerciseId.get(String(we.exercise_id)) || {};

          // ✅ superset id from localStorage
          const ssId = ssMap?.get(String(we.exercise_id)) || null;

          // ✅ derive group id & order (this fixes your "gid not defined" error)
          const gid = we.group_id ?? tplItem.group_id ?? ssId ?? null;
          const gorder = we.group_order ?? tplItem.group_order ?? null;

          // ✅ only keep LAST set for autofill
          let sets;
          if (!prevSets.length) {
            sets = [{ set_index: 0, weight: "", reps: "" }];
          } else {
            const last = prevSets[prevSets.length - 1];
            sets = [{
              set_index: 0,
              weight: last.weight ?? "",
              reps: last.reps ?? "",
            }];
          }

          return {
            workoutExerciseId: we.id,
            exerciseId: we.exercise_id,
            exerciseName: nameByExerciseId.get(we.exercise_id) || "Exercise",
            order_index: we.order_index ?? 0,

            // ✅ important for grouping into same card
            group_id: gid,
            group_order: gorder,
            original_group: we.original_group ?? gid,

            is_skipped: we.is_skipped ?? false,

            // keep for debugging (optional)
            supersetId: ssId,

            sets,
          };
        }),
    };

    // --- Avoid window collision with DOM id "activeWorkout" by writing to a safe global ---
    window.__workoutState = activeWorkout;
    window.__workoutStateLastUpdated = Date.now();
    // -------------------------------------------------------------------------------

    renderActiveWorkout();
    show($("saveWorkoutBtn"));
    setWorkoutMsg("Workout started. Autofilled last weights/reps (if available).");
  } catch (err) {
    console.error(err);
    alert(String(err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});
// --------------------
// Progress + PR detection (NEW)
// --------------------

// Pull recent workout ids for user (so we can avoid fragile nested PostgREST filters)
async function loadRecentWorkoutIds(userId, limit = 2000) {
  const p = new URLSearchParams();
  p.set("select", "id,performed_at");
  p.set("user_id", `eq.${userId}`);
  p.set("order", "performed_at.desc");
  p.set("limit", String(limit));
  return (await fetchJSON(`/rest/v1/workouts?${p.toString()}`)) || [];
}

// Pull all sets for ONE exercise across recent workouts (chunked)
async function loadExerciseHistory(userId, exerciseId, { workoutLimit = 2000 } = {}) {
  const workouts = await loadRecentWorkoutIds(userId, workoutLimit);
  if (!workouts.length) return [];

  const workoutIds = workouts.map(w => w.id);
  const workoutDateById = new Map(workouts.map(w => [w.id, w.performed_at]));

  // 1) workout_exercises for those workouts, filtered to exerciseId
  const weRows = [];
  for (const idsChunk of chunk(workoutIds, 150)) {
    const p = new URLSearchParams();
    p.set("select", "id,workout_id,exercise_id,order_index");
    p.set("workout_id", `in.(${idsChunk.join(",")})`);
    p.set("exercise_id", `eq.${exerciseId}`);
    p.set("limit", "10000");
    const rows = (await fetchJSON(`/rest/v1/workout_exercises?${p.toString()}`)) || [];
    weRows.push(...rows);
  }

  if (!weRows.length) return [];

  const weIds = weRows.map(r => r.id);

  // 2) sets for those workout_exercise ids
  const setRows = [];
  for (const idsChunk of chunk(weIds, 150)) {
    const p = new URLSearchParams();
    p.set("select", "workout_exercise_id,set_index,weight,reps");
    p.set("workout_exercise_id", `in.(${idsChunk.join(",")})`);
    p.set("order", "workout_exercise_id.asc,set_index.asc");
    p.set("limit", "20000");
    const rows = (await fetchJSON(`/rest/v1/sets?${p.toString()}`)) || [];
    setRows.push(...rows);
  }

  // stitch into sessions by workout_id
  const weById = new Map(weRows.map(r => [r.id, r]));
  const setsByWorkout = new Map(); // workout_id -> sets[]
  for (const s of setRows) {
    const we = weById.get(s.workout_exercise_id);
    if (!we) continue;
    const wid = we.workout_id;
    const arr = setsByWorkout.get(wid) || [];
    arr.push({
      workout_id: wid,
      performed_at: workoutDateById.get(wid) || null,
      weight: s.weight,
      reps: s.reps,
      set_index: s.set_index ?? 0,
    });
    setsByWorkout.set(wid, arr);
  }

  // finalize: one row per workout for this exercise
  const out = [];
  for (const [wid, sets] of setsByWorkout.entries()) {
    const cleanSets = sets
      .slice()
      .sort((a, b) => (a.set_index ?? 0) - (b.set_index ?? 0))
      .map(s => ({
        set_index: s.set_index ?? 0,
        weight: s.weight,
        reps: s.reps,
      }));

    const top = bestSet(cleanSets) || null;
    const volume = cleanSets.reduce((sum, s) => {
      const w = Number(s.weight);
      const r = Number(s.reps);
      if (!Number.isFinite(w) || !Number.isFinite(r)) return sum;
      return sum + (w * r);
    }, 0);

    out.push({
      workout_id: wid,
      performed_at: workouts.find(x => x.id === wid)?.performed_at || null,
      sets: cleanSets,
      best_weight: top?.weight ?? null,
      best_reps: top?.reps ?? null,
      best_e1rm: top?.e1rm ?? null,
      volume,
    });
  }

  out.sort((a, b) => new Date(b.performed_at) - new Date(a.performed_at));
  return out;
}

function computePRsFromHistory(historyRows) {
  let maxWeight = null;
  let bestE1 = null;

  for (const row of historyRows) {
    for (const s of row.sets || []) {
      const w = Number(s.weight);
      const r = Number(s.reps);
      if (Number.isFinite(w)) {
        if (maxWeight == null || w > maxWeight) maxWeight = w;
      }
      const e1 = epley1RM(w, r);
      if (e1 != null) {
        if (bestE1 == null || e1 > bestE1) bestE1 = e1;
      }
    }
  }

  return { maxWeight, bestE1RM: bestE1 };
}

async function detectPRsForWorkout(userId, workoutItems) {
  // workoutItems: [{exerciseId, exerciseName, sets:[{weight,reps}]}]
  const results = [];

  const exerciseIds = uniq(workoutItems.map(it => it.exerciseId).filter(Boolean));
  for (const exId of exerciseIds) {
    const item = workoutItems.find(it => it.exerciseId === exId);
    const name = item?.exerciseName || "Exercise";

    const currentSets = (workoutItems
      .filter(it => it.exerciseId === exId)
      .flatMap(it => it.sets || [])
      .map(s => ({ weight: numOrNull(s.weight), reps: numOrNull(s.reps) }))
      .filter(s => s.weight != null || s.reps != null))
      .map(s => ({ ...s, e1rm: epley1RM(s.weight, s.reps) }));

    const curMaxWeight = currentSets.reduce((m, s) => (s.weight != null ? Math.max(m, s.weight) : m), -Infinity);
    const curBestE1 = currentSets.reduce((m, s) => (s.e1rm != null ? Math.max(m, s.e1rm) : m), -Infinity);

    // history excluding "right now" is hard without joining; simplest = compute PRs, then compare using <=
    // If you want exact exclusion of current workout, we can add later.
    const hist = await loadExerciseHistory(userId, exId, { workoutLimit: 2000 });
    const prs = computePRsFromHistory(hist);

    const hitMaxW = (curMaxWeight !== -Infinity) && (prs.maxWeight == null || curMaxWeight > prs.maxWeight);
    const hitE1 = (curBestE1 !== -Infinity) && (prs.bestE1RM == null || curBestE1 > prs.bestE1RM);

    if (hitMaxW || hitE1) {
      results.push({
        exerciseId: exId,
        exerciseName: name,
        newMaxWeight: hitMaxW ? curMaxWeight : null,
        newBestE1RM: hitE1 ? curBestE1 : null,
      });
    }
  }

  return results;
}

// Progress UI wiring
let progressSearchTimer = null;

async function renderProgressExercise(exerciseId, exerciseName) {
  const view = $("progressView");
  view.innerHTML = "Loading...";

  let userId;
  try { userId = getUserIdOrThrow(); }
  catch { view.innerHTML = `<div class="muted">Not signed in.</div>`; return; }

  try {
    const hist = await loadExerciseHistory(userId, exerciseId, { workoutLimit: 2000 });
    if (!hist.length) {
      view.innerHTML = `<div class="muted">No history found for <b>${exerciseName}</b> yet.</div>`;
      return;
    }

    const prs = computePRsFromHistory(hist);

    const prCard = document.createElement("div");
    prCard.className = "item";
    prCard.innerHTML = `
      <h3>${exerciseName}</h3>
      <div class="small">
        <b>PR (Max weight):</b> ${prs.maxWeight == null ? "—" : prs.maxWeight}<br/>
        <b>PR (Best e1RM):</b> ${prs.bestE1RM == null ? "—" : prs.bestE1RM.toFixed(1)}
      </div>
    `;

    const table = document.createElement("div");
    table.className = "item";

    const rowsHtml = hist.slice(0, 25).map((r) => {
      const dt = r.performed_at ? new Date(r.performed_at).toLocaleString() : "—";
      const best = (r.best_weight != null || r.best_reps != null)
        ? `${r.best_weight ?? "—"} × ${r.best_reps ?? "—"}`
        : "—";
      const e1 = r.best_e1rm != null ? r.best_e1rm.toFixed(1) : "—";
      const vol = Number.isFinite(r.volume) ? Math.round(r.volume) : "—";
      return `<tr>
        <td>${dt}</td>
        <td>${best}</td>
        <td>${e1}</td>
        <td>${vol}</td>
      </tr>`;
    }).join("");

    table.innerHTML = `
      <div class="row" style="justify-content: space-between; align-items: center;">
        <h3 style="margin:0;">Recent sessions</h3>
        <div class="small muted">Showing latest 25</div>
      </div>
      <div style="overflow:auto;">
        <table style="width:100%; border-collapse: collapse;">
          <thead>
            <tr>
              <th style="text-align:left; padding:6px 4px;">Date</th>
              <th style="text-align:left; padding:6px 4px;">Best set</th>
              <th style="text-align:left; padding:6px 4px;">Best e1RM</th>
              <th style="text-align:left; padding:6px 4px;">Volume</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;

    view.innerHTML = "";
    view.append(prCard, table);
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="muted">Error loading progress: ${String(err.message || err)}</div>`;
  }
}

function wireProgressSearch() {
  const input = $("progressSearch");
  const results = $("progressSearchResults");
  const view = $("progressView");
  if (!input || !results || !view) return;

  input.addEventListener("input", () => {
    clearTimeout(progressSearchTimer);
    progressSearchTimer = setTimeout(async () => {
      const term = input.value.trim();
      results.innerHTML = "";
      view.innerHTML = "";
      if (term.length < 2) return;

      try {
        const ex = await loadExercises(term);
        if (!ex || !ex.length) {
          results.innerHTML = `<div class="muted">No matches.</div>`;
          return;
        }

        ex.slice(0, 10).forEach((row) => {
          const b = document.createElement("button");
          b.className = "secondary";
          b.textContent = row.name;
          b.onclick = () => {
            results.innerHTML = "";
            input.value = row.name;
            renderProgressExercise(row.id, row.name);
          };
          results.appendChild(b);
        });
      } catch (e) {
        console.error(e);
        results.innerHTML = `<div class="muted">Error searching exercises.</div>`;
      }
    }, 250);
  });
}

// Save workout sets (+ PR detection)
$("saveWorkoutBtn").addEventListener("click", async () => {
  if (!activeWorkout) return;

  const btn = $("saveWorkoutBtn");
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "Saving...";

  try {
    const userId = getUserIdOrThrow();

    const rows = [];
    for (const item of activeWorkout.items) {
      if (item.isSkipped) continue;
      for (const s of item.sets) {
        const hasAny =
          String(s.weight).trim() !== "" || String(s.reps).trim() !== "";
        if (!hasAny) continue;

        rows.push({
          workout_exercise_id: item.workoutExerciseId,
          set_index: s.set_index,
          weight: String(s.weight).trim() === "" ? null : Number(s.weight),
          reps: String(s.reps).trim() === "" ? null : Number(s.reps),
          is_warmup: false,
        });
      }
    }

    await insertSets(rows);

    // PR detection (best-effort; don’t block save UX)
    let prMsg = "";
    try {
      const prs = await detectPRsForWorkout(userId, activeWorkout.items);
      if (prs.length) {
        const lines = prs.map((p) => {
          const bits = [];
          if (p.newMaxWeight != null) bits.push(`Max weight PR: ${p.newMaxWeight}`);
          if (p.newBestE1RM != null) bits.push(`e1RM PR: ${p.newBestE1RM.toFixed(1)}`);
          return `🏆 ${p.exerciseName} — ${bits.join(" | ")}`;
        });
        prMsg = "\n" + lines.join("\n");
      }
    } catch (e) {
      console.warn("PR detection failed (non-blocking):", e);
    }

    setWorkoutMsg(`Saved ✅${prMsg}`);
    activeWorkout = null;
    hide($("saveWorkoutBtn"));
    renderActiveWorkout();
    await refreshHistory();

  } catch (err) {
    console.error(err);
    alert(String(err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

// --------------------
// History (last 20 workouts summary)
// --------------------
function historyFilterToQuery(filterValue) {
  // returns { limit, performedAfterISO } where performedAfterISO can be null
  const now = new Date();

  if (filterValue === "7d") {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    return { limit: 5000, performedAfterISO: d.toISOString() };
  }

  if (filterValue === "30d") {
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    return { limit: 5000, performedAfterISO: d.toISOString() };
  }

  if (filterValue === "all") {
    return { limit: 5000, performedAfterISO: null };
  }

  // numeric limits like "20", "50", "200"
  const limit = Number(filterValue);
  return { limit: Number.isFinite(limit) ? limit : 20, performedAfterISO: null };
}

async function loadHistory(userId, filterValue) {
  const { limit, performedAfterISO } = historyFilterToQuery(filterValue);

  const params = new URLSearchParams();
  params.set("select", "id,performed_at,notes");
  params.set("user_id", `eq.${userId}`);
  params.set("order", "performed_at.desc");
  params.set("limit", String(limit));

  if (performedAfterISO) {
    params.set("performed_at", `gte.${performedAfterISO}`);
  }

  const workouts = (await fetchJSON(`/rest/v1/workouts?${params.toString()}`)) || [];
  if (!workouts.length) return [];

  const ids = workouts.map((w) => w.id).join(",");

  const weParams = new URLSearchParams();
  weParams.set("select", "workout_id");
  weParams.set("workout_id", `in.(${ids})`);

  const wes = (await fetchJSON(`/rest/v1/workout_exercises?${weParams.toString()}`)) || [];

  const counts = new Map();
  wes.forEach((r) => counts.set(r.workout_id, (counts.get(r.workout_id) || 0) + 1));

  return workouts.map((w) => ({ ...w, exercise_count: counts.get(w.id) || 0 }));
}

async function refreshHistory() {
  const host = $("historyList");
  const detail = $("historyDetail");

  detail.classList.add("hidden");
  detail.innerHTML = "";
  host.classList.remove("hidden");

  host.innerHTML = "Loading...";

  let userId;
  try {
    userId = getUserIdOrThrow();
  } catch {
    host.innerHTML = '<div class="muted">Not signed in.</div>';
    return;
  }

  try {
const filterValue = $("historyFilter")?.value || "20"; // whatever you set as default
const rows = await loadHistory(userId, filterValue);
    host.innerHTML = "";

    if (!rows.length) {
      host.innerHTML = '<div class="muted">No workouts yet. Start one in the Workout tab.</div>';
      return;
    }

    rows.forEach((w) => {
      const card = document.createElement("div");
      card.className = "item";
      card.style.cursor = "pointer";

      const dateOnly = new Date(w.performed_at).toLocaleDateString(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const programName =
  w.workout_templates?.name ||
  w.template_name ||
  w.program_name ||
  "Workout";

const exCount = w.exercise_count ?? 0;

card.innerHTML = `
  <h3>${programName}</h3>
  <div class="small muted">${dateOnly}</div>
  <div class="small">${exCount} exercises</div>
`;
      card.addEventListener("click", () => showWorkoutDetail(w.id));

      host.appendChild(card);
    });
  } catch (err) {
    console.error(err);
    host.innerHTML = `<div class="muted">Error loading history: ${String(err.message || err)}</div>`;
  }
}

function fmtSet(s) {
  const w = s.weight == null ? "—" : s.weight;
  const r = s.reps == null ? "—" : s.reps;
  return `${w} × ${r}`;
}

async function loadWorkoutDetail(workoutId) {
  const { data, error } = await sb
    .from("workouts")
    .select(`
      id,
      performed_at,
      notes,
      workout_templates ( name ),
      workout_exercises (
        id,
        order_index,
        exercises ( id, name ),
        sets ( set_index, weight, reps )
      )
    `)
    .eq("id", workoutId)
    .single();

  if (error) throw error;

  const wes = (data.workout_exercises || [])
    .slice()
    .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
    .map((we) => ({
      ...we,
      sets: (we.sets || []).slice().sort((a, b) => (a.set_index ?? 0) - (b.set_index ?? 0)),
    }));

  return { ...data, workout_exercises: wes };
}
async function deleteWorkoutCascade(workoutId) {
  // 1) load workout_exercise ids
  const weParams = new URLSearchParams();
  weParams.set("select", "id");
  weParams.set("workout_id", `eq.${workoutId}`);
  weParams.set("limit", "5000");

  const weRows = (await fetchJSON(`/rest/v1/workout_exercises?${weParams.toString()}`)) || [];
  const weIds = weRows.map((r) => r.id).filter(Boolean);

  // 2) delete sets
  if (weIds.length) {
    const setParams = new URLSearchParams();
    setParams.set("workout_exercise_id", `in.(${weIds.join(",")})`);
    await fetchJSON(`/rest/v1/sets?${setParams.toString()}`, { method: "DELETE" });
  }

  // 3) delete workout_exercises
  await fetchJSON(`/rest/v1/workout_exercises?workout_id=eq.${workoutId}`, { method: "DELETE" });

  // 4) delete workout
  await fetchJSON(`/rest/v1/workouts?id=eq.${workoutId}`, { method: "DELETE" });
}

async function showWorkoutDetail(workoutId) {
  const detail = $("historyDetail");
  const list = $("historyList");

  detail.classList.remove("hidden");
  list.classList.add("hidden");
  detail.innerHTML = "Loading...";

  const w = await loadWorkoutDetail(workoutId);

  const wrap = document.createElement("div");
  wrap.className = "item";

  const header = document.createElement("div");
  header.className = "row";
  header.style.justifyContent = "space-between";
  header.style.alignItems = "center";

  const title = document.createElement("h3");
  title.textContent = new Date(w.performed_at).toLocaleString();

  const back = document.createElement("button");
  back.className = "secondary";
  back.textContent = "Back";
  back.onclick = () => {
    detail.classList.add("hidden");
    list.classList.remove("hidden");
    detail.innerHTML = "";
  };

const actions = document.createElement("div");
actions.className = "row";
actions.style.gap = "8px";

const del = document.createElement("button");
del.className = "secondary";
del.textContent = "Delete workout";
del.onclick = async () => {
  const ok = confirm("Delete this workout from history? This cannot be undone.");
  if (!ok) return;

  try {
    await deleteWorkoutCascade(workoutId);

    detail.classList.add("hidden");
    list.classList.remove("hidden");
    detail.innerHTML = "";

    await refreshHistory();
  } catch (e) {
    console.error(e);
    alert(`Failed to delete workout: ${String(e.message || e)}`);
  }
};

actions.append(del, back);
header.append(title, actions);
  wrap.appendChild(header);

  (w.workout_exercises || []).forEach((we, i) => {
    const ex = document.createElement("div");
    ex.className = "item";

    const name = we.exercises?.name || "Exercise";
    const sets = we.sets || [];

    ex.innerHTML = `
      <div><b>${i + 1}. ${name}</b></div>
      <div class="small">
        ${sets.length ? sets.map((s, idx) => `Set ${idx + 1}: ${fmtSet(s)}`).join("<br/>") : "No sets saved"}
      </div>
    `;

    wrap.appendChild(ex);
  });

  detail.innerHTML = "";
  detail.appendChild(wrap);
}
$("historyFilter")?.addEventListener("change", refreshHistory);
const menuToggle = document.getElementById("menuToggle");
const menuDropdown = document.getElementById("menuDropdown");

if (menuToggle && menuDropdown) {
  menuToggle.addEventListener("click", () => {
    menuDropdown.classList.toggle("hidden");
  });

  // Close menu if clicking outside
  document.addEventListener("click", (e) => {
    if (!menuDropdown.contains(e.target) && !menuToggle.contains(e.target)) {
      menuDropdown.classList.add("hidden");
    }
  });
}
// --------------------
// Bootstrap / refreshAll
// --------------------
async function refreshAll() {
  // Run in parallel so one failure/hang doesn't freeze the whole app
  const results = await Promise.allSettled([
    refreshTemplates(),
    refreshHistory(),
  ]);

  // If either failed, log it (you’ll see it in console)
  results.forEach((r) => {
    if (r.status === "rejected") console.error(r.reason);
  });

  // Library load should still happen even if templates/history fails
  try {
    const list = $("exerciseList");
    list.innerHTML = "Loading...";
    const ex = await withTimeout(loadExercises(""), 8000, "loadExercises");
    list.innerHTML = "";
    (ex || []).slice(0, 80).forEach((e) => {
      const card = document.createElement("div");
      card.className = "item";
      card.innerHTML = `
  <h3>${e.name}</h3>
  ${renderVideoThumb(e.video_link)}
`;
      list.appendChild(card);
    });
  } catch (err) {
    console.error(err);
    $("exerciseList").innerHTML = `<div class="muted">Error: ${String(err.message || err)}</div>`;
  }

  wireProgressSearch();
  renderActiveWorkout();
  // Set default tab to Workout
document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
const workoutTabBtn = document.querySelector('.tab[data-tab="workout"]');
if (workoutTabBtn) {
  workoutTabBtn.classList.add("active");
}
["templates","workout","library","history","progress"].forEach((t) => {
  const panel = document.getElementById(`tab-${t}`);
  if (panel) panel.classList.add("hidden");
});
const workoutPanel = document.getElementById("tab-workout");
if (workoutPanel) workoutPanel.classList.remove("hidden");

}


sb.auth.onAuthStateChange(async (_event, session) => {
  const user = session?.user || null;
  currentUserId = user?.id || null;
  currentAccessToken = session?.access_token || null;
  renderUserBar(user);

  if (user) {
    hide($("authSection"));
    show($("appSection"));
    await refreshAll();
  } else {
    show($("authSection"));
    hide($("appSection"));
  }
});

// initial session check
(async () => {
  try {
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;

    const session = data?.session || null;
    const user = session?.user || null;

    currentUserId = user?.id || null;
    currentAccessToken = session?.access_token || null;

    renderUserBar(user);

    if (user) {
      hide($("authSection"));
      show($("appSection"));

      // Default to Workout tab on initial load
document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
const workoutTabBtn = document.querySelector('.tab[data-tab="workout"]');
if (workoutTabBtn) workoutTabBtn.classList.add("active");

["templates","workout","library","history","progress"].forEach((t) => {
  const panel = document.getElementById(`tab-${t}`);
  if (panel) panel.classList.add("hidden");
});
const workoutPanel = document.getElementById("tab-workout");
if (workoutPanel) workoutPanel.classList.remove("hidden");
      
      document.body.classList.remove("app-loading");
      await refreshAll();
      
    } else {
      show($("authSection"));
      hide($("appSection"));
      document.body.classList.remove("app-loading");
    }
  } catch (e) {
    console.error("Initial session check failed:", e);
    show($("authSection"));
    hide($("appSection"));
    document.body.classList.remove("app-loading");
  }
})();
