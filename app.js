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
let activeWorkout = null; // { workoutId, items: [{ workoutExerciseId, exerciseName, sets: [{set_index, weight, reps}] }] }

// --- DOM helpers ---
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
function setAuthMsg(msg) { $("authMsg").textContent = msg || ""; }
function setWorkoutMsg(msg) { $("workoutMsg").textContent = msg || ""; }

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
// Tabs UI
// --------------------
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    ["templates", "workout", "library", "history"].forEach((t) => hide($(`tab-${t}`)));
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
  params.set("select", "id,name,primary_muscle,equipment");
  params.set("order", "name.asc");
  params.set("limit", "80");
  if (term) params.set("name", `ilike.*${term.replaceAll("*", "")}*`);
  return await fetchJSON(`/rest/v1/exercises?${params.toString()}`);
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
      card.innerHTML = `<h3>${e.name}</h3><div class="small">${e.primary_muscle || ""} - ${e.equipment || ""}</div>`;
      list.appendChild(card);
    });
    if (!ex || ex.length === 0) list.innerHTML = `<div class="muted">No exercises found.</div>`;
  } catch (err) {
    console.error(err);
    list.innerHTML = `<div class="muted">Error: ${String(err.message || err)}</div>`;
  }
});

// --------------------
// Templates (user-owned)
// --------------------
async function loadTemplatesFull(userId) {
  const tParams = new URLSearchParams();
  tParams.set("select", "id,name,split_type,created_at");
  tParams.set("user_id", `eq.${userId}`);
  tParams.set("order", "created_at.desc");
  const templates = await fetchJSON(`/rest/v1/workout_templates?${tParams.toString()}`) || [];
  if (templates.length === 0) return [];

  const ids = templates.map((t) => t.id).join(",");

  const teParams = new URLSearchParams();
  teParams.set("select", "id,template_id,exercise_id,order_index");
  teParams.set("template_id", `in.(${ids})`);
  teParams.set("order", "order_index.asc");
  const tex = await fetchJSON(`/rest/v1/workout_template_exercises?${teParams.toString()}`) || [];

  const exIds = [...new Set(tex.map((r) => r.exercise_id))];
  let exMap = new Map();
  if (exIds.length) {
    const exParams = new URLSearchParams();
    exParams.set("select", "id,name");
    exParams.set("id", `in.(${exIds.join(",")})`);
    const exRows = await fetchJSON(`/rest/v1/exercises?${exParams.toString()}`) || [];
    exMap = new Map(exRows.map((e) => [e.id, e.name]));
  }

  const byTemplate = new Map();
  tex.forEach((r) => {
    const arr = byTemplate.get(r.template_id) || [];
    arr.push({
      id: r.id,
      template_id: r.template_id,
      exercise_id: r.exercise_id,
      order_index: r.order_index,
      exercise_name: exMap.get(r.exercise_id) || "Exercise",
    });
    byTemplate.set(r.template_id, arr);
  });

  return templates.map((t) => ({
    ...t,
    items: (byTemplate.get(t.id) || []).sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0)),
  }));
}

