// ============================================================
// Discover Group Sales Portal — mockup logic (client-side only)
// ============================================================

const FUNNEL_STAGES = [
  { no: "01", label: "New Inquiry" },
  { no: "02", label: "Discovery & Qualification" },
  { no: "03", label: "Solution Presented" },
  { no: "04", label: "Decision in Progress" },
  { no: "05", label: "Strategic Nurturing" },
  { no: "06", label: "Reservation / Payment Processing" },
  { no: "07", label: "Successfully Booked" },
];

const CRITERIA = [
  { title: "Lead Response Time", desc: "All new inquiries are answered within 30 minutes during 10:00 AM–7:00 PM.", max: 10 },
  { title: "Personalized Client Engagement", desc: "Responses are natural, tailored, conversational, and never robotic or AI-like.", max: 20 },
  { title: "Warm & Professional Client Experience", desc: "Communication builds trust through warmth, empathy, professionalism, and confidence.", max: 10 },
  { title: "Strategic Follow-through & Follow-up Compliance", desc: "Every active lead is followed up within 24 hours using value-driven closing strategies.", max: 25 },
  { title: "Accurate Tracker & Record Keeping", desc: "Client Profile, Leads Tracker, and Digital Travel Folders are complete and current.", max: 20 },
  { title: "Closing Effectiveness", desc: "Objections are handled with a clear, confident path to reservation.", max: 15 },
];

const currency = n => "₱" + Number(n).toLocaleString();

// ---------- Real login (Supabase Auth) ----------
let currentProfile = null; // { id, full_name, role }

const pwToggle = document.getElementById("pwToggle");
const pwInput = document.getElementById("pwInput");
pwToggle.addEventListener("click", () => {
  const show = pwInput.type === "password";
  pwInput.type = show ? "text" : "password";
  pwToggle.textContent = show ? "Hide" : "Show";
});

document.getElementById("loginBtn").addEventListener("click", async () => {
  const email = document.getElementById("emailInput").value.trim();
  const password = pwInput.value;
  const err = document.getElementById("loginError");
  const btn = document.getElementById("loginBtn");
  err.style.display = "none";

  if (!email || !password) {
    err.textContent = "Enter your email and password.";
    err.style.display = "block";
    return;
  }

  btn.textContent = "Signing in…";
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  btn.textContent = "Access Workspace";

  if (error) {
    err.textContent = "Couldn't log you in — " + error.message;
    err.style.display = "block";
    return;
  }
  await loadProfileAndEnter(data.user.id);
});

async function loadProfileAndEnter(userId) {
  const { data: profile, error } = await supabaseClient
    .from("profiles")
    .select("id, full_name, role")
    .eq("id", userId)
    .single();

  if (error || !profile) {
    document.getElementById("loginError").textContent = "Logged in, but no profile found. Contact your admin.";
    document.getElementById("loginError").style.display = "block";
    return;
  }
  currentProfile = profile;
  enterWorkspace(profile.full_name, profile.role);
  await Promise.all([loadLeads(), loadRanking()]);
}

function enterWorkspace(name, role) {
  document.getElementById("sidebarName").textContent = name;
  document.querySelector(".role-pill").textContent = role === "admin" ? "Team Lead" : "Sales Agent";
  document.getElementById("agentSub").textContent = "Individual performance for " + name;
  document.getElementById("scorecardSub").textContent = "Daily scorecard for " + name;
  document.getElementById("leadsOwner").textContent = name + "'s Leads Tracker";

  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("app").classList.add("active");
}

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  currentProfile = null;
  document.getElementById("app").classList.remove("active");
  document.getElementById("loginScreen").style.display = "flex";
  pwInput.value = "";
});

// Resume session on page reload instead of logging everyone out
(async function checkExistingSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) await loadProfileAndEnter(session.user.id);
})();

// ---------- Nav switching ----------
const navButtons = document.querySelectorAll("#nav button[data-view]");
navButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    navButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    document.getElementById("view-" + btn.dataset.view).classList.add("active");
  });
});

