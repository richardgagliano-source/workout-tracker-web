import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// ✅ Supabase config
const SUPABASE_URL = "https://doxyazdbbqpjcbfwcvzr.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRveHlhemRiYnFwamNiZndjdnpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3ODUwODYsImV4cCI6MjA4NjM2MTA4Nn0.efJGioFAoeOzu5RnFrkKFEMz8GZRttBvMaywYnxdhyc";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.sb = sb;
console.log("sb ready", !!window.sb);

// --- UI helpers ---
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
function setAuthMsg(msg) { $("authMsg").textContent = msg || ""; }
function setWorkoutMsg(msg) { $("workoutMsg").textContent = msg || ""; }

let activeWorkout = null;

// --- Tabs ---
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    ["templates", "workout", "library", "history"].forEach((t) => hide($(`tab-${t}`)));
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

async function signOut() {
  await sb.auth.signOut();
}

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
// ✅ Exercises fetch (stable)
// ----------------------------
async function loadExercises(search = "") {
  const term = search.trim();

  const params = new URLSearchParams();
  params.set("select", "id,name,primary_muscle,equipment");
  params.set("order", "name.asc");
  params.set("limit", "80");
  if (term) params.set("name", `ilike.*${term.replaceAll("*", "")}*`);

  const url = `${SUPABASE_URL}/rest/v1/exercises?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Exercises fetch failed (${res.status}): ${text}`);
    }

    return await res.json();
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("Exercises request timed out.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------
// ✅ Templates data
// ----------------------------
async function getUserIdOrThrow() {
  const { data, error } = await sb.auth.getUser();
  if (error) throw error;
  const userId = data.user?.id;
  if (!userId) throw new Error("Not signed in.");
  return userId;
}

async function loadTemplatesFull() {
  // Expecting: workout_templates, workout_template_exercises with order_index, and exercises
  const { data, error } = await sb
    .from("workout_templates")
    .select("id,name,split_type,created_at,workout_template_exercises(id,order_index,exercise_id,exercises(id,name))")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

async function refreshTemplates() {
  const list = $("templatesList");
  list.innerHTML = "Loading...";

  let templates = [];
  try {
    templates = await loadTemplatesFull();
  } catch (err) {
    console.error("Templates load failed:", err);
    list.innerHTML = `<div class="muted">Error loading templates: ${String(err.message || err)}</div>`;
    return;
  }

  // Start workout dropdown (only templates with exactly 5 exercises)
  const sel = $("startTplSelect");
  sel.innerHTML = "";
  templates
    .filter((t) => ((t.workout_template_exercises || []).length === 5))
    .forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `${t.name} (${t.split_type})`;
      sel.appendChild(opt);
    });

  list.innerHTML = "";

  for (const t of templates) {
    const card = document.createElement("div");
    card.className = "item";

    // Header row
    const h = document.createElement("h3");
    h.textContent = t.name;

    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = t.split_type;
    h.appendChild(pill);

    const items = (t.workout_template_exercises || [])
      .slice()
      .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
      .map((x) => ({
        wteId: x.id,
        exerciseId: x.exercise_id,
        name: x.exercises?.name || "Exercise",
        order: x.order_index ?? 0,
      }));

    const meta = document.createElement("div");
    meta.className = "small";
    meta.textContent = `${items.length}/5 exercises`;

    const ul = document.createElement("div");
    ul.className = "stack";

    items.forEach((it, idx) => {
      const row = document.createElement("div");
      row.className = "item";
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.gap = "8px";

      const left = document.createElement("div");
      left.innerHTML = `<b>${idx + 1}.</b> ${it.name}`;

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.gap = "6px";

      const up = document.createElement("button");
      up.className = "secondary";
      up.textContent = "↑";
      up.disabled = idx === 0;
      up.onclick = async () => {
        await swapTemplateOrder(items[idx], items[idx - 1]);
        await refreshTemplates();
      };

      const down = document.createElement("button");
      down.className = "secondary";
      down.textContent = "↓";
      down.disabled = idx === items.length - 1;
      down.onclick = async () => {
        await swapTemplateOrder(items[idx], items[idx + 1]);
        await refreshTemplates();
      };

      const remove = document.createElement("button");
      remove.className = "secondary";
      remove.textContent = "Remove";
      remove.onclick = async () => {
        await removeTemplateExercise(t.id, it.wteId);
        await refreshTemplates();
      };

      right.append(up, down, remove);
      row.append(left, right);
      ul.appendChild(row);
    });

    // Add exercises search
    const search = document.createElement("input");
    search.placeholder = items.length >= 5 ? "Template is full (5/5)" : "Search exercises to add…";
    search.disabled = items.length >= 5;

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
        if (reqId !== lastReq) return; // ignore stale result

        ex.slice(0, 10).forEach((e) => {
          const b = document.createElement("button");
          b.className = "secondary";
          b.textContent = `Add: ${e.name}`;
          b.onclick = async () => {
            if (items.length >= 5) {
              alert("This template already has 5 exercises.");
              return;
            }
            const already = items.some((x) => x.exerciseId === e.id);
            if (already) {
              alert("That exercise is already in this template.");
              return;
            }
            await addTemplateExercise(t.id, e.id, items.length);
            search.value = "";
            results.innerHTML = "";
            await refreshTemplates();
          };
          results.appendChild(b);
        });
      } catch (err) {
        console.error("Template search failed:", err);
        results.innerHTML = `<div class="muted">Search error: ${String(err.message || err)}</div>`;
      }
    });

    // Delete template
    const delBtn = document.createElement("button");
    delBtn.className = "secondary";
    delBtn.textContent = "Delete template";
    delBtn.onclick = async () => {
      if (!confirm("Delete this template?")) return;
      const { error } = await sb.from("workout_templates").delete().eq("id", t.id);
      if (error) alert(error.message);
      await refreshTemplates();
    };

    card.append(h, meta, ul, search, results, delBtn);
    list.appendChild(card);
  }
}