async function createTemplate(userId, name, split_type) {
  const body = [{ user_id: userId, name, split_type }];
  const created = await fetchJSON(`/rest/v1/workout_templates`, { method: "POST", body });
  return created?.[0];
}
async function deleteTemplate(templateId) {
  await fetchJSON(`/rest/v1/workout_templates?id=eq.${templateId}`, { method: "DELETE" });
}
async function addTemplateExercise(templateId, exerciseId, orderIndex) {
  const body = [{ template_id: templateId, exercise_id: exerciseId, order_index: orderIndex }];
  await fetchJSON(`/rest/v1/workout_template_exercises`, { method: "POST", body });
}
async function deleteTemplateExercise(wteId) {
  await fetchJSON(`/rest/v1/workout_template_exercises?id=eq.${wteId}`, { method: "DELETE" });
}
async function updateTemplateExerciseOrder(wteId, newOrder) {
  await fetchJSON(`/rest/v1/workout_template_exercises?id=eq.${wteId}`, {
    method: "PATCH",
    body: { order_index: newOrder },
  });
}
async function reindexTemplate(templateId) {
  const p = new URLSearchParams();
  p.set("select", "id,order_index");
  p.set("template_id", `eq.${templateId}`);
  p.set("order", "order_index.asc");
  const rows = await fetchJSON(`/rest/v1/workout_template_exercises?${p.toString()}`) || [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].order_index !== i) await updateTemplateExerciseOrder(rows[i].id, i);
  }
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
  try { userId = getUserIdOrThrow(); }
  catch { list.innerHTML = `<div class="muted">Not signed in.</div>`; return; }

  try {
    cachedTemplates = await loadTemplatesFull(userId);
  } catch (err) {
    console.error(err);
    list.innerHTML = `<div class="muted">Error loading templates: ${String(err.message || err)}</div>`;
    return;
  }

  refreshStartWorkoutDropdown();

  list.innerHTML = "";
  if (!cachedTemplates.length) {
    list.innerHTML = `<div class="muted">No templates yet. Create one above.</div>`;
    return;
  }

  for (const t of cachedTemplates) {
    const card = document.createElement("div");
    card.className = "item";

    const h = document.createElement("h3");
    h.textContent = t.name;
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = t.split_type;
    h.appendChild(pill);

    const meta = document.createElement("div");
    meta.className = "small";
    meta.textContent = `${t.items.length} exercises`;

    const stack = document.createElement("div");
    stack.className = "stack";

    t.items.forEach((it, idx) => {
      const row = document.createElement("div");
      row.className = "item";
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.gap = "8px";

      const left = document.createElement("div");
      left.innerHTML = `<b>${idx + 1}.</b> ${it.exercise_name}`;

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.gap = "6px";

      const up = document.createElement("button");
      up.className = "secondary";
      up.textContent = "↑";
      up.disabled = idx === 0;
      up.onclick = async () => {
        const a = t.items[idx];
        const b = t.items[idx - 1];
        await updateTemplateExerciseOrder(a.id, b.order_index);
        await updateTemplateExerciseOrder(b.id, a.order_index);
        await refreshTemplates();
      };

      const down = document.createElement("button");
      down.className = "secondary";
      down.textContent = "↓";
      down.disabled = idx === t.items.length - 1;
      down.onclick = async () => {
        const a = t.items[idx];
        const b = t.items[idx + 1];
        await updateTemplateExerciseOrder(a.id, b.order_index);
        await updateTemplateExerciseOrder(b.id, a.order_index);
        await refreshTemplates();
      };

      const remove = document.createElement("button");
      remove.className = "secondary";
      remove.textContent = "Remove";
      remove.onclick = async () => {
        await deleteTemplateExercise(it.id);
        await reindexTemplate(t.id);
        await refreshTemplates();
      };

      right.append(up, down, remove);
      row.append(left, right);
      stack.appendChild(row);
    });

    const search = document.createElement("input");
    search.placeholder = "Search exercises to add…";
    search.disabled = false;

    const results = document.createElement("div");
    results.className = "stack";

    let lastReq = 0;
    search.addEventListener("input", async () => {
      const term = search.value.trim();
      results.innerHTML = "";
      if (term.length < 2) return;

      const reqId = ++lastReq;
      try {
        const ex = await loadExercises(term);
        if (reqId !== lastReq) return;

        (ex || []).slice(0, 10).forEach((e) => {
          const b = document.createElement("button");
          b.className = "secondary";
          b.textContent = `Add: ${e.name}`;
          b.onclick = async () => {
            if (t.items.some((x) => x.exercise_id === e.id)) return alert("Already in template.");
            await addTemplateExercise(t.id, e.id, t.items.length);
            search.value = "";
            results.innerHTML = "";
            await refreshTemplates();
          };
          results.appendChild(b);
        });
      } catch (err) {
        console.error(err);
        results.innerHTML = `<div class="muted">Search error: ${String(err.message || err)}</div>`;
      }
    });

    const delTpl = document.createElement("button");
    delTpl.className = "secondary";
    delTpl.textContent = "Delete template";
    delTpl.onclick = async () => {
      if (!confirm("Delete this template?")) return;
      await deleteTemplate(t.id);
      await refreshTemplates();
    };

    card.append(h, meta, stack, search, results, delTpl);
    list.appendChild(card);
  }
}

