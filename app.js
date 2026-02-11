import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// 🔑 YOUR SUPABASE CONFIG
const SUPABASE_URL = "https://doxyazdbbqpjcbfwcvzr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRveHlhemRiYnFwamNiZndjdnpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3ODUwODYsImV4cCI6MjA4NjM2MTA4Nn0.efJGioFAoeOzu5RnFrkKFEMz8GZRttBvMaywYnxdhyc";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// UI Elements
const authCard = document.getElementById("authCard");
const appCard = document.getElementById("appCard");
const message = document.getElementById("message");

const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");

const signUpBtn = document.getElementById("signUpBtn");
const signInBtn = document.getElementById("signInBtn");
const logoutBtn = document.getElementById("logoutBtn");

// SIGN UP
signUpBtn.onclick = async () => {
  message.textContent = "";
  const { error } = await supabase.auth.signUp({
    email: emailInput.value,
    password: passwordInput.value,
  });

  if (error) message.textContent = error.message;
  else message.textContent = "Signed up! Now sign in.";
};

// SIGN IN
signInBtn.onclick = async () => {
  message.textContent = "";
  const { error } = await supabase.auth.signInWithPassword({
    email: emailInput.value,
    password: passwordInput.value,
  });

  if (error) message.textContent = error.message;
};

// LOGOUT
logoutBtn.onclick = async () => {
  await supabase.auth.signOut();
};

// SESSION LISTENER
supabase.auth.onAuthStateChange((_event, session) => {
  if (session) {
    authCard.classList.add("hidden");
    appCard.classList.remove("hidden");
  } else {
    authCard.classList.remove("hidden");
    appCard.classList.add("hidden");
  }
});