async function addTemplateExercise(templateId, exerciseId, orderIndex) {
  // workout_template_exercises: template_id, exercise_id, order_index
  const { error } = await sb.from("workout_template_exercises").insert({
    template_id: templateId,
    exercise_id: exerciseId,
    order_index: orderIndex,
  });
  if (error) throw error;
}

async function removeTemplateExercise(templateId, wteId) {
  // delete row
  const { error } = await sb.from("workout_template_exercises").delete().eq("id", wteId);
  if (error) throw error;

  // re-index remaining items to 0..n-1
  const { data, error: loadErr } = await sb
    .from("workout_template_exercises")
    .select("id,order_index")
    .eq("template_id", templateId)
    .order("order_index", { ascending: true });

  if (loadErr) throw loadErr;

  const rows = (data || []).map((r, i) => ({ id: r.id, order_index: i }));
  for (const r of rows) {
    const { error: upErr } = await sb.from("workout_template_exercises").update({ order_index: r.order_index }).eq("id", r.id);
    if (upErr) throw upErr;
  }
}

async function swapTemplateOrder(a, b) {
  // swap order_index
  const aOrder = a.order;
  const bOrder = b.order;

  const { error: e1 } = await sb.from("workout_template_exercises").update({ order_index: bOrder }).eq("id", a.wteId);
  if (e1) throw e1;
  const { error: e2 } = await sb.from("workout_template_exercises").update({ order_index: aOrder }).eq("id", b.wteId);
  if (e2) throw e2;
}

// Create template
$("createTplBtn").addEventListener("click", async () => {
  const name = $("tplName").value.trim();
  const split_type = $("tplSplit").value;
  if (!name) return;

  try {
    const userId = await getUserIdOrThrow();
    const { error } = await sb.from("workout_templates").insert({ user_id: userId, name, split_type });
    if (error) throw error;
    $("tplName").value = "";
    await refreshTemplates();
  } catch (err) {
    alert(String(err.message || err));
  }
});

// ----------------------------
// ✅ Library UI (searches work)
// ----------------------------
$("exerciseSearch").addEventListener("input", async () => {
  const term = $("exerciseSearch").value.trim();
  const list = $("exerciseList");
  list.innerHTML = "Loading...";

  try {
    const ex = await loadExercises(term);

    list.innerHTML = "";
    ex.slice(0, 80).forEach((e) => {
      const card = document.createElement("div");
      card.className = "item";
      card.innerHTML = `<h3>${e.name}</h3><div class="small">${e.primary_muscle || ""} - ${e.equipment || ""}</div>`;
      list.appendChild(card);
    });

    if (ex.length === 0) list.innerHTML = `<div class="muted">No exercises found.</div>`;
  } catch (err) {
    console.error("Library failed:", err);
    list.innerHTML = `<div class="muted">Error: ${String(err.message || err)}</div>`;
  }
});

// ----------------------------
// ✅ Workout + History placeholders (next step after templates)
// ----------------------------
$("startWorkoutBtn").addEventListener("click", async () => {
  setWorkoutMsg("Next step: we’ll wire workout logging after templates ✅");
});

async function refreshHistory() {
  $("historyList").innerHTML = `<div class="muted">History will be enabled after workout logging ✅</div>`;
}

// ----------------------------
// ✅ App bootstrap
// ----------------------------
async function refreshAll() {
  await refreshTemplates();
  await refreshHistory();

  // initial library load
  try {
    const list = $("exerciseList");
    list.innerHTML = "Loading...";
    const ex = await loadExercises("");
    list.innerHTML = "";
    ex.slice(0, 80).forEach((e) => {
      const card = document.createElement("div");
      card.className = "item";
      card.innerHTML = `<h3>${e.name}</h3><div class="small">${e.primary_muscle || ""} - ${e.equipment || ""}</div>`;
      list.appendChild(card);
    });
  } catch (err) {
    console.error("Initial library load failed:", err);
    $("exerciseList").innerHTML = `<div class="muted">Error: ${String(err.message || err)}</div>`;
  }
}

sb.auth.onAuthStateChange(async (_event, session) => {
  const user = session?.user || null;
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
  const { data } = await sb.auth.getSession();
  const user = data.session?.user || null;
  renderUserBar(user);
  if (user) {
    hide($("authSection"));
    show($("appSection"));
    await refreshAll();
  }
})();