$("createTplBtn").addEventListener("click", async () => {
  const name = $("tplName").value.trim();
  const split_type = $("tplSplit").value;
  if (!name) return;
  try {
    const userId = getUserIdOrThrow();
    await createTemplate(userId, name, split_type);
    $("tplName").value = "";
    await refreshTemplates();
  } catch (err) {
    alert(String(err.message || err));
  }
});

// --------------------
// AUTOFILL (FIXED): Two-call approach with simple order syntax
// --------------------
async function loadLastSetsByExercise(userId, exerciseIds) {
  if (!exerciseIds.length) return new Map();

  const idsStr = exerciseIds.join(",");

  // 1) Pull a bunch of recent workout_exercises for each exercise
  const weParams = new URLSearchParams();
  weParams.set("select", "id,exercise_id,workout_id");
  weParams.set("exercise_id", `in.(${idsStr})`);
  weParams.set("order", "workout_id.desc");
  weParams.set("limit", "10000"); // more rows so we can find one with sets

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

  // group WEs by exercise
  const wesByExercise = new Map();
  for (const r of weRows) {
    const arr = wesByExercise.get(r.exercise_id) || [];
    arr.push(r);
    wesByExercise.set(r.exercise_id, arr);
  }

  for (const exerciseId of exerciseIds) {
    const candidates = (wesByExercise.get(exerciseId) || []).sort((a, b) => (b.workout_id ?? 0) - (a.workout_id ?? 0));
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
  }));
  const created = await fetchJSON(`/rest/v1/workout_exercises`, { method: "POST", body });
  return created || [];
}
async function insertSets(rows) {
  if (!rows.length) return;
  await fetchJSON(`/rest/v1/sets`, { method: "POST", body: rows });
}

function renderActiveWorkout() {
  const host = $("activeWorkout");
  host.innerHTML = "";
  if (!activeWorkout) {
    host.innerHTML = `<div class="muted">No active workout. Choose a template and press Start.</div>`;
    return;
  }

  activeWorkout.items.forEach((item, idx) => {
    const card = document.createElement("div");
    card.className = "item";
    const h = document.createElement("h3");
    h.textContent = `${idx + 1}. ${item.exerciseName}`;

    const setsBox = document.createElement("div");
    setsBox.className = "stack";

    function renderSets() {
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
        del.className = "secondary";
        del.textContent = "Remove";
        del.onclick = () => {
          item.sets = item.sets.filter((_, j) => j !== si).map((x, j) => ({ ...x, set_index: j }));
          renderSets();
        };

        row.append(w, r, del);
        setsBox.appendChild(row);
      });
    }

    const addSet = document.createElement("button");
    addSet.className = "secondary";
    addSet.textContent = "Add set";
    addSet.onclick = () => {
      item.sets.push({ set_index: item.sets.length, weight: "", reps: "" });
      renderSets();
    };

    renderSets();
    card.append(h, setsBox, addSet);
    host.appendChild(card);
  });
}

// Start workout (autofill last sets if available)
$("startWorkoutBtn").addEventListener("click", async () => {
  setWorkoutMsg("");

  const templateId = $("startTplSelect").value;
  if (!templateId) return alert("Pick a template first.");

  const tpl = (cachedTemplates || []).find((t) => t.id === templateId);
  if (!tpl) return alert("Template not found. Go to Templates tab and refresh.");
  if (!tpl.items || tpl.items.length === 0) return alert("This template has no exercises yet.");

  try {
    const userId = getUserIdOrThrow();

    // AUTOFILL attempt (non-blocking)
    const exerciseIds = tpl.items.map((it) => it.exercise_id).filter(Boolean);
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
    const nameByExerciseId = new Map(tpl.items.map((it) => [it.exercise_id, it.exercise_name]));

    activeWorkout = {
      workoutId: workout.id,
      items: (weInserted || [])
        .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
        .map((we) => {
          const prevSets = lastSetsMap.get(we.exercise_id);
          return {
            workoutExerciseId: we.id,
            exerciseName: nameByExerciseId.get(we.exercise_id) || "Exercise",
            sets: (prevSets && prevSets.length)
              ? prevSets.map((s, i) => ({ set_index: i, weight: s.weight ?? "", reps: s.reps ?? "" }))
              : [{ set_index: 0, weight: "", reps: "" }],
          };
        }),
    };

    renderActiveWorkout();
    show($("saveWorkoutBtn"));
    setWorkoutMsg("Workout started. Autofilled last weights/reps (if available).");
  } catch (err) {
    console.error(err);
    alert(String(err.message || err));
  }
});