// ---------- Ranking (real employees from the profiles table) ----------
async function loadRanking() {
  const { data: profiles, error } = await supabaseClient
    .from("profiles")
    .select("id, full_name")
    .order("full_name");

  const list = document.getElementById("rankingList");
  list.innerHTML = "";
  if (error || !profiles) return;

  profiles.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "rank-row";
    row.innerHTML = `
      <div class="rank-badge">${i + 1}</div>
      <div>
        <div class="rank-name">${p.full_name}</div>
        <div class="rank-sub">Daily performance</div>
      </div>
      <div class="rank-metrics">
        <div><div class="m-label">Net sales</div><div class="m-value">₱0</div></div>
        <div><div class="m-label">Pax closed</div><div class="m-value">0</div></div>
        <div><div class="m-label">Daily bonus</div><div class="m-value">₱0</div></div>
        <div><div class="m-label">Commission</div><div class="m-value">₱0</div></div>
      </div>`;
    list.appendChild(row);
  });

  // Consultant dropdown on the scorecard view — populate from real employees
  const sel = document.getElementById("consultantSelect");
  sel.innerHTML = profiles.map(p => `<option value="${p.id}">${p.full_name}</option>`).join("");
  if (currentProfile) sel.value = currentProfile.id;
}

// ---------- Leads Tracker (real data) ----------
async function loadLeads() {
  if (!currentProfile) return;
  const { data: leads, error } = await supabaseClient
    .from("leads")
    .select("*")
    .order("created_at", { ascending: false });

  const box = document.querySelector("#view-leads .card:last-child");
  const countLabel = box.querySelector("span");
  const empty = box.querySelector(".registry-empty");

  if (error || !leads || leads.length === 0) {
    countLabel.textContent = "0 records";
    empty.textContent = "No leads found for this date range.";
    return;
  }
  countLabel.textContent = leads.length + " record" + (leads.length === 1 ? "" : "s");
  empty.textContent = leads.map(l => `${l.package_destination || "Untitled lead"} — ${l.journey_stage}`).join(" · ");
}

// Save the Client Profile form as a new lead
const clientCard = document.querySelector("#view-client .card");
if (clientCard) {
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save client profile";
  saveBtn.className = "btn-primary";
  saveBtn.style.marginTop = "22px";
  saveBtn.style.width = "auto";
  saveBtn.style.padding = "11px 22px";
  saveBtn.addEventListener("click", async () => {
    if (!currentProfile) return;
    const fields = clientCard.querySelectorAll("input, select, textarea");
    const [dest, travelDate, travelers, visa, source, deal, stage, temp, decision, followup, concern, strategy, remarks] = fields;
    saveBtn.textContent = "Saving…";
    const { error } = await supabaseClient.from("leads").insert({
      agent_id: currentProfile.id,
      package_destination: dest.value,
      travel_date: travelDate.value || null,
      travelers: Number(travelers.value) || 1,
      visa_status: visa.value,
      lead_source: source.value,
      deal_value: Number(deal.value) || 0,
      journey_stage: stage.value,
      lead_temperature: temp.value,
      decision_status: decision.value,
      next_followup: followup.value || null,
      concern: concern.value,
      closing_strategy: strategy.value,
      remarks: remarks.value,
    });
    saveBtn.textContent = error ? "Error — try again" : "Saved ✓";
    if (!error) { await loadLeads(); setTimeout(() => (saveBtn.textContent = "Save client profile"), 1500); }
  });
  clientCard.appendChild(saveBtn);
}

// ---------- Funnel ----------
function renderFunnel(targetId) {
  const grid = document.getElementById(targetId);
  grid.innerHTML = "";
  FUNNEL_STAGES.forEach(s => {
    const step = document.createElement("div");
    step.className = "funnel-step";
    step.innerHTML = `<div class="step-no">${s.no}</div><div class="step-count">0</div><div class="step-label">${s.label}</div>`;
    grid.appendChild(step);
  });
}
renderFunnel("funnelGrid");
renderFunnel("funnelGridAgent");

