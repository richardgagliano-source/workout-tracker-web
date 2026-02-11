import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// ✅ Your Supabase config
const SUPABASE_URL = "https://doxyazdbbqpjcbfwcvzr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRveHlhemRiYnFwamNiZndjdnpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3ODUwODYsImV4cCI6MjA4NjM2MTA4Nn0.efJGioFAoeOzu5RnFrkKFEMz8GZRttBvMaywYnxdhyc";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Expose for debugging
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
    ["templates","workout","library","history"].forEach((t) => hide($(`tab-${t}`)));
    show($(`tab-${tab}`));
  });
});

// --- Auth ---
$("signInBtn").addEventListener("click", async () => {
  setAuthMsg("");
  const { error } = await sb.auth.signInWithPassword({
    email: $("email").value.trim(),
    password: $("password").value
  });
  if (error) setAuthMsg(error.message);
});

$("signUpBtn").addEventListener("click", async () => {
  setAuthMsg("");
  const { error } = await sb.auth.signUp({
    email: $("email").value.trim(),
    password: $("password").value
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

// --- Data fetchers ---
async function loadExercises(search = "") {
  const term = search.trim();

  // Build a PostgREST URL (this is what supabase-js calls under the hood)
  const params = new URLSearchParams();
  params.set("select", "id,name,primary_muscle,equipment,is_system,owner_user_id");
  params.set("order", "name.asc");
  params.set("limit", "80");

  // PostgREST filter: name=ilike.*bench*
  if (term) params.set("name", `ilike.*${term.replaceAll("*", "")}*`);

  const url = `${SUPABASE_URL}/rest/v1/exercises?${params.toString()}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Exercises fetch failed (${res.status}): ${text}`);
  }

  return await res.json();
}

async function loadTemplates() {
  const { data, error } = await sb
    .from("workout_templates")
    .select("id,name,split_type,workout_template_exercises(order_index,exercises(id,name))")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

async function loadHistory() {
  const { data, error } = await sb
    .from("workouts")
    .select("id,performed_at,notes,workout_exercises(order_index,exercises(name),sets(weight,reps,set_index))")
    .order("performed_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  return data || [];
}

// --- Templates UI ---
$("createTplBtn").addEventListener("click", async () => {
  const name = $("tplName").value.trim();
  const split_type = $("tplSplit").value;
  if (!name) return;

  const { data: userRes } = await sb.auth.getUser();
  const userId = userRes.user?.id;
  if (!userId) return;

  const { error } = await sb.from("workout_templates")
    .insert({ user_id: userId, name, split_type });

  if (error) alert(error.message);

  $("tplName").value = "";
  await refreshTemplates();
});

async function refreshTemplates() {
  const list = $("templatesList");
  list.innerHTML = "Loading...";
  const templates = await loadTemplates();

  const sel = $("startTplSelect");
  sel.innerHTML = "";

  templates.forEach((t) => {
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

    const current = (t.workout_template_exercises || [])
      .sort((a,b) => a.order_index - b.order_index)
      .map((x) => x.exercises?.name)
      .filter(Boolean);

    const p = document.createElement("div");
    p.className = "small";
    p.textContent = `${current.length}/5 exercises`;

    const ul = document.createElement("div");
    ul.className = "stack";
    current.forEach((name, idx) => {
      const row = document.createElement("div");
      row.className = "item";
      row.innerHTML = `<div><b>${idx + 1}.</b> ${name}</div>`;
      ul.appendChild(row);
    });

    card.append(h, p, ul);
    list.appendChild(card);
  }
}

// --- Workout ---
$("startWorkoutBtn").addEventListener("click", async () => {
  setWorkoutMsg("");
  const templateId = $("startTplSelect").value;
  if (!templateId) return;

  const { data: tex } = await sb
    .from("workout_template_exercises")
    .select("exercise_id, order_index, exercises(name)")
    .eq("template_id", templateId)
    .order("order_index");

  if (!tex || tex.length !== 5) {
    alert("Template must have exactly 5 exercises.");
    return;
  }

  const { data: userRes } = await sb.auth.getUser();
  const userId = userRes.user?.id;
  if (!userId) return;

  const { data: workout } = await sb
    .from("workouts")
    .insert({ user_id: userId, performed_at: new Date().toISOString() })
    .select("id")
    .single();

  activeWorkout = {
    workoutId: workout.id,
    items: tex.map((row) => ({
      workoutExerciseId: null,
      exerciseName: row.exercises?.name || "Exercise",
      sets: [{ set_index: 0, weight: "", reps: "" }]
    }))
  };

  renderActiveWorkout();
  show($("saveWorkoutBtn"));
  setWorkoutMsg("Workout started. Enter sets, then Save.");
});

function renderActiveWorkout() {
  const host = $("activeWorkout");
  host.innerHTML = "";
  if (!activeWorkout) return;

  activeWorkout.items.forEach((item, idx) => {
    const card = document.createElement("div");
    card.className = "item";

    const h = document.createElement("h3");
    h.textContent = `${idx + 1}. ${item.exerciseName}`;

    const setsBox = document.createElement("div");
    setsBox.className = "stack";

    item.sets.forEach((s, si) => {
      const row = document.createElement("div");
      row.className = "row";

      const w = document.createElement("input");
      w.placeholder = "weight";
      w.value = s.weight;
      w.oninput = () => s.weight = w.value;

      const r = document.createElement("input");
      r.placeholder = "reps";
      r.value = s.reps;
      r.oninput = () => s.reps = r.value;

      row.append(w, r);
      setsBox.appendChild(row);
    });

    card.append(h, setsBox);
    host.appendChild(card);
  });
}

// --- Library ---
$("exerciseSearch").addEventListener("input", async () => {
  try {
    const term = $("exerciseSearch").value.trim();
    const list = $("exerciseList");
    list.innerHTML = "Loading...";

    const ex = await loadExercises(term);

    list.innerHTML = "";
    ex.slice(0, 80).forEach((e) => {
      const card = document.createElement("div");
      card.className = "item";
      card.innerHTML = `<h3>${e.name}</h3><div class="small">${e.primary_muscle || ""} - ${e.equipment || ""}</div>`;
      list.appendChild(card);
    });

    if (ex.length === 0) {
      list.innerHTML = `<div class="muted">No exercises found.</div>`;
    }

  } catch (err) {
    console.error("Library failed:", err);
    $("exerciseList").innerHTML =
      `<div class="muted">Error loading exercises. Check console.</div>`;
  }
});

// --- History ---
async function refreshHistory() {
  const host = $("historyList");
  host.innerHTML = "Loading...";
  const rows = await loadHistory();
  host.innerHTML = "";
  rows.forEach((w) => {
    const card = document.createElement("div");
    card.className = "item";
    const dt = new Date(w.performed_at).toLocaleString();
    const exCount = (w.workout_exercises || []).length;
    card.innerHTML = `<h3>${dt}</h3><div class="small">${exCount} exercises</div>`;
    host.appendChild(card);
  });
}

// --- App bootstrap ---
async function refreshAll() {
  await refreshTemplates();
  await refreshHistory();

  // Directly load exercise library (no synthetic input event)
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
