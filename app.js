import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// ✅ Your Supabase config
const SUPABASE_URL = "https://doxyazdbbqpjcbfwcvzr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRveHlhemRiYnFwamNiZndjdnpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3ODUwODYsImV4cCI6MjA4NjM2MTA4Nn0.efJGioFAoeOzu5RnFrkKFEMz8GZRttBvMaywYnxdhyc";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- UI helpers ---
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");

function setAuthMsg(msg) { $("authMsg").textContent = msg || ""; }
function setWorkoutMsg(msg) { $("workoutMsg").textContent = msg || ""; }

let activeWorkout = null; // { workoutId, items: [{ workoutExerciseId, exerciseName, sets: [...] }] }

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
  const email = $("email").value.trim();
  const password = $("password").value;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) setAuthMsg(error.message);
});

$("signUpBtn").addEventListener("click", async () => {
  setAuthMsg("");
  const email = $("email").value.trim();
  const password = $("password").value;
  const { error } = await sb.auth.signUp({ email, password });
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
  let q = sb.from("exercises")
    .select("id,name,primary_muscle,equipment,is_system,owner_user_id")
    .order("name", { ascending: true });

  if (search.trim()) q = q.ilike("name", `%${search.trim()}%`);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
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

  const { error } = await sb.from("workout_templates").insert({ user_id: userId, name, split_type });
  if (error) alert(error.message);

  $("tplName").value = "";
  await refreshTemplates();
});

async function refreshTemplates() {
  const list = $("templatesList");
  list.innerHTML = "Loading...";
  const templates = await loadTemplates();

  // for Start Workout dropdown
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

    const search = document.createElement("input");
    search.placeholder = "Search exercises to add…";

    const results = document.createElement("div");
    results.className = "stack";

    search.addEventListener("input", async () => {
      const term = search.value.trim();
      results.innerHTML = "";
      if (term.length < 2) return;

      const ex = await loadExercises(term);
      ex.slice(0, 10).forEach((e) => {
        const b = document.createElement("button");
        b.className = "secondary";
        b.textContent = `Add: ${e.name}`;
        b.onclick = async () => {
          const existingCount = current.length;
          if (existingCount >= 5) {
            alert("This template already has 5 exercises.");
            return;
          }
          const { error } = await sb.from("workout_template_exercises").insert({
            template_id: t.id,
            exercise_id: e.id,
            order_index: existingCount
          });
          if (error) alert(error.message);
          await refreshTemplates();
        };
        results.appendChild(b);
      });
    });

    const delBtn = document.createElement("button");
    delBtn.className = "secondary";
    delBtn.textContent = "Delete template";
    delBtn.onclick = async () => {
      if (!confirm("Delete this template?")) return;
      const { error } = await sb.from("workout_templates").delete().eq("id", t.id);
      if (error) alert(error.message);
      await refreshTemplates();
    };

    card.append(h, p, ul, search, results, delBtn);
    list.appendChild(card);
  }
}

// --- Workout: start from template ---
$("startWorkoutBtn").addEventListener("click", async () => {
  setWorkoutMsg("");
  const templateId = $("startTplSelect").value;
  if (!templateId) return;

  const { data: tex, error: texErr } = await sb
    .from("workout_template_exercises")
    .select("exercise_id, order_index, exercises(id,name)")
    .eq("template_id", templateId)
    .order("order_index", { ascending: true });

  if (texErr) return alert(texErr.message);
  if (!tex || tex.length !== 5) return alert("Template must have exactly 5 exercises.");

  const { data: userRes } = await sb.auth.getUser();
  const userId = userRes.user?.id;
  if (!userId) return;

  const { data: workout, error: wErr } = await sb
    .from("workouts")
    .insert({ user_id: userId, performed_at: new Date().toISOString() })
    .select("id")
    .single();

  if (wErr) return alert(wErr.message);

  const weRows = tex.map((row) => ({
    workout_id: workout.id,
    exercise_id: row.exercise_id,
    order_index: row.order_index
  }));

  const { data: weInserted, error: weErr } = await sb
    .from("workout_exercises")
    .insert(weRows)
    .select("id, order_index, exercises(name)")
    .order("order_index", { ascending: true });

  if (weErr) return alert(weErr.message);

  activeWorkout = {
    workoutId: workout.id,
    items: (weInserted || []).map((we) => ({
      workoutExerciseId: we.id,
      exerciseName: we.exercises?.name || "Exercise",
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

    function renderSets() {
      setsBox.innerHTML = "";
      item.sets.forEach((s, si) => {
        const row = document.createElement("div");
        row.className = "row";

        const w = document.createElement("input");
        w.placeholder = "weight";
        w.inputMode = "decimal";
        w.value = s.weight;
        w.oninput = () => (s.weight = w.value);

        const r = document.createElement("input");
        r.placeholder = "reps";
        r.inputMode = "numeric";
        r.value = s.reps;
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

$("saveWorkoutBtn").addEventListener("click", async () => {
  if (!activeWorkout) return;

  for (const item of activeWorkout.items) {
    const rows = item.sets
      .filter((s) => String(s.weight).trim() !== "" || String(s.reps).trim() !== "")
      .map((s) => ({
        workout_exercise_id: item.workoutExerciseId,
        set_index: s.set_index,
        weight: String(s.weight).trim() === "" ? null : Number(s.weight),
        reps: String(s.reps).trim() === "" ? null : Number(s.reps),
        is_warmup: false
      }));

    if (rows.length) {
      const { error } = await sb.from("sets").insert(rows);
      if (error) return alert(error.message);
    }
  }

  setWorkoutMsg("Saved ✅");
  activeWorkout = null;
  $("activeWorkout").innerHTML = "";
  hide($("saveWorkoutBtn"));
  await refreshHistory();
});

// --- Library UI ---
$("exerciseSearch").addEventListener("input", async () => {
  const term = $("exerciseSearch").value.trim();
  const list = $("exerciseList");
  list.innerHTML = "Loading...";
  const ex = await loadExercises(term);
  list.innerHTML = "";
  ex.slice(0, 80).forEach((e) => {
    const card = document.createElement("div");
    card.className = "item";
    card.innerHTML = `<h3>${e.name}</h3><div class="small">${e.primary_muscle || ""} • ${e.equipment || ""}</div>`;
    list.appendChild(card);
  });
});

// --- History UI ---
async function refreshHistory() {
  const host = $("historyList");
  host.innerHTML = "Loading...";
  const rows = await loadHistory();
  host.innerHTML = "";
  rows.forEach((w) => {
    const card = document.createElement("div");
    card.className = "item";
    const dt = new Date(w.performe
