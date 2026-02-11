import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// ✅ Supabase config
const SUPABASE_URL = "https://doxyazdbbqpjcbfwcvzr.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRveHlhemRiYnFwamNiZndjdnpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3ODUwODYsImV4cCI6MjA4NjM2MTA4Nn0.efJGioFAoeOzu5RnFrkKFEMz8GZRttBvMaywYnxdhyc";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.sb = sb;
console.log("sb ready", !!window.sb);

// ✅ store user/session (avoid sb.auth.getUser() + use JWT for RLS tables)
let currentUserId = null;
let currentAccessToken = null;

function getUserIdOrThrow() {
  if (!currentUserId) throw new Error("Not signed in.");
  return currentUserId;
}

// --- helpers ---
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
function setAuthMsg(msg) { $("authMsg").textContent = msg || ""; }
function setWorkoutMsg(msg) { $("workoutMsg").textContent = msg || ""; }

/**
 * ✅ fetch helper
 * - always includes apikey
 * - uses *user JWT* if available (critical for RLS tables like workout_templates)
 */
async function fetchJSON(path, { method = "GET", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

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

// --- Tabs ---
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    ["templates","workout","library","history"].forEach((t) => hide($(`tab-${t}`)));
    show($(`tab-${tab}`));
  });
});

// --- Auth ---
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

// ----------------------------
// ✅ Library (fetch) — works
// ----------------------------
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

// ----------------------------
// ✅ Templates (fetch + USER JWT)
// ----------------------------
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

  let templates = [];
  try {
    templates = await loadTemplatesFull(userId);
  } catch (err) {
    console.error(err);
    list.innerHTML = `<div class="muted">Error loading templates: ${String(err.message || err)}</div>`;
    return;
  }

  // Start dropdown: only templates with 5 items
  const sel = $("startTplSelect");
  sel.innerHTML = "";
  templates.filter((t) => (t.items?.length === 5)).forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = `${t.name} (${t.split_type})`;
    sel.appendChild(opt);
  });

  list.innerHTML = "";
  for (const t of templates) {
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
    meta.textContent = `${t.items.length}/5 exercises`;

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
    search.placeholder = t.items.length >= 5 ? "Template is full (5/5)" : "Search exercises to add…";
    search.disabled = t.items.length >= 5;

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
            if (t.items.length >= 5) return alert("Template already has 5 exercises.");
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

// --- Workout + History placeholders (next) ---
$("startWorkoutBtn").addEventListener("click", async () => {
  setWorkoutMsg("Next step: wire workout logging after templates ✅");
});
async function refreshHistory() {
  $("historyList").innerHTML = `<div class="muted">History enabled after workout logging ✅</div>`;
}

// --- Bootstrap ---
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
}

sb.auth.onAuthStateChange(async (_event, session) => {
  const user = session?.user || null;
  currentUserId = user?.id || null;
  currentAccessToken = session?.access_token || null; // ✅ critical for RLS fetches
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

(async () => {
  const { data } = await sb.auth.getSession();
  const session = data.session || null;
  const user = session?.user || null;
  currentUserId = user?.id || null;
  currentAccessToken = session?.access_token || null; // ✅ critical for RLS fetches
  renderUserBar(user);

  if (user) {
    hide($("authSection"));
    show($("appSection"));
    await refreshAll();
  }
})();
