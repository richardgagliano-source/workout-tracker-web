import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// ✅ Your Supabase config
const SUPABASE_URL = "https://doxyazdbbqpjcbfwcvzr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRveHlhemRiYnFwamNiZndjdnpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3ODUwODYsImV4cCI6MjA4NjM2MTA4Nn0.efJGioFAoeOzu5RnFrkKFEMz8GZRttBvMaywYnxdhyc";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.sb = sb;

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
  let q = sb.from("exercises")
    .select("id,name,primary_muscle,equipment,is_system,owner_user_id")
    .order("name", { ascending: true });

  if (search.trim()) q = q.ilike("name", `%${search.trim()}%`);
  const { data, error } = await q;

  if (error) {
    console.error("Supabase exercises error:", error);
    throw error;
  }

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

// --- Library UI (UPDATED WITH ERROR HANDLING) ---
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

// --- History UI ---
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
  await refreshHistory();
  $("exerciseSearch").dispatchEvent(new Event("input"));
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