// ---------- Leads Tracker filter pills ----------
document.querySelectorAll("#leadPills .pill").forEach(p => {
  p.addEventListener("click", () => {
    document.querySelectorAll("#leadPills .pill").forEach(x => x.classList.remove("active"));
    p.classList.add("active");
  });
});

// ---------- Scorecard ----------
const ratings = {}; // index -> 1..5

function renderCriteria() {
  const wrap = document.getElementById("criteriaList");
  wrap.innerHTML = "";
  CRITERIA.forEach((c, idx) => {
    const item = document.createElement("div");
    item.className = "criteria-item";
    const dots = [1, 2, 3, 4, 5].map(n =>
      `<button data-idx="${idx}" data-n="${n}">${n}</button>`
    ).join("");
    item.innerHTML = `
      <div>
        <h4>${c.title}</h4>
        <p>${c.desc}</p>
      </div>
      <div class="criteria-score">
        <div class="pts" id="pts-${idx}">0</div>
        <div class="rating-dots" data-idx="${idx}">${dots}</div>
      </div>`;
    wrap.appendChild(item);
  });

  wrap.querySelectorAll(".rating-dots button").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      const n = Number(btn.dataset.n);
      ratings[idx] = n;
      updateCriteriaUI(idx);
      updateTotalScore();
    });
  });
}

function updateCriteriaUI(idx) {
  const n = ratings[idx] || 0;
  document.querySelectorAll(`.rating-dots[data-idx="${idx}"] button`).forEach(b => {
    b.classList.toggle("selected", Number(b.dataset.n) === n);
  });
  const pts = n ? Math.round((n / 5) * CRITERIA[idx].max) : 0;
  document.getElementById(`pts-${idx}`).textContent = pts;
}

function updateTotalScore() {
  let total = 0;
  CRITERIA.forEach((c, idx) => {
    const n = ratings[idx] || 0;
    total += n ? Math.round((n / 5) * c.max) : 0;
  });
  document.getElementById("totalScore").textContent = total;
}

renderCriteria();

const scorecardCard = document.querySelector("#view-scorecard .card");
if (scorecardCard) {
  const saveScoreBtn = document.createElement("button");
  saveScoreBtn.textContent = "Submit scorecard";
  saveScoreBtn.className = "btn-primary";
  saveScoreBtn.style.marginTop = "20px";
  saveScoreBtn.style.width = "auto";
  saveScoreBtn.style.padding = "11px 22px";
  saveScoreBtn.addEventListener("click", async () => {
    if (!currentProfile) return;
    const agentId = document.getElementById("consultantSelect").value;
    const evaluator = document.querySelector('#view-scorecard input[type="text"]').value;
    const evalDate = document.querySelector('#view-scorecard input[type="date"]').value;
    const scores = {};
    CRITERIA.forEach((c, idx) => { scores[c.title] = ratings[idx] || 0; });
    const total = Number(document.getElementById("totalScore").textContent);

    saveScoreBtn.textContent = "Saving…";
    const { error } = await supabaseClient.from("scorecards").insert({
      agent_id: agentId,
      evaluator_name: evaluator,
      evaluation_date: evalDate || new Date().toISOString().slice(0, 10),
      scores,
      total_score: total,
    });
    saveScoreBtn.textContent = error ? "Error — try again" : "Submitted ✓";
    if (!error) setTimeout(() => (saveScoreBtn.textContent = "Submit scorecard"), 1500);
  });
  scorecardCard.appendChild(saveScoreBtn);
}

// ---------- Live "today" date in headers ----------
(function setDates() {
  const opts = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
  const label = new Date().toLocaleDateString("en-US", opts);
  document.querySelectorAll(".date-pill").forEach(el => el.textContent = label);
})();
