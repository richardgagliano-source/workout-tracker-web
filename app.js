import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// ✅ Your Supabase config
const SUPABASE_URL = "https://doxyazdbbqpjcbfwcvzr.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRveHlhemRiYnFwamNiZndjdnpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3ODUwODYsImV4cCI6MjA4NjM2MTA4Nn0.efJGioFAoeOzu5RnFrkKFEMz8GZRttBvMaywYnxdhyc";

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
// ✅ EXERCISE LOADER (FETCH + TIMEOUT + LOGS)
// ----------------------------
async function loadExercises(search = "") {
  const term = search.trim();

  const params = new URLSearchParams();
  params.set("select", "id,name,primary_muscle,equipment,is_system,owner_user_id");
  params.set("order", "name.asc");
  params.set("limit", "80");

  // PostgREST filter: name=ilike.*bench*
  if (term) params.set("name", `ilike.*${term.replaceAll("*", "")}*`);

  const url = `${SUPABASE_URL}/rest/v1/exercises?${params.toString()}`;
  console.log("loadExercises →", url);

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

    console.log("loadExercises status →", res.status);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Exercises fetch failed (${res.status}): ${text}`);
    }

    return await res.json();
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("Exercises request timed out (possible network/extension block).");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// --- Templates (basic list only; your DB is still used) ---
async function loadTemplates() {
  const { data, error } = await sb
    .from("workout_templates")
    .select("id,name,split_type")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

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

  // dropdown
  const sel = $("startTplSelect");
  sel.innerHTML = "";
  templates.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = `${t.name} (${t.split_type})`;
    sel.appendChild(opt);
  });

  list.innerHTML = "";
  templates.forEach((t) => {
    const card = document.createElement("div");
    card.className = "item";
    card.innerHTML = `<h3>${t.name}</h3><div class="small">${t.split_type}</div>`;
    list.appendChild(card);
  });
}

// --- Workout (kept minimal; your prior version handled inserts) ---
$("startWorkoutBtn").addEventListener("click", async () => {
  setWorkoutMsg("Workout screen in progress ✅ (templates + history + library are the focus right now)");
});

// --- History (basic stub, so app doesn’t crash if schema differs) ---
async function refreshHistory() {
  const host = $("historyList");
  host.innerHTML = `<div class="muted">History loading is enabled in your earlier version. We can re-add after Library works.</div>`;
}

// ----------------------------
// ✅ LIBRARY UI (shows errors on page)
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

    if (ex.length === 0) {
      list.innerHTML = `<div class="muted">No exercises found.</div>`;
    }
  } catch (err) {
    console.error("Library failed:", err);
    list.innerHTML = `<div class="muted">Error: ${String(err.message || err)}</div>`;
  }
});

// --- App bootstrap ---
async function refreshAll() {
  await refreshTemplates();
  await refreshHistory();

  // Load exercise library immediately (no synthetic events)
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