// Save workout sets
$("saveWorkoutBtn").addEventListener("click", async () => {
  if (!activeWorkout) return;
  try {
    const rows = [];
    for (const item of activeWorkout.items) {
      for (const s of item.sets) {
        const hasAny = String(s.weight).trim() !== "" || String(s.reps).trim() !== "";
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
    setWorkoutMsg("Saved ✅");
    activeWorkout = null;
    hide($("saveWorkoutBtn"));
    renderActiveWorkout();
    await refreshHistory();
  } catch (err) {
    console.error(err);
    alert(String(err.message || err));
  }
});

// --------------------
// History (last 20 workouts summary)
// --------------------
async function loadHistory(userId) {
  const params = new URLSearchParams();
  params.set("select", "id,performed_at,notes");
  params.set("user_id", `eq.${userId}`);
  params.set("order", "performed_at.desc");
  params.set("limit", "20");

  const workouts = await fetchJSON(`/rest/v1/workouts?${params.toString()}`) || [];
  if (!workouts.length) return [];
  const ids = workouts.map((w) => w.id).join(",");

  const weParams = new URLSearchParams();
  weParams.set("select", "workout_id");
  weParams.set("workout_id", `in.(${ids})`);
  const wes = await fetchJSON(`/rest/v1/workout_exercises?${weParams.toString()}`) || [];

  const counts = new Map();
  wes.forEach((r) => counts.set(r.workout_id, (counts.get(r.workout_id) || 0) + 1));

  return workouts.map((w) => ({ ...w, exercise_count: counts.get(w.id) || 0 }));
}

async function refreshHistory() {
  const host = $("historyList");
  const detail = $("historyDetail");

  // reset to list view
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
    const rows = await loadHistory(userId);
    host.innerHTML = "";

    if (!rows.length) {
      host.innerHTML = '<div class="muted">No workouts yet. Start one in the Workout tab.</div>';
      return;
    }

    rows.forEach((w) => {
      const card = document.createElement("div");
      card.className = "item";
      card.style.cursor = "pointer";

      const dt = new Date(w.performed_at).toLocaleString();
      const exCount = w.exercise_count ?? 0;

      card.innerHTML = `<h3>${dt}</h3><div class="small">${exCount} exercises</div>`;

      // ✅ CLICK HANDLER
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
  // Pull workout + exercises + sets (then we’ll sort/group in JS)
  const { data, error } = await sb
    .from("workouts")
    .select(`
      id,
      performed_at,
      notes,
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

  // Normalize ordering
  const wes = (data.workout_exercises || [])
    .slice()
    .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
    .map((we) => ({
      ...we,
      sets: (we.sets || []).slice().sort((a, b) => (a.set_index ?? 0) - (b.set_index ?? 0)),
    }));

  return { ...data, workout_exercises: wes };
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

  header.append(title, back);
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

// --------------------
// Bootstrap / refreshAll
// --------------------
async function refreshAll() {
  await refreshTemplates();
  await refreshHistory();

  try {
    const list = $("exerciseList");
    list.innerHTML = "Loading...";
    const ex = await loadExercises("");
    list.innerHTML = "";
    (ex || []).slice(0, 80).forEach((e) => {
      const card = document.createElement("div");
      card.className = "item";
      card.innerHTML = `<h3>${e.name}</h3><div class="small">${e.primary_muscle || ""} - ${e.equipment || ""}</div>`;
      list.appendChild(card);
    });
  } catch (err) {
    console.error(err);
    $("exerciseList").innerHTML = `<div class="muted">Error: ${String(err.message || err)}</div>`;
  }

  renderActiveWorkout();
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

    // ✅ IMPORTANT: set globals used by getUserIdOrThrow + fetchJSON
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
  } catch (e) {
    console.error("Initial session check failed:", e);
    show($("authSection"));
    hide($("appSection"));
  }
})();

