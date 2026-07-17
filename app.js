// ============================================================
// Discover Group Sales Portal — application logic
// ============================================================

// ---- Commission rule ----
// A consultant must collect at least ₱5,000,000 within the calendar month
// to qualify. Once they do, they earn 1% of everything they collected that
// month — not 1% of the excess. Below the threshold the commission is zero.
// The total resets on the 1st of each month.
const COMMISSION_THRESHOLD = 5000000;
const COMMISSION_RATE = 0.01;
// ---- Daily bonus rule ----
// Counted per agent, per day. A booking's passengers land on the date of its
// FIRST payment — the day the deposit settled. The tier is all-or-nothing:
// close 10 passengers in a day and every one of the 10 earns ₱1,500, not
// just the tenth. Below 10 in a day, nothing is earned.
const BONUS_TIERS = [
  { minPax: 40, perHead: 3000 },
  { minPax: 30, perHead: 2500 },
  { minPax: 20, perHead: 2000 },
  { minPax: 10, perHead: 1500 },
];

const BOOKED_STAGE = "Successfully Booked";
const LOST_STAGE = "Lost Opportunity";

const FUNNEL_STAGES = [
  { no: "01", label: "New Inquiry" },
  { no: "02", label: "Discovery & Qualification" },
  { no: "03", label: "Solution Presented" },
  { no: "04", label: "Decision in Progress" },
  { no: "05", label: "Strategic Nurturing" },
  { no: "06", label: "Reservation / Payment Processing" },
  { no: "07", label: "Successfully Booked" },
  { no: "08", label: "Lost Opportunity" },
];

const CRITERIA = [
  { title: "Lead Response Time", desc: "All new inquiries are answered within 30 minutes during 10:00 AM–7:00 PM.", max: 10 },
  { title: "Personalized Client Engagement", desc: "Responses are natural, tailored, conversational, and never robotic or AI-like.", max: 20 },
  { title: "Warm & Professional Client Experience", desc: "Communication builds trust through warmth, empathy, professionalism, and confidence.", max: 10 },
  { title: "Strategic Follow-through & Follow-up Compliance", desc: "Every active lead is followed up within 24 hours using value-driven closing strategies.", max: 25 },
  { title: "Product Knowledge & Consultative Expertise", desc: "Information on packages, visas, itineraries, flights, and policies is accurate and confident.", max: 10 },
  { title: "CRM / Sales Tracker & Funnel Management", desc: "Every lead has complete records, correct stage, next action, strategy, and remarks.", max: 10 },
  { title: "Sales Initiative & Opportunity Maximization", desc: "Consultant proactively offers alternatives, dates, packages, promotions, and upgrades.", max: 15 },
];

const currency = n => "₱" + Number(n || 0).toLocaleString();
const shortCurrency = n => {
  const v = Number(n || 0);
  if (v >= 1000000) return "₱" + (v / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (v >= 1000) return "₱" + Math.round(v / 1000) + "k";
  return "₱" + v;
};

// ---------- Shared data ----------
let currentProfile = null;     // { id, full_name, role }
let allLeadsCache = [];
let allProfilesCache = [];
let allScorecardsCache = [];
let currentPeriod = "today";    // Team Dashboard pills (matches the active pill)
let currentLeadFilter = "today"; // Leads Tracker pills

// ---------- Lead maths ----------
// Every number on every dashboard comes from these helpers, so a change
// here flows through the cards, the ranking, the funnel and the table.

function leadPaid(l) {
  return (l.payments || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
}

function leadIsBooked(l) {
  return l.journey_stage === BOOKED_STAGE;
}

function leadIsActive(l) {
  return l.journey_stage !== BOOKED_STAGE && l.journey_stage !== LOST_STAGE;
}

// ---------- Date ranges ----------
// The pills in index.html carry data-range="today|yesterday|y2|all|custom".
// "y2" is Yesterday + Today. "custom" reads the From/To boxes beside them.
function rangeFor(range, fromInput, toInput) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const shift = n => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
  const endOf = d => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };

  if (range === "today") return { start: today, end: endOf(today) };
  if (range === "yesterday") return { start: shift(-1), end: endOf(shift(-1)) };
  if (range === "y2") return { start: shift(-1), end: endOf(today) };
  if (range === "custom") {
    return {
      start: fromInput?.value ? new Date(fromInput.value + "T00:00:00") : null,
      end: toInput?.value ? new Date(toInput.value + "T23:59:59") : null,
    };
  }
  return { start: null, end: null }; // "all"
}

function inRange(date, { start, end }) {
  if (!date) return false;
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

// A lead is dated by when the client inquired. Older records saved before
// that field was filled in fall back to when the record was created.
function leadDate(l) {
  if (l.inquiry_date) return new Date(l.inquiry_date + "T00:00:00");
  return l.created_at ? new Date(l.created_at) : null;
}

function currentMonthRange() {
  const now = new Date();
  return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: null };
}

function dateInputs(viewId) {
  const els = document.querySelectorAll(`#${viewId} .date-range input[type="date"]`);
  return { from: els[0], to: els[1] };
}

// Commission is all-or-nothing: clear the threshold and the whole month's
// collections earn the rate; fall short and nothing is earned.
function commissionOn(netSales) {
  return netSales >= COMMISSION_THRESHOLD ? netSales * COMMISSION_RATE : 0;
}

// Commission always follows the calendar month, whatever range the pills
// are showing, because that is when the target resets.
function monthlyNetSales(agentId) {
  const month = currentMonthRange();
  return allLeadsCache
    .filter(l => l.agent_id === agentId)
    .reduce((sum, l) => sum + (l.payments || [])
      .filter(p => p.date && inRange(new Date(p.date + "T00:00:00"), month))
      .reduce((s, p) => s + (Number(p.amount) || 0), 0), 0);
}

// Money actually collected within a date range, counted by payment date.
function netSalesInRange(agentId, range) {
  return allLeadsCache
    .filter(l => !agentId || l.agent_id === agentId)
    .reduce((sum, l) => sum + (l.payments || [])
      .filter(p => p.date && inRange(new Date(p.date + "T00:00:00"), range))
      .reduce((s, p) => s + (Number(p.amount) || 0), 0), 0);
}

// The rate every head earns once the day's tier is reached.
function bonusPerHead(pax) {
  return BONUS_TIERS.find(t => pax >= t.minPax)?.perHead || 0;
}

// The day a booking counts as closed: the date of its earliest payment.
function firstPaymentDate(l) {
  const dates = (l.payments || []).map(p => p.date).filter(Boolean).sort();
  return dates[0] || null; // "YYYY-MM-DD"
}

// Passengers closed per day, keyed by date.
function paxByDay(leads) {
  const byDay = new Map();
  leads.forEach(l => {
    const day = firstPaymentDate(l);
    if (!day) return;
    byDay.set(day, (byDay.get(day) || 0) + (Number(l.travelers) || 0));
  });
  return byDay;
}

// Each day is scored on its own, then the qualifying days are added up.
function bonusForAgent(agentId, range) {
  let total = 0;
  paxByDay(allLeadsCache.filter(l => l.agent_id === agentId)).forEach((pax, day) => {
    if (!inRange(new Date(day + "T00:00:00"), range)) return;
    total += pax * bonusPerHead(pax);
  });
  return total;
}

// Passengers whose deposit landed on one specific day.
function paxOnDay(agentId, isoDay) {
  return paxByDay(allLeadsCache.filter(l => l.agent_id === agentId)).get(isoDay) || 0;
}

// Roll a set of leads up into the figures the dashboards display.
function summarise(leads) {
  const booked = leads.filter(leadIsBooked);
  const active = leads.filter(leadIsActive);
  const netSales = leads.reduce((sum, l) => sum + leadPaid(l), 0);
  const pax = booked.reduce((sum, l) => sum + (Number(l.travelers) || 0), 0);
  return {
    leads: leads.length,
    active: active.length,
    booked: booked.length,
    pax,
    netSales,
    pipeline: active.reduce((sum, l) => sum + (Number(l.deal_value) || 0), 0),
    commission: commissionOn(netSales),
  };
}

function averageScore(agentId) {
  const mine = allScorecardsCache.filter(s => s.agent_id === agentId);
  if (mine.length === 0) return null;
  return Math.round(mine.reduce((sum, s) => sum + (Number(s.total_score) || 0), 0) / mine.length);
}

function agentName(agentId) {
  return allProfilesCache.find(p => p.id === agentId)?.full_name || "Unassigned";
}

// ---------- Real login (Supabase Auth) ----------
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
  await Promise.all([loadProfiles(), loadLeads(), loadScorecards(), loadDocIndex(), loadApprovals(), loadMyPwRequest()]);
  renderAll();
}

// ---------- Change password (admin-approved) ----------
// An employee requests, an admin approves, and the approval is spent on one
// change. Worth knowing: this is a workflow control, not a security boundary.
// Supabase Auth always permits a signed-in user to change their own password,
// so a determined person could bypass the UI. It stops normal use and leaves
// an audit trail; it is not a lock.
let myPwRequest = null;

async function loadMyPwRequest() {
  if (!currentProfile) return;
  const { data, error } = await supabaseClient
    .from("password_change_requests")
    .select("*")
    .eq("agent_id", currentProfile.id)
    .in("status", ["Pending", "Approved"])
    .order("created_at", { ascending: false })
    .limit(1);
  myPwRequest = (!error && data && data.length) ? data[0] : null;
}

function ensurePasswordPanel() {
  if (document.getElementById("pwPanel")) return;
  const box = document.querySelector(".workspace-box");
  if (!box) return;

  const link = document.createElement("button");
  link.type = "button";
  link.id = "pwLink";
  link.style.cssText = `display:block; margin-top:10px; background:none; border:none; padding:0;
    color:var(--gold-600); font-size:11.5px; font-weight:600; cursor:pointer; font-family:inherit;
    text-decoration:underline; text-align:left;`;
  box.appendChild(link);

  const panel = document.createElement("div");
  panel.id = "pwPanel";
  panel.style.cssText = "display:none; margin-top:10px;";
  panel.innerHTML = `
    <input type="password" id="pwNew" placeholder="New password" autocomplete="new-password"
      style="width:100%; padding:7px 9px; border:1px solid rgba(255,255,255,.25); border-radius:6px;
      background:rgba(255,255,255,.1); color:#fff; font-size:12px; font-family:inherit; margin-bottom:6px;">
    <input type="password" id="pwConfirm" placeholder="Confirm new password" autocomplete="new-password"
      style="width:100%; padding:7px 9px; border:1px solid rgba(255,255,255,.25); border-radius:6px;
      background:rgba(255,255,255,.1); color:#fff; font-size:12px; font-family:inherit; margin-bottom:6px;">
    <button type="button" id="pwSave"
      style="width:100%; padding:7px; border:none; border-radius:6px; background:var(--gold-600);
      color:#fff; font-size:12px; font-weight:700; cursor:pointer; font-family:inherit;">Save password</button>
    <div id="pwMsg" style="font-size:11px; margin-top:6px; color:#fff; opacity:.85;"></div>`;
  box.appendChild(panel);

  link.addEventListener("click", async () => {
    const status = myPwRequest?.status;

    if (status === "Approved") {
      const open = panel.style.display === "block";
      panel.style.display = open ? "none" : "block";
      link.textContent = open ? "Set a new password" : "Cancel";
      return;
    }
    if (status === "Pending") return; // waiting on an admin

    const reason = prompt("Why do you need to change your password?\n(An admin has to approve this first.)");
    if (reason === null) return;

    const { error } = await supabaseClient.from("password_change_requests").insert({
      agent_id: currentProfile.id,
      reason: reason || null,
    });
    if (error) { link.textContent = "Couldn't send request"; return; }
    await loadMyPwRequest();
    renderPasswordPanel();
  });

  document.getElementById("pwSave").addEventListener("click", async () => {
    const a = document.getElementById("pwNew").value;
    const b = document.getElementById("pwConfirm").value;
    const msg = document.getElementById("pwMsg");
    const btn = document.getElementById("pwSave");

    if (myPwRequest?.status !== "Approved") { msg.textContent = "Not approved yet."; return; }
    if (a.length < 8) { msg.textContent = "Use at least 8 characters."; return; }
    if (a !== b) { msg.textContent = "The two passwords don't match."; return; }

    btn.disabled = true;
    btn.textContent = "Saving…";
    const { error } = await supabaseClient.auth.updateUser({ password: a });
    if (error) {
      btn.disabled = false;
      btn.textContent = "Save password";
      msg.textContent = "Couldn't change it — " + error.message;
      return;
    }

    // Spend the approval so it can't be reused.
    await supabaseClient.from("password_change_requests")
      .update({ status: "Used", used_at: new Date().toISOString() })
      .eq("id", myPwRequest.id);

    msg.textContent = "Password changed ✓";
    document.getElementById("pwNew").value = "";
    document.getElementById("pwConfirm").value = "";
    await loadMyPwRequest();
    setTimeout(() => { panel.style.display = "none"; msg.textContent = ""; renderPasswordPanel(); }, 1600);
    btn.disabled = false;
    btn.textContent = "Save password";
  });

  renderPasswordPanel();
}

function renderPasswordPanel() {
  const link = document.getElementById("pwLink");
  const panel = document.getElementById("pwPanel");
  if (!link || !panel) return;
  const status = myPwRequest?.status;

  if (status === "Approved") {
    link.textContent = "Set a new password";
    link.style.cursor = "pointer";
    link.style.opacity = "1";
  } else if (status === "Pending") {
    link.textContent = "Password change — awaiting approval";
    link.style.cursor = "default";
    link.style.opacity = "0.7";
    link.style.textDecoration = "none";
    panel.style.display = "none";
  } else {
    link.textContent = "Request password change";
    link.style.cursor = "pointer";
    link.style.opacity = "1";
    link.style.textDecoration = "underline";
    panel.style.display = "none";
  }
}

function enterWorkspace(name, role) {
  document.getElementById("sidebarName").textContent = name;
  const ROLE_LABELS = { admin: "Team Lead", sales_admin: "Admin Assistant of Sales", agent: "Sales Agent" };
  document.querySelector(".role-pill").textContent = ROLE_LABELS[role] || "Sales Agent";
  document.getElementById("agentSub").textContent = "Individual performance for " + name;
  document.getElementById("scorecardSub").textContent = "Daily scorecard for " + name;
  document.getElementById("leadsOwner").textContent = name + "'s Leads Tracker";
  ensurePasswordPanel();

  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("app").classList.add("active");
}

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  currentProfile = null;
  allLeadsCache = [];
  allScorecardsCache = [];
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

function goToView(view) {
  const btn = document.querySelector(`#nav button[data-view="${view}"]`);
  if (btn) btn.click();
}

// ---------- Loading data ----------
async function loadProfiles() {
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id, full_name, role, rank")
    .order("full_name");
  if (!error && data) allProfilesCache = data;

  // Consultant dropdowns — populated from the real employee list
  const optionsHtml = allProfilesCache.map(p => `<option value="${p.id}">${p.full_name}</option>`).join("");
  const sel = document.getElementById("consultantSelect");
  if (sel) { sel.innerHTML = optionsHtml; if (currentProfile) sel.value = currentProfile.id; }

  const cpSel = document.getElementById("cp_consultant");
  if (cpSel && currentProfile) {
    cpSel.innerHTML = optionsHtml;
    cpSel.value = currentProfile.id;
    // Assigning a lead hands over ownership, so only admins and sales
    // admins may do it. Agents stay locked to their own name.
    if (currentProfile.role === "agent") {
      cpSel.disabled = true;
      const field = cpSel.closest(".form-field");
      const label = field?.querySelector("label");
      if (label && !label.dataset.locked) {
        label.dataset.locked = "1";
        label.textContent = "Assigned consultant (you)";
      }
    } else {
      cpSel.disabled = false;
    }
  }
}

async function loadLeads() {
  if (!currentProfile) return;
  const { data, error } = await supabaseClient
    .from("leads")
    .select("*")
    .order("created_at", { ascending: false });
  allLeadsCache = (!error && data) ? data : [];
  populateVoucherSelect(allLeadsCache);
}

async function loadScorecards() {
  const { data, error } = await supabaseClient
    .from("scorecards")
    .select("agent_id, total_score, evaluation_date");
  allScorecardsCache = (!error && data) ? data : [];
}

// Redraws every derived view. Safe to call before the data arrives.
function renderAll() {
  renderTeamStats();
  renderRanking();
  renderAgentPerformance();
  renderTeamFunnel();
  renderAgentDashboard();
  renderLeadsTable();
  renderUrgentAlerts();
  wireResources();
}

// ---------- Daily Sales Ranking ----------
// This card is a single-day ranking, driven by the "Ranking date" box.
function renderRanking() {
  const list = document.getElementById("rankingList");
  if (!list) return;

  const dateEl = document.getElementById("rankDate");
  const day = dateEl?.value || new Date().toISOString().slice(0, 10);
  const dayRange = { start: new Date(day + "T00:00:00"), end: new Date(day + "T23:59:59") };

  const rows = allProfilesCache.map(p => {
    const pax = paxOnDay(p.id, day);
    const monthNet = monthlyNetSales(p.id);
    return {
      profile: p,
      netSales: netSalesInRange(p.id, dayRange),
      pax,
      bonus: pax * bonusPerHead(pax),
      monthNet,
      commission: commissionOn(monthNet),
    };
  }).sort((a, b) => b.netSales - a.netSales || b.pax - a.pax);

  if (rows.length === 0) {
    list.innerHTML = '<div class="registry-empty">No employees found.</div>';
    return;
  }

  list.innerHTML = rows.map((r, i) => `
    <div class="rank-row">
      <div class="rank-badge">${i + 1}</div>
      <div>
        <div class="rank-name">${r.profile.full_name}</div>
        <div class="rank-sub">${
          r.monthNet >= COMMISSION_THRESHOLD
            ? "commission unlocked this month"
            : shortCurrency(COMMISSION_THRESHOLD - r.monthNet) + " more this month to unlock commission"
        }</div>
      </div>
      <div class="rank-metrics">
        <div><div class="m-label">Net sales</div><div class="m-value">${currency(r.netSales)}</div></div>
        <div><div class="m-label">Pax closed</div><div class="m-value">${r.pax}</div></div>
        <div><div class="m-label">Daily bonus</div><div class="m-value">${currency(r.bonus)}</div></div>
        <div><div class="m-label">Commission</div><div class="m-value">${currency(r.commission)}</div></div>
      </div>
    </div>`).join("");
}

// ---------- Agent Performance Overview ----------
function renderAgentPerformance() {
  const grid = document.getElementById("agentPerfGrid");
  if (!grid) return;

  const range = rangeFor(currentPeriod, dateInputs("view-team").from, dateInputs("view-team").to);
  const scoped = allLeadsCache.filter(l => inRange(leadDate(l), range));

  grid.innerHTML = allProfilesCache.map(p => {
    const s = summarise(scoped.filter(l => l.agent_id === p.id));
    const score = averageScore(p.id);
    const commission = commissionOn(monthlyNetSales(p.id));
    return `
      <div class="agent-perf-card">
        <div class="agent-perf-head">
          <h4>${p.full_name}</h4>
          <span>${s.active} active opportunit${s.active === 1 ? "y" : "ies"}</span>
        </div>
        <div class="agent-perf-metrics">
          <div><div class="num">${s.leads}</div><div class="lbl">leads</div></div>
          <div><div class="num">${s.pax}</div><div class="lbl">pax</div></div>
          <div><div class="num">${shortCurrency(s.netSales)}</div><div class="lbl">NSC</div></div>
          <div><div class="num">${score === null ? "—" : score}</div><div class="lbl">score</div></div>
          <div style="grid-column: span 2;"><div class="num">${currency(commission)}</div><div class="lbl">commission this month</div></div>
        </div>
      </div>`;
  }).join("");
}

// ---------- Funnels ----------
function drawFunnel(targetId, leads) {
  const grid = document.getElementById(targetId);
  if (!grid) return;
  const total = leads.length;
  grid.innerHTML = FUNNEL_STAGES.map(s => {
    const count = leads.filter(l => l.journey_stage === s.label).length;
    const share = total ? Math.round((count / total) * 100) : 0;
    return `
      <div class="funnel-step">
        <div class="step-no">${s.no}</div>
        <div class="step-count">${count}</div>
        <div class="step-label">${s.label}</div>
        <div style="font-size:11px; color:var(--ink-soft); margin-top:4px;">${share}%</div>
      </div>`;
  }).join("");
}

function renderTeamFunnel() {
  const range = rangeFor(currentPeriod, dateInputs("view-team").from, dateInputs("view-team").to);
  drawFunnel("funnelGrid", allLeadsCache.filter(l => inRange(leadDate(l), range)));
}

// ---------- Stat cards ----------
// The cards in index.html have no ids, so each one is found by its label.
function setStat(viewId, labelText, value) {
  document.querySelectorAll(`#${viewId} .stat-card`).forEach(card => {
    const label = card.querySelector(".label");
    if (label && label.textContent.trim().toLowerCase() === labelText.toLowerCase()) {
      const v = card.querySelector(".value");
      if (v) v.textContent = value;
    }
  });
}

function renderTeamStats() {
  const range = rangeFor(currentPeriod, dateInputs("view-team").from, dateInputs("view-team").to);
  const scoped = allLeadsCache.filter(l => inRange(leadDate(l), range));
  const s = summarise(scoped);

  const teamCommission = allProfilesCache
    .reduce((sum, p) => sum + commissionOn(monthlyNetSales(p.id)), 0);
  const teamBonus = allProfilesCache
    .reduce((sum, p) => sum + bonusForAgent(p.id, range), 0);

  setStat("view-team", "Total Leads", s.leads);
  setStat("view-team", "Open Follow-ups", s.active);
  setStat("view-team", "Pax Closed", s.pax);
  setStat("view-team", "Net Sales Collection", currency(netSalesInRange(null, range)));
  setStat("view-team", "Unlocked Commission", currency(teamCommission));
  setStat("view-team", "Daily Bonuses", currency(teamBonus));

  // Team average score in the banner
  const scored = allProfilesCache.map(p => averageScore(p.id)).filter(v => v !== null);
  const avg = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : 0;
  const bannerValue = document.querySelector("#view-team .banner-stat .value");
  if (bannerValue) bannerValue.innerHTML = `${avg}<span> /100</span>`;
}

// ---------- Agent Dashboard ----------
// The whole page is built here rather than in index.html, so the layout and
// the numbers stay in one place.

let agentPeriod = "month";      // month | last | all
let agentSearch = "";
let agentPage = 1;
const AGENT_LEADS_PER_PAGE = 5;

// The funnel counts leads that reached a stage *or moved past it*, which is
// what makes each step a real drop-off rather than a snapshot.
const PIPELINE = [
  { label: "New Inquiry", colour: "#1e3a6d" },
  { label: "Discovery & Qualification", colour: "#2f5596" },
  { label: "Solution Presented", colour: "#4a6fb5" },
  { label: "Decision in Progress", colour: "#7b6bc4" },
  { label: "Strategic Nurturing", colour: "#c9a227" },
  { label: "Reservation / Payment Processing", colour: "#4a9d8e" },
  { label: "Successfully Booked", colour: "#2e8b57" },
];

function stageRank(stage) {
  return PIPELINE.findIndex(s => s.label === stage);
}

function agentRange(period) {
  const now = new Date();
  if (period === "month") {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: null };
  }
  if (period === "last") {
    return {
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      end: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59),
    };
  }
  return { start: null, end: null };
}

// Whose dashboard is on screen. Defaults to your own.
let agentViewId = null;

// You may open the dashboard of anyone strictly below you in rank, and your
// own — never a peer's, and never someone above you. That's why Niña can see
// every consultant but not the CEO.
function viewableProfiles() {
  if (!currentProfile) return [];
  const me = allProfilesCache.find(p => p.id === currentProfile.id);
  const myRank = me?.rank ?? 10;
  if (currentProfile.role !== "admin") return [me].filter(Boolean);
  return allProfilesCache
    .filter(p => p.id === currentProfile.id || (p.rank ?? 10) < myRank)
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0) || a.full_name.localeCompare(b.full_name));
}

function viewedProfile() {
  const list = viewableProfiles();
  const found = list.find(p => p.id === agentViewId);
  return found || list.find(p => p.id === currentProfile?.id) || null;
}

function myLeads(range) {
  const who = viewedProfile();
  if (!who) return [];
  const theirs = allLeadsCache.filter(l => l.agent_id === who.id);
  return range ? theirs.filter(l => inRange(leadDate(l), range)) : theirs;
}

function overviewFor(range) {
  const who = viewedProfile();
  if (!who) return { total: 0, qualified: 0, proposals: 0, won: 0, revenue: 0 };
  const leads = myLeads(range);
  const atLeast = label => leads.filter(l => stageRank(l.journey_stage) >= stageRank(label)).length;
  return {
    total: leads.length,
    qualified: atLeast("Discovery & Qualification"),
    proposals: atLeast("Solution Presented"),
    won: leads.filter(leadIsBooked).length,
    revenue: netSalesInRange(who.id, range.start ? range : { start: null, end: null }),
  };
}

// "12% vs last month" is meaningless without a baseline, so a metric with no
// history to compare against says so instead of inventing a number.
function deltaLabel(now, before) {
  if (before === 0) return now === 0 ? "" : "new this month";
  const pct = Math.round(((now - before) / before) * 100);
  const up = pct >= 0;
  return `<span style="color:${up ? "#2e8b57" : "#b42318"}; font-weight:600;">${up ? "▲" : "▼"} ${Math.abs(pct)}%</span>
    <span style="color:var(--ink-faint);">vs last month</span>`;
}

function statTile(label, value, delta) {
  return `
    <div style="flex:1; min-width:170px; background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px 18px;">
      <div style="font-size:12px; color:var(--ink-soft); margin-bottom:8px;">${label}</div>
      <div style="font-size:26px; font-weight:800; color:var(--navy-900); letter-spacing:-.02em;">${value}</div>
      <div style="font-size:11.5px; margin-top:6px;">${delta || "&nbsp;"}</div>
    </div>`;
}

function donutSlices(data, total, size = 170) {
  const r = size / 2 - 18, cx = size / 2, cy = size / 2;
  let angle = -Math.PI / 2;
  return data.map(d => {
    const slice = total ? (d.value / total) * Math.PI * 2 : 0;
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
    angle += slice;
    const x2 = cx + r * Math.cos(angle), y2 = cy + r * Math.sin(angle);
    const large = slice > Math.PI ? 1 : 0;
    if (slice === 0) return "";
    // A full circle can't be drawn as a single arc — it collapses to a point.
    if (slice >= Math.PI * 2 - 0.001) {
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${d.colour}" stroke-width="26"/>`;
    }
    return `<path d="M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}"
      fill="none" stroke="${d.colour}" stroke-width="26"/>`;
  }).join("");
}

function activityFeed(leads) {
  const items = [];
  leads.forEach(l => {
    const name = l.client_full_name || "Unnamed client";
    items.push({ kind: "New lead added", name, at: new Date(l.created_at), colour: "#4a6fb5" });
    if (l.updated_at && new Date(l.updated_at) - new Date(l.created_at) > 60000) {
      items.push({ kind: "Lead updated", name, at: new Date(l.updated_at), colour: "#c9a227" });
    }
    (l.payments || []).forEach(p => {
      if (p.date) items.push({ kind: `Payment ${currency(p.amount)}`, name, at: new Date(p.date + "T12:00:00"), colour: "#2e8b57" });
    });
  });
  return items.sort((a, b) => b.at - a.at).slice(0, 6);
}

function timeAgo(d) {
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 2) return "Just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  if (days < 30) return days + "d ago";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function renderAgentDashboard() {
  const view = document.getElementById("view-agent");
  if (!view || !currentProfile) return;

  // Clear whatever index.html shipped with, once.
  let body = document.getElementById("agentBody");
  if (!body) {
    [...view.children].forEach(el => { if (!el.classList.contains("view-head")) el.remove(); });
    body = document.createElement("div");
    body.id = "agentBody";
    view.appendChild(body);
  }

  const range = agentRange(agentPeriod);
  const leads = myLeads(range);
  const now = overviewFor(agentRange("month"));
  const prev = overviewFor(agentRange("last"));
  const scoped = agentPeriod === "month" ? now : overviewFor(range);

  // Funnel
  const funnelTotal = leads.filter(l => l.journey_stage !== LOST_STAGE).length;
  const funnelRows = PIPELINE.map((s, i) => {
    const count = leads.filter(l => l.journey_stage !== LOST_STAGE && stageRank(l.journey_stage) >= i).length;
    const share = funnelTotal ? Math.round((count / funnelTotal) * 1000) / 10 : 0;
    const width = 100 - i * 9;
    return { ...s, count, share, width };
  });
  const lost = leads.filter(l => l.journey_stage === LOST_STAGE).length;

  // Pipeline value by stage — open opportunities only
  const pipeData = PIPELINE.slice(0, -1).map(s => ({
    label: s.label, colour: s.colour,
    value: leads.filter(l => l.journey_stage === s.label).reduce((sum, l) => sum + (Number(l.deal_value) || 0), 0),
  })).filter(d => d.value > 0);
  const pipeTotal = pipeData.reduce((s, d) => s + d.value, 0);

  // Top destinations
  const destMap = new Map();
  leads.forEach(l => {
    const d = (l.package_destination || "").trim();
    if (d) destMap.set(d, (destMap.get(d) || 0) + 1);
  });
  const dests = [...destMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const destMax = dests.length ? dests[0][1] : 1;

  // My Leads table
  const q = agentSearch.trim().toLowerCase();
  const tableLeads = leads
    .filter(l => !q || [l.client_full_name, l.package_destination, l.client_mobile]
      .some(v => (v || "").toLowerCase().includes(q)))
    .sort((a, b) => (leadDate(b)?.getTime() || 0) - (leadDate(a)?.getTime() || 0));
  const pages = Math.max(1, Math.ceil(tableLeads.length / AGENT_LEADS_PER_PAGE));
  if (agentPage > pages) agentPage = pages;
  const pageStart = (agentPage - 1) * AGENT_LEADS_PER_PAGE;
  const rows = tableLeads.slice(pageStart, pageStart + AGENT_LEADS_PER_PAGE);

  const feed = activityFeed(leads);
  const who = viewedProfile();
  const canSwitch = viewableProfiles().length > 1;
  const viewingSomeoneElse = who && who.id !== currentProfile.id;

  // Say plainly whose numbers these are — an admin glancing at this should
  // never mistake someone else's pipeline for their own.
  const sub = document.getElementById("agentSub");
  if (sub && who) {
    sub.textContent = viewingSomeoneElse
      ? `Viewing ${who.full_name}'s performance`
      : "Individual performance for " + who.full_name;
  }

  const th = "padding:10px 12px; text-align:left; font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-faint); border-bottom:1px solid var(--line); white-space:nowrap;";
  const td = "padding:13px 12px; font-size:13px; border-bottom:1px solid rgba(0,0,0,.04); color:var(--ink-soft);";

  body.innerHTML = `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; gap:10px; flex-wrap:wrap;">
        <h2 style="margin:0; font-size:16px; color:var(--navy-900);">Sales Overview</h2>
        <div style="display:flex; gap:8px; align-items:center;">
          ${canSwitch ? `
            <select id="agentWhoSelect" style="padding:8px 12px; border:1px solid var(--line); border-radius:8px;
              font-size:13px; font-family:inherit; background:#fff; color:var(--navy-900); font-weight:600;">
              ${viewableProfiles().map(p => `
                <option value="${p.id}" ${p.id === who?.id ? "selected" : ""}>
                  ${p.id === currentProfile.id ? "My dashboard" : p.full_name}
                </option>`).join("")}
            </select>` : ""}
          <select id="agentPeriodSelect" style="padding:8px 12px; border:1px solid var(--line); border-radius:8px; font-size:13px; font-family:inherit; background:#fff;">
            <option value="month" ${agentPeriod === "month" ? "selected" : ""}>This Month</option>
            <option value="last" ${agentPeriod === "last" ? "selected" : ""}>Last Month</option>
            <option value="all" ${agentPeriod === "all" ? "selected" : ""}>All Time</option>
          </select>
        </div>
      </div>
      ${viewingSomeoneElse ? `
        <div style="margin:-4px 0 14px; padding:8px 12px; background:#fff8e6; border:1px solid var(--gold-600);
          border-radius:8px; font-size:12.5px; color:var(--navy-900);">
          You're viewing <strong>${who.full_name}</strong>'s dashboard, not your own.
        </div>` : ""}
      <div style="display:flex; gap:12px; flex-wrap:wrap;">
        ${statTile("Total Leads", scoped.total, deltaLabel(now.total, prev.total))}
        ${statTile("Qualified Leads", scoped.qualified, deltaLabel(now.qualified, prev.qualified))}
        ${statTile("Proposals Sent", scoped.proposals, deltaLabel(now.proposals, prev.proposals))}
        ${statTile("Won Sales", scoped.won, deltaLabel(now.won, prev.won))}
        ${statTile("Revenue (PHP)", currency(scoped.revenue), deltaLabel(now.revenue, prev.revenue))}
      </div>
    </div>

    <div style="display:grid; grid-template-columns: 1.1fr 1fr 0.8fr; gap:16px; margin-top:16px;">
      <div class="card" style="margin:0;">
        <h2 style="margin:0 0 14px; font-size:16px; color:var(--navy-900);">Sales Funnel</h2>
        ${funnelTotal === 0 ? '<div class="registry-empty">No leads in this period yet.</div>' : funnelRows.map(r => `
          <div style="display:flex; align-items:center; gap:12px; margin-bottom:6px;">
            <div style="flex:1; min-width:0;">
              <div style="width:${r.width}%; background:${r.colour}; color:#fff; padding:9px 12px;
                border-radius:6px; font-size:12px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${r.label}</div>
            </div>
            <div style="width:44px; text-align:right; font-weight:700; color:var(--navy-900); font-size:13px;">${r.count}</div>
            <div style="width:52px; text-align:right; font-size:12px; color:var(--ink-faint);">${r.share}%</div>
          </div>`).join("")}
        ${lost ? `<div style="margin-top:12px; font-size:12px; color:var(--ink-faint);">${lost} lost opportunit${lost === 1 ? "y" : "ies"} — not counted in the funnel above.</div>` : ""}
      </div>

      <div class="card" style="margin:0;">
        <h2 style="margin:0 0 14px; font-size:16px; color:var(--navy-900);">Pipeline Value</h2>
        ${pipeTotal === 0 ? '<div class="registry-empty">No open deal value yet.</div>' : `
          <div style="display:flex; align-items:center; gap:16px; flex-wrap:wrap;">
            <div style="position:relative; width:170px; height:170px; flex-shrink:0;">
              <svg viewBox="0 0 170 170" style="width:170px; height:170px;">${donutSlices(pipeData, pipeTotal)}</svg>
              <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; pointer-events:none;">
                <div style="font-size:17px; font-weight:800; color:var(--navy-900);">${shortCurrency(pipeTotal)}</div>
                <div style="font-size:10.5px; color:var(--ink-faint);">Total Pipeline</div>
              </div>
            </div>
            <div style="flex:1; min-width:150px;">
              ${pipeData.map(d => `
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:7px; font-size:12px;">
                  <span style="width:9px; height:9px; border-radius:50%; background:${d.colour}; flex-shrink:0;"></span>
                  <span style="flex:1; color:var(--ink-soft); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${d.label}</span>
                  <span style="color:var(--navy-900); font-weight:600; white-space:nowrap;">${shortCurrency(d.value)}</span>
                  <span style="color:var(--ink-faint); width:34px; text-align:right;">${Math.round((d.value / pipeTotal) * 100)}%</span>
                </div>`).join("")}
            </div>
          </div>`}
      </div>

      <div class="card" style="margin:0;">
        <h2 style="margin:0 0 4px; font-size:16px; color:var(--navy-900);">Top Destinations</h2>
        <p style="margin:0 0 14px; font-size:11.5px; color:var(--ink-faint);">by leads</p>
        ${dests.length === 0 ? '<div class="registry-empty">No packages recorded.</div>' : dests.map(([name, n]) => `
          <div style="margin-bottom:12px;">
            <div style="display:flex; justify-content:space-between; font-size:12.5px; margin-bottom:5px;">
              <span style="color:var(--navy-900); font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${name}</span>
              <span style="color:var(--ink-soft); font-weight:700; margin-left:8px;">${n}</span>
            </div>
            <div style="height:5px; background:#eef1f6; border-radius:99px; overflow:hidden;">
              <div style="width:${(n / destMax) * 100}%; height:100%; background:var(--navy-900); border-radius:99px;"></div>
            </div>
          </div>`).join("")}
      </div>
    </div>

    <div style="display:grid; grid-template-columns: 2.4fr 1fr; gap:16px; margin-top:16px;">
      <div class="card" style="margin:0;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:14px; flex-wrap:wrap;">
          <h2 style="margin:0; font-size:16px; color:var(--navy-900);">${viewingSomeoneElse ? who.full_name.split(" ")[0] + "'s Leads" : "My Leads"}</h2>
          <div style="display:flex; gap:8px; align-items:center;">
            <input id="agentSearchInput" type="search" placeholder="Search leads…" value="${agentSearch.replace(/"/g, "&quot;")}"
              style="padding:8px 13px; border:1px solid var(--line); border-radius:8px; font-size:13px; font-family:inherit; min-width:190px;">
            <button id="agentExportBtn" class="pill" type="button">↓ Export</button>
            <button id="agentNewLeadBtn" type="button" style="padding:8px 15px; border:none; border-radius:8px;
              background:var(--navy-900); color:#fff; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit;">+ New Lead</button>
          </div>
        </div>

        ${rows.length === 0 ? '<div class="registry-empty">No leads to show.</div>' : `
        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; min-width:760px;">
            <thead><tr>
              <th style="${th}">Date of inquiry</th>
              <th style="${th}">Client name</th>
              <th style="${th}">Travel date</th>
              <th style="${th} text-align:center;">No. of pax</th>
              <th style="${th}">Status</th>
              <th style="${th} text-align:right;">Est. value</th>
              <th style="${th}">Last activity</th>
              <th style="${th}">Actions</th>
            </tr></thead>
            <tbody>
              ${rows.map(l => `
                <tr>
                  <td style="${td}">${fmtDate(l.inquiry_date || l.created_at)}</td>
                  <td style="${td} font-weight:600; color:var(--navy-900);">${l.client_full_name || "Unnamed client"}</td>
                  <td style="${td}">${fmtDate(l.travel_date)}</td>
                  <td style="${td} text-align:center;">${Number(l.travelers) || 0}</td>
                  <td style="${td}"><span style="display:inline-block; padding:3px 9px; border-radius:999px; font-size:11px; font-weight:600;
                    background:${(PIPELINE.find(s => s.label === l.journey_stage)?.colour || "#8a94a6")}1a;
                    color:${PIPELINE.find(s => s.label === l.journey_stage)?.colour || "#8a94a6"};">${l.journey_stage || "—"}</span></td>
                  <td style="${td} text-align:right;">${currency(l.deal_value)}</td>
                  <td style="${td}">${l.updated_at ? timeAgo(new Date(l.updated_at)) : "—"}</td>
                  <td style="${td}">
                    <button class="agent-open" data-lead="${l.id}" type="button" title="View full profile"
                      style="padding:6px 12px; border:1px solid var(--line); border-radius:7px; background:#fff;
                      font-size:12px; font-weight:600; color:var(--navy-900); cursor:pointer; font-family:inherit;">View</button>
                  </td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:14px;">
          <div style="font-size:12.5px; color:var(--ink-faint);">Showing ${pageStart + 1} to ${pageStart + rows.length} of ${tableLeads.length} results</div>
          <div style="display:flex; gap:5px;">
            ${Array.from({ length: pages }, (_, i) => i + 1).map(n => `
              <button class="agent-page" data-page="${n}" type="button"
                style="min-width:30px; height:30px; border:1px solid ${n === agentPage ? "var(--navy-900)" : "var(--line)"};
                border-radius:7px; background:${n === agentPage ? "var(--navy-900)" : "#fff"};
                color:${n === agentPage ? "#fff" : "var(--ink-soft)"}; font-size:12.5px; font-weight:600; cursor:pointer; font-family:inherit;">${n}</button>`).join("")}
          </div>
        </div>`}
      </div>

      <div class="card" style="margin:0;">
        <h2 style="margin:0 0 14px; font-size:16px; color:var(--navy-900);">Activity Feed</h2>
        ${feed.length === 0 ? '<div class="registry-empty">Nothing yet.</div>' : feed.map(f => `
          <div style="display:flex; gap:10px; margin-bottom:14px;">
            <span style="width:7px; height:7px; border-radius:50%; background:${f.colour}; margin-top:6px; flex-shrink:0;"></span>
            <div style="flex:1; min-width:0;">
              <div style="font-size:12.5px; font-weight:600; color:var(--navy-900);">${f.kind}</div>
              <div style="font-size:11.5px; color:var(--ink-soft); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${f.name}</div>
            </div>
            <div style="font-size:11px; color:var(--ink-faint); white-space:nowrap;">${timeAgo(f.at)}</div>
          </div>`).join("")}
      </div>
    </div>`;

  document.getElementById("agentWhoSelect")?.addEventListener("change", (e) => {
    agentViewId = e.target.value;
    agentPage = 1;
    agentSearch = "";
    renderAgentDashboard();
  });
  document.getElementById("agentPeriodSelect")?.addEventListener("change", (e) => {
    agentPeriod = e.target.value; agentPage = 1; renderAgentDashboard();
  });
  const search = document.getElementById("agentSearchInput");
  search?.addEventListener("input", (e) => {
    agentSearch = e.target.value; agentPage = 1; renderAgentDashboard();
    const el = document.getElementById("agentSearchInput");
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  });
  document.getElementById("agentNewLeadBtn")?.addEventListener("click", () => goToView("client"));
  document.getElementById("agentExportBtn")?.addEventListener("click", exportLeadsCsv);
  body.querySelectorAll(".agent-page").forEach(b => b.addEventListener("click", () => {
    agentPage = Number(b.dataset.page); renderAgentDashboard();
  }));
  body.querySelectorAll(".agent-open").forEach(b => b.addEventListener("click", () => {
    const sel = document.getElementById("voucherClientSelect");
    if (!sel) return;
    sel.value = b.dataset.lead;
    sel.dispatchEvent(new Event("change"));
    goToView("voucher");
  }));
}

// ---------- Resources ----------
// The cards in index.html ship with dead links (href="#"). Point the ones we
// have destinations for at the real thing, and leave the rest honestly
// labelled rather than pretending to be clickable.
const RESOURCE_LINKS = {
  "FAQs": {
    url: "https://chatgpt.com/g/g-p-6a57a15c2f448191b58f88017368c550-dg-script/project",
    label: "Ask DG Script →",
  },
};

function wireResources() {
  document.querySelectorAll("#view-resources .stat-card").forEach(card => {
    const title = card.querySelector(".label")?.textContent.trim();
    const link = card.querySelector("a");
    if (!title || !link) return;

    const target = RESOURCE_LINKS[title];
    if (target) {
      link.textContent = target.label;
      link.href = target.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.onclick = null;              // clear the return-false stub
      link.style.opacity = "1";
      link.style.cursor = "pointer";
    } else {
      // No document yet — say so instead of offering a link that does nothing.
      link.textContent = "Not uploaded yet";
      link.removeAttribute("href");
      link.style.color = "var(--ink-faint)";
      link.style.textDecoration = "none";
      link.style.cursor = "default";
      link.onclick = null;
    }
  });

  // FAQs is now a live AI assistant, so the card should say what it is.
  document.querySelectorAll("#view-resources .stat-card").forEach(card => {
    if (card.querySelector(".label")?.textContent.trim() !== "FAQs") return;
    const hint = card.querySelector(".hint");
    if (hint) hint.textContent = "Ask DG Script — the AI sales assistant — about packages, objections, and scripts. Opens in ChatGPT; you'll need your own account.";
  });
}

// ---------- Deleting a lead ----------
// Only admins and sales admins reach this — the database enforces that too.
// Deleting removes the client, their documents and their payment history,
// so the confirmation asks for the name to be typed rather than a lazy OK.
async function deleteLead(leadId) {
  const lead = allLeadsCache.find(l => l.id === leadId);
  if (!lead) return;

  const name = lead.client_full_name || "this unnamed client";
  const paid = leadPaid(lead);
  const warning = [
    `Delete ${name}?`,
    "",
    "This removes the client profile, every uploaded document, and all payment records.",
    paid ? `⚠ ${currency(paid)} of recorded payments will be erased, and any commission or bonus based on it will change.` : "",
    "This cannot be undone.",
    "",
    `Type the client's name to confirm:`,
  ].filter(Boolean).join("\n");

  const typed = prompt(warning);
  if (typed === null) return;
  if (typed.trim().toLowerCase() !== (lead.client_full_name || "").trim().toLowerCase()) {
    alert("That name doesn't match. Nothing was deleted.");
    return;
  }

  // Database rows cascade, but the files in storage don't — collect and
  // remove them first, or they linger in the bucket forever.
  const paths = [];
  if (lead.booking_confirmation_path) paths.push(lead.booking_confirmation_path);
  (lead.payments || []).forEach(p => { if (p.receipt_path) paths.push(p.receipt_path); });

  const { data: docs } = await supabaseClient
    .from("client_documents").select("file_path").eq("lead_id", leadId);
  (docs || []).forEach(d => { if (d.file_path) paths.push(d.file_path); });

  if (paths.length) {
    const { error: rmError } = await supabaseClient.storage.from(DOCS_BUCKET).remove(paths);
    // A storage failure shouldn't block the delete, but it should be visible.
    if (rmError) console.warn("Some files could not be removed:", rmError.message);
  }

  const { error } = await supabaseClient.from("leads").delete().eq("id", leadId);
  if (error) {
    alert("Couldn't delete that lead — " + error.message);
    return;
  }

  if (selectedDocClient?.id === leadId) {
    selectedDocClient = null;
    document.getElementById("voucherEmpty").style.display = "block";
    document.getElementById("voucherCard").style.display = "none";
  }

  await loadLeads();
  await loadDocIndex();
  renderAll();
  renderDocResults();
}

// ---------- Urgent Admin Attention ----------
function renderUrgentAlerts() {
  const list = document.getElementById("urgentAlertsList");
  if (!list) return;

  const now = new Date();
  const overdue = allLeadsCache
    .filter(l => l.next_followup && new Date(l.next_followup) < now && leadIsActive(l))
    .sort((a, b) => new Date(a.next_followup) - new Date(b.next_followup));

  if (overdue.length === 0) {
    list.innerHTML = "<li>No urgent alerts.</li>";
    return;
  }

  list.innerHTML = overdue.map(l => `
    <li class="alert-item">
      <div class="name">${l.client_full_name || "Unnamed client"}</div>
      <div class="note">${agentName(l.agent_id).split(" ")[0]}: follow up</div>
      <div class="overdue">Overdue since ${new Date(l.next_followup).toLocaleString()}</div>
    </li>`).join("");
}

// ---------- Leads Tracker ----------
let leadSearch = "";
let leadAgentFilter = "all";
let leadSort = { key: "inquiry", dir: "desc" };
let leadPage = 1;
const LEADS_PER_PAGE = 10;

function filteredLeads() {
  const { from, to } = dateInputs("view-leads");
  const range = rangeFor(currentLeadFilter, from, to);
  let leads = allLeadsCache.filter(l => inRange(leadDate(l), range));

  if (leadAgentFilter !== "all") {
    leads = leads.filter(l => l.agent_id === leadAgentFilter);
  }

  const q = leadSearch.trim().toLowerCase();
  if (q) {
    leads = leads.filter(l =>
      [l.client_full_name, l.client_mobile, l.package_destination, agentName(l.agent_id)]
        .some(v => (v || "").toLowerCase().includes(q))
    );
  }

  const val = l => ({
    inquiry: leadDate(l)?.getTime() || 0,
    name: (l.client_full_name || "").toLowerCase(),
    travel: l.travel_date ? new Date(l.travel_date + "T00:00:00").getTime() : 0,
    pax: Number(l.travelers) || 0,
    contact: (l.client_mobile || "").toLowerCase(),
    agent: agentName(l.agent_id).toLowerCase(),
  })[leadSort.key];

  return leads.sort((a, b) => {
    const x = val(a), y = val(b);
    if (x < y) return leadSort.dir === "asc" ? -1 : 1;
    if (x > y) return leadSort.dir === "asc" ? 1 : -1;
    return 0;
  });
}

function stageColour(stage) {
  if (stage === BOOKED_STAGE) return "var(--gold-600)";
  if (stage === LOST_STAGE) return "var(--ink-soft)";
  return "var(--navy-900)";
}

function fmtDate(value) {
  if (!value) return "—";
  const d = value.length <= 10 ? new Date(value + "T00:00:00") : new Date(value);
  return isNaN(d) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function exportLeadsCsv() {
  const rows = filteredLeads();
  const head = ["Date of inquiry", "Client's name", "Travel date", "No. of persons", "Contact no.", "Agent", "Package", "Stage", "Deal value", "Paid", "Balance"];
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const body = rows.map(l => {
    const paid = leadPaid(l);
    const value = Number(l.deal_value) || 0;
    return [
      fmtDate(l.inquiry_date || l.created_at), l.client_full_name, fmtDate(l.travel_date),
      Number(l.travelers) || 0, l.client_mobile, agentName(l.agent_id),
      l.package_destination, l.journey_stage, value, paid, Math.max(value - paid, 0),
    ].map(esc).join(",");
  });
  const csv = [head.map(esc).join(","), ...body].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `discover-group-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// The search box, consultant filter and Export button aren't in index.html,
// so they're built once here and kept — rebuilding them would drop focus
// mid-keystroke.
function ensureLeadsControls(box) {
  const seesEveryone = currentProfile && currentProfile.role !== "agent";

  if (!document.getElementById("leadsControls")) {
    const titleRow = box.querySelector(".card-title-row");
    if (!titleRow) return;

    const count = titleRow.querySelector("span");
    if (count) count.style.display = "none"; // the footer reports the count now

    const controls = document.createElement("div");
    controls.id = "leadsControls";
    controls.style.cssText = "display:flex; gap:10px; align-items:center; margin-left:auto; flex-wrap:wrap;";
    controls.innerHTML = `
      <select id="leadAgentSelect" style="padding:9px 14px; border:1px solid var(--line); border-radius:999px;
        font-size:13px; font-family:inherit; background:#fff; color:var(--navy-900); display:none;"></select>
      <input id="leadSearchInput" type="search" placeholder="Search leads…"
        style="padding:9px 14px; border:1px solid var(--line); border-radius:999px; font-size:13px; min-width:210px; font-family:inherit;">
      <button id="leadExportBtn" class="pill" type="button">↓ Export</button>`;
    titleRow.appendChild(controls);

    document.getElementById("leadSearchInput").addEventListener("input", (e) => {
      leadSearch = e.target.value;
      leadPage = 1;
      renderLeadsTable();
    });
    document.getElementById("leadExportBtn").addEventListener("click", exportLeadsCsv);
    document.getElementById("leadAgentSelect").addEventListener("change", (e) => {
      leadAgentFilter = e.target.value;
      leadPage = 1;
      renderLeadsTable();
    });
  }

  // Only the people who can see the whole team get a consultant filter —
  // for an agent it would only ever have their own name in it.
  const agentSel = document.getElementById("leadAgentSelect");
  if (!agentSel) return;
  agentSel.style.display = seesEveryone ? "" : "none";
  if (!seesEveryone) return;

  const wanted = ['<option value="all">All consultants</option>']
    .concat(allProfilesCache.map(p => `<option value="${p.id}">${p.full_name}</option>`)).join("");
  if (agentSel.innerHTML !== wanted) {
    agentSel.innerHTML = wanted;
    agentSel.value = leadAgentFilter;
  }
}

function sortHeader(label, key, align) {
  const active = leadSort.key === key;
  const arrow = active ? (leadSort.dir === "asc" ? "↑" : "↓") : "↓";
  return `<th class="lead-sort" data-key="${key}" style="padding:10px 12px; text-align:${align || "left"};
    font-size:11px; letter-spacing:.06em; text-transform:uppercase; cursor:pointer; white-space:nowrap;
    color:${active ? "var(--navy-900)" : "var(--ink-soft)"}; border-bottom:1px solid rgba(0,0,0,.08);"
    >${label} <span style="opacity:${active ? 1 : 0.35};">${arrow}</span></th>`;
}

function renderLeadsTable() {
  const box = document.querySelector("#view-leads .card:last-child");
  if (!box) return;
  const empty = box.querySelector(".registry-empty");
  if (!empty) return;

  ensureLeadsControls(box);

  const seesEveryone = currentProfile && currentProfile.role !== "agent";
  const sub = box.querySelector(".card-title-row p");
  const owner = document.getElementById("leadsOwner");
  if (seesEveryone) {
    const picked = leadAgentFilter !== "all" ? agentName(leadAgentFilter) : null;
    if (owner) owner.textContent = picked ? `${picked}'s Leads` : "Central Leads Tracker";
    if (sub) sub.textContent = picked ? "Filtered to one consultant" : "Every lead, all consultants";
  } else if (sub) {
    sub.textContent = "Personal records only";
  }

  let wrap = document.getElementById("leadsTableWrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "leadsTableWrap";
    wrap.style.marginTop = "8px";
    empty.parentNode.insertBefore(wrap, empty.nextSibling);
  }

  const all = filteredLeads();
  if (all.length === 0) {
    wrap.innerHTML = "";
    empty.style.display = "block";
    // Name whichever filter is actually responsible, so nobody hunts for
    // leads that a stale consultant filter is hiding.
    const bits = [];
    if (leadSearch) bits.push(`matching "${leadSearch}"`);
    if (leadAgentFilter !== "all") bits.push(`for ${agentName(leadAgentFilter)}`);
    empty.textContent = bits.length
      ? `No leads ${bits.join(" ")} in this date range.`
      : "No leads found for this date range.";
    return;
  }
  empty.style.display = "none";

  const pages = Math.max(1, Math.ceil(all.length / LEADS_PER_PAGE));
  if (leadPage > pages) leadPage = pages;
  const start = (leadPage - 1) * LEADS_PER_PAGE;
  const leads = all.slice(start, start + LEADS_PER_PAGE);

  const td = "padding:14px 12px; font-size:13.5px; border-bottom:1px solid rgba(0,0,0,.05); vertical-align:middle; color:var(--ink-soft);";

  wrap.innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; min-width:860px;">
        <thead>
          <tr>
            ${sortHeader("Date of inquiry", "inquiry")}
            ${sortHeader("Client's name", "name")}
            ${sortHeader("Travel date", "travel")}
            ${sortHeader("No. of persons", "pax", "center")}
            ${sortHeader("Contact no.", "contact")}
            ${sortHeader("Agent", "agent")}
            <th style="padding:10px 12px; text-align:left; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-soft); border-bottom:1px solid rgba(0,0,0,.08); white-space:nowrap;">Company profile</th>
          </tr>
        </thead>
        <tbody>
          ${leads.map(l => `
            <tr>
              <td style="${td}">${fmtDate(l.inquiry_date || l.created_at)}</td>
              <td style="${td} font-weight:600; color:var(--navy-900);">${l.client_full_name || "Unnamed client"}</td>
              <td style="${td}">${fmtDate(l.travel_date)}</td>
              <td style="${td} text-align:center;">${Number(l.travelers) || 0}</td>
              <td style="${td}">${l.client_mobile || "—"}</td>
              <td style="${td}">${agentName(l.agent_id)}</td>
              <td style="${td}">
                <div style="display:flex; gap:6px;">
                  <button class="lead-open" data-lead="${l.id}" type="button"
                    style="padding:8px 14px; border:1px solid var(--line); border-radius:8px; background:#fff;
                    font-size:12.5px; font-weight:700; color:var(--navy-900); cursor:pointer; font-family:inherit; white-space:nowrap;">
                    Complete Profile</button>
                  ${seesEveryone ? `
                    <button class="lead-delete" data-lead="${l.id}" type="button" title="Delete this lead"
                      style="padding:8px 11px; border:1px solid var(--line); border-radius:8px; background:#fff;
                      font-size:12.5px; font-weight:700; color:#b42318; cursor:pointer; font-family:inherit;">Delete</button>` : ""}
                </div>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>

    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:18px; padding-top:16px; border-top:1px solid var(--line);">
      <div style="font-size:13px; color:var(--ink-faint);">
        Showing ${start + 1} to ${start + leads.length} of ${all.length} record${all.length === 1 ? "" : "s"}
      </div>
      <div style="display:flex; gap:6px; align-items:center;" id="leadPager">
        <button class="lead-page" data-page="${leadPage - 1}" ${leadPage === 1 ? "disabled" : ""} type="button"
          style="width:32px; height:32px; border:1px solid var(--line); border-radius:8px; background:#fff; cursor:${leadPage === 1 ? "not-allowed" : "pointer"}; opacity:${leadPage === 1 ? 0.4 : 1};">‹</button>
        ${Array.from({ length: pages }, (_, i) => i + 1).map(n => `
          <button class="lead-page" data-page="${n}" type="button"
            style="min-width:32px; height:32px; border:1px solid ${n === leadPage ? "var(--navy-900)" : "var(--line)"};
            border-radius:8px; background:${n === leadPage ? "var(--navy-900)" : "#fff"};
            color:${n === leadPage ? "#fff" : "var(--ink-soft)"}; font-weight:600; font-size:13px; cursor:pointer; font-family:inherit;">${n}</button>`).join("")}
        <button class="lead-page" data-page="${leadPage + 1}" ${leadPage === pages ? "disabled" : ""} type="button"
          style="width:32px; height:32px; border:1px solid var(--line); border-radius:8px; background:#fff; cursor:${leadPage === pages ? "not-allowed" : "pointer"}; opacity:${leadPage === pages ? 0.4 : 1};">›</button>
      </div>
    </div>

    <div style="margin-top:18px; padding:14px 16px; background:#f4f6fa; border-radius:10px; border:1px solid var(--line);">
      <div style="font-size:13px; font-weight:700; color:var(--navy-900); margin-bottom:2px;">ⓘ Quick Guide</div>
      <div style="font-size:12.5px; color:var(--ink-soft);">Click "Complete Profile" to view the full client profile, documents, and payment history.</div>
    </div>`;

  wrap.querySelectorAll(".lead-sort").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      leadSort = { key, dir: leadSort.key === key && leadSort.dir === "desc" ? "asc" : "desc" };
      renderLeadsTable();
    });
  });

  wrap.querySelectorAll(".lead-page").forEach(btn => {
    btn.addEventListener("click", () => {
      const n = Number(btn.dataset.page);
      if (n >= 1 && n <= pages) { leadPage = n; renderLeadsTable(); }
    });
  });

  wrap.querySelectorAll(".lead-open").forEach(btn => {
    btn.addEventListener("click", () => {
      const sel = document.getElementById("voucherClientSelect");
      if (!sel) return;
      sel.value = btn.dataset.lead;
      sel.dispatchEvent(new Event("change"));
      goToView("voucher");
    });
  });

  wrap.querySelectorAll(".lead-delete").forEach(btn => {
    btn.addEventListener("click", () => deleteLead(btn.dataset.lead));
  });
}

// ---------- Client's Documents ----------
// ---------- Client's Documents: search & retrieval ----------
let docIndex = [];        // lead_id of every document this user can see
let docFilters = { name: "", pkg: "", rateMin: "", rateMax: "", travelMonth: "", travelWeek: "", payMonth: "", payWeek: "" };

async function loadDocIndex() {
  const { data, error } = await supabaseClient.from("client_documents").select("lead_id");
  docIndex = (!error && data) ? data.map(d => d.lead_id) : [];
}

function docCount(leadId) {
  return docIndex.filter(id => id === leadId).length;
}

// Weeks run 1–7, 8–14, 15–21, 22–end. Week 4 absorbs the 29th onward so
// nothing falls into a phantom "week 5".
function weekOfMonth(day) {
  return Math.min(4, Math.ceil(day / 7));
}

function matchesMonthWeek(dateStr, month, week) {
  if (!month && !week) return true;
  if (!dateStr) return false;
  const d = dateStr.length <= 10 ? new Date(dateStr + "T00:00:00") : new Date(dateStr);
  if (isNaN(d)) return false;
  if (month) {
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (ym !== month) return false;
  }
  if (week && weekOfMonth(d.getDate()) !== Number(week)) return false;
  return true;
}

function docSearchResults() {
  const f = docFilters;
  const q = f.name.trim().toLowerCase();

  return allLeadsCache.filter(l => {
    if (!l.client_full_name) return false;
    if (q && !l.client_full_name.toLowerCase().includes(q)) return false;
    if (f.pkg && (l.package_destination || "") !== f.pkg) return false;

    const rate = Number(l.deal_value) || 0;
    if (f.rateMin !== "" && rate < Number(f.rateMin)) return false;
    if (f.rateMax !== "" && rate > Number(f.rateMax)) return false;

    if ((f.travelMonth || f.travelWeek) && !matchesMonthWeek(l.travel_date, f.travelMonth, f.travelWeek)) return false;

    if (f.payMonth || f.payWeek) {
      const hit = (l.payments || []).some(p => matchesMonthWeek(p.date, f.payMonth, f.payWeek));
      if (!hit) return false;
    }
    return true;
  }).sort((a, b) => (a.client_full_name || "").localeCompare(b.client_full_name || ""));
}

function ensureDocSearch() {
  if (document.getElementById("docSearchPanel")) return;
  const sel = document.getElementById("voucherClientSelect");
  if (!sel) return;
  const card = sel.closest(".card");
  if (!card) return;

  // The dropdown still drives which client is open — other screens set it and
  // fire a change event — so it stays, just out of the way.
  const field = sel.closest(".form-field");
  if (field) field.style.display = "none";

  const panel = document.createElement("div");
  panel.id = "docSearchPanel";
  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
      <div>
        <h2 style="margin:0 0 2px; font-size:16px; color:var(--navy-900);">Find a client</h2>
        <p style="margin:0; font-size:12.5px; color:var(--ink-soft);">Search by name, package, rate, travel week, or payment week</p>
      </div>
      <button type="button" id="docClearBtn" class="pill">Clear filters</button>
    </div>

    <div class="form-grid" style="gap:12px;">
      <div class="form-field"><label>Client name</label><input type="search" id="docFName" placeholder="Type a name…"></div>
      <div class="form-field"><label>Package name</label><select id="docFPkg"></select></div>
      <div class="form-field">
        <label>Package rate</label>
        <div style="display:flex; gap:8px;">
          <input type="number" id="docFRateMin" placeholder="Min" style="flex:1;">
          <input type="number" id="docFRateMax" placeholder="Max" style="flex:1;">
        </div>
      </div>
    </div>

    <div class="form-grid" style="gap:12px; margin-top:14px;">
      <div class="form-field">
        <label>Travel month</label>
        <div style="display:flex; gap:8px;">
          <input type="month" id="docFTravelMonth" style="flex:1.4;">
          <select id="docFTravelWeek" style="flex:1;">
            <option value="">Any week</option><option value="1">Week 1</option><option value="2">Week 2</option>
            <option value="3">Week 3</option><option value="4">Week 4</option>
          </select>
        </div>
      </div>
      <div class="form-field">
        <label>Payment month</label>
        <div style="display:flex; gap:8px;">
          <input type="month" id="docFPayMonth" style="flex:1.4;">
          <select id="docFPayWeek" style="flex:1;">
            <option value="">Any week</option><option value="1">Week 1</option><option value="2">Week 2</option>
            <option value="3">Week 3</option><option value="4">Week 4</option>
          </select>
        </div>
      </div>
    </div>

    <div id="docResults" style="margin-top:16px;"></div>`;
  card.appendChild(panel);

  const bind = (id, key) => document.getElementById(id)?.addEventListener("input", (e) => {
    docFilters[key] = e.target.value;
    renderDocResults();
  });
  bind("docFName", "name");
  bind("docFRateMin", "rateMin");
  bind("docFRateMax", "rateMax");
  ["docFPkg:pkg", "docFTravelMonth:travelMonth", "docFTravelWeek:travelWeek", "docFPayMonth:payMonth", "docFPayWeek:payWeek"]
    .forEach(pair => {
      const [id, key] = pair.split(":");
      document.getElementById(id)?.addEventListener("change", (e) => {
        docFilters[key] = e.target.value;
        renderDocResults();
      });
    });

  document.getElementById("docClearBtn").addEventListener("click", () => {
    docFilters = { name: "", pkg: "", rateMin: "", rateMax: "", travelMonth: "", travelWeek: "", payMonth: "", payWeek: "" };
    ["docFName", "docFRateMin", "docFRateMax", "docFTravelMonth", "docFPayMonth"].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = "";
    });
    ["docFPkg", "docFTravelWeek", "docFPayWeek"].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = "";
    });
    renderDocResults();
  });
}

function renderDocResults() {
  const box = document.getElementById("docResults");
  if (!box) return;

  // Package list comes from the real bookings, so it never offers a dead option.
  const pkgSel = document.getElementById("docFPkg");
  if (pkgSel) {
    const pkgs = [...new Set(allLeadsCache.map(l => (l.package_destination || "").trim()).filter(Boolean))].sort();
    const wanted = '<option value="">All packages</option>' + pkgs.map(p => `<option value="${p}">${p}</option>`).join("");
    if (pkgSel.innerHTML !== wanted) { pkgSel.innerHTML = wanted; pkgSel.value = docFilters.pkg; }
  }

  const results = docSearchResults();
  const active = Object.values(docFilters).some(v => v !== "");

  if (results.length === 0) {
    box.innerHTML = `<div class="registry-empty">${active ? "No clients match these filters." : "No client profiles saved yet."}</div>`;
    return;
  }

  box.innerHTML = `
    <div style="font-size:12px; color:var(--ink-faint); margin-bottom:8px;">
      ${results.length} client${results.length === 1 ? "" : "s"}${active ? " match these filters" : ""}
    </div>
    ${results.map(l => {
      const n = docCount(l.id);
      const paid = leadPaid(l);
      return `
        <div class="rank-row" style="align-items:center;">
          <div class="rank-badge" style="background:${n ? "var(--gold-600)" : "#c3cad6"}; color:#fff; font-size:11px;">${n}</div>
          <div style="flex:1; min-width:0;">
            <div class="rank-name">${l.client_full_name}</div>
            <div class="rank-sub">${l.package_destination || "No package"} · ${currency(l.deal_value)}${
              l.travel_date ? " · travels " + fmtDate(l.travel_date) : ""}${
              paid ? " · paid " + currency(paid) : ""}</div>
          </div>
          <button class="doc-open" data-lead="${l.id}" type="button"
            style="padding:8px 14px; border:1px solid var(--line); border-radius:8px; background:#fff;
            font-size:12.5px; font-weight:700; color:var(--navy-900); cursor:pointer; font-family:inherit; white-space:nowrap;">
            ${n ? `Open ${n} document${n === 1 ? "" : "s"}` : "Open"}</button>
        </div>`;
    }).join("")}`;

  box.querySelectorAll(".doc-open").forEach(btn => {
    btn.addEventListener("click", () => {
      const sel = document.getElementById("voucherClientSelect");
      if (!sel) return;
      sel.value = btn.dataset.lead;
      sel.dispatchEvent(new Event("change"));
    });
  });
}

function populateVoucherSelect(leads) {
  const sel = document.getElementById("voucherClientSelect");
  if (!sel) return;
  const withNames = leads.filter(l => l.client_full_name);
  sel.innerHTML = '<option value="">Choose a saved client profile…</option>' +
    withNames.map(l => `<option value="${l.id}">${l.client_full_name} — ${l.package_destination || "No package set"}</option>`).join("");
  ensureDocSearch();
  renderDocResults();
}

let selectedDocClient = null;

document.getElementById("voucherClientSelect")?.addEventListener("change", (e) => {
  const lead = allLeadsCache.find(l => l.id === e.target.value);
  const empty = document.getElementById("voucherEmpty");
  const card = document.getElementById("voucherCard");
  if (!lead) { selectedDocClient = null; empty.style.display = "block"; card.style.display = "none"; return; }
  selectedDocClient = lead;
  empty.style.display = "none";
  card.style.display = "block";
  renderVoucher(lead);
  loadClientDocuments(lead.id);
});

document.getElementById("doc_upload_btn")?.addEventListener("click", async (e) => {
  const btn = e.target;
  if (!currentProfile || !selectedDocClient) return;
  const fileEl = document.getElementById("doc_file");
  const file = fileEl?.files?.[0];
  if (!file) { btn.textContent = "Choose a file first"; setTimeout(() => (btn.textContent = "Upload Document"), 1500); return; }

  btn.textContent = "Uploading…";
  const path = await uploadDocument(file);
  if (!path) { btn.textContent = "Upload failed — try again"; setTimeout(() => (btn.textContent = "Upload Document"), 2000); return; }

  const { error } = await supabaseClient.from("client_documents").insert({
    lead_id: selectedDocClient.id,
    agent_id: currentProfile.id,
    doc_type: document.getElementById("doc_type").value,
    direction: document.getElementById("doc_direction").value,
    notes: document.getElementById("doc_notes").value || null,
    file_name: file.name,
    file_path: path,
  });

  btn.textContent = error ? "Error saving record" : "Uploaded ✓";
  if (!error) {
    fileEl.value = "";
    document.getElementById("doc_notes").value = "";
    await loadClientDocuments(selectedDocClient.id);
    await loadDocIndex();   // keep the search result counts honest
    renderDocResults();
  }
  setTimeout(() => (btn.textContent = "Upload Document"), 1800);
});

async function loadClientDocuments(leadId) {
  const list = document.getElementById("docLibraryList");
  if (!list) return;
  const { data: docs, error } = await supabaseClient
    .from("client_documents")
    .select("*")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false });

  if (error || !docs || docs.length === 0) {
    list.innerHTML = '<div class="registry-empty">No documents uploaded yet for this client.</div>';
    return;
  }

  list.innerHTML = docs.map(d => `
    <div class="rank-row">
      <div class="rank-badge" style="background:${d.direction === "Submitted by client" ? "var(--gold-600)" : "var(--navy-900)"}; color:#fff; font-size:10px;">${d.direction === "Submitted by client" ? "IN" : "OUT"}</div>
      <div>
        <div class="rank-name">${d.doc_type}</div>
        <div class="rank-sub">${d.file_name}${d.notes ? " · " + d.notes : ""}</div>
      </div>
      <div class="rank-metrics">
        <div><div class="m-label">${d.direction}</div><div class="m-value"><a href="#" onclick="viewDocument('${d.file_path}'); return false;">View</a></div></div>
      </div>
    </div>`).join("");
}

function renderVoucher(l) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || "—"; };
  const ref = l.booking_reference || l.id.slice(0, 8).toUpperCase();

  set("v_destination", l.package_destination || "Travel Package");
  set("v_refline", "Ref: " + ref + (l.travel_date ? " · Travel date " + l.travel_date : ""));
  set("v_package", l.package_destination);
  set("v_traveldate", l.travel_date);
  set("v_travelers", l.travelers);
  set("v_stage", l.journey_stage);
  set("v_visa", l.visa_status);
  set("v_bookingref", ref);
  set("v_client", l.client_full_name);
  set("v_email", l.client_email);
  set("v_mobile", l.client_mobile);
  set("v_emergency", l.emergency_contact_name ? `${l.emergency_contact_name} (${l.emergency_contact_phone || "no number"})` : null);
  set("v_address", l.client_address);
  set("v_tours", l.optional_tours);
  set("v_services", l.optional_services);
  set("v_freebies", [l.applied_discounts, l.special_freebies].filter(Boolean).join(" · "));
  set("v_requests", l.special_requests);

  const paid = leadPaid(l);
  const total = Number(l.deal_value) || 0;
  set("v_totalvalue", currency(total));
  set("v_paid", currency(paid));
  set("v_balance", currency(Math.max(total - paid, 0)));

  const qrData = encodeURIComponent(`Discover Group Voucher | ${ref} | ${l.client_full_name || ""}`);
  document.getElementById("v_qr").src = `https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${qrData}`;

  const docLinks = [];
  if (l.booking_confirmation_path) docLinks.push(`<a href="#" onclick="viewDocument('${l.booking_confirmation_path}'); return false;">Booking confirmation</a>`);
  (l.payments || []).forEach((p, i) => { if (p.receipt_path) docLinks.push(`<a href="#" onclick="viewDocument('${p.receipt_path}'); return false;">Receipt ${i + 1}</a>`); });
  const docsEl = document.getElementById("v_documents");
  if (docsEl) docsEl.innerHTML = docLinks.length ? docLinks.join(" · ") : "No files attached";
}

// ---------- Client Profile: payment installment rows ----------
let paymentRowCount = 0;
const MAX_PAYMENT_ROWS = 15;

function addPaymentRow() {
  if (paymentRowCount >= MAX_PAYMENT_ROWS) return;
  paymentRowCount++;
  const i = paymentRowCount;
  const wrap = document.getElementById("paymentRows");
  if (!wrap) return;
  const row = document.createElement("div");
  row.className = "rank-row";
  row.style.alignItems = "flex-end";
  row.innerHTML = `
    <div class="rank-badge">${String(i).padStart(2, "0")}</div>
    <div class="form-field" style="flex:1;"><label>Payment date</label><input type="date" class="pay-date" data-idx="${i}"></div>
    <div class="form-field" style="flex:1;"><label>Amount</label><input type="number" class="pay-amount" data-idx="${i}" value="0"></div>
    <div class="form-field" style="flex:1;">
      <label>Payment method</label>
      <select class="pay-method" data-idx="${i}">
        <option value="">Select</option><option>Bank transfer</option><option>Credit card</option><option>Cash</option><option>GCash</option>
      </select>
    </div>
    <div class="form-field" style="flex:1;"><label>Receipt / deposit slip</label><input type="file" class="pay-receipt" data-idx="${i}"></div>`;
  wrap.appendChild(row);

  const btn = document.getElementById("addPaymentBtn");
  if (btn) btn.style.display = paymentRowCount >= MAX_PAYMENT_ROWS ? "none" : "inline-block";
}

function renderPaymentRows() {
  const wrap = document.getElementById("paymentRows");
  if (!wrap) return;
  wrap.innerHTML = "";
  paymentRowCount = 0;
  addPaymentRow(); // start with just one row visible
}

document.getElementById("addPaymentBtn")?.addEventListener("click", addPaymentRow);
renderPaymentRows();

const DOCS_BUCKET = "client-documents";

async function uploadDocument(file) {
  if (!file || !currentProfile) return null;
  const path = `${currentProfile.id}/${Date.now()}-${file.name}`;
  const { error } = await supabaseClient.storage.from(DOCS_BUCKET).upload(path, file);
  if (error) { console.error("Upload failed:", error.message); return null; }
  return path;
}

window.viewDocument = async function (path) {
  if (!path) return;
  const { data, error } = await supabaseClient.storage.from(DOCS_BUCKET).createSignedUrl(path, 300);
  if (error || !data?.signedUrl) { alert("Couldn't open that file."); return; }
  window.open(data.signedUrl, "_blank");
};

async function collectPayments() {
  const payments = [];
  const rows = [...document.querySelectorAll(".pay-date")];
  for (const dateEl of rows) {
    const idx = dateEl.dataset.idx;
    const amountEl = document.querySelector(`.pay-amount[data-idx="${idx}"]`);
    const methodEl = document.querySelector(`.pay-method[data-idx="${idx}"]`);
    const receiptEl = document.querySelector(`.pay-receipt[data-idx="${idx}"]`);
    if (dateEl.value || Number(amountEl.value) > 0) {
      const receiptFile = receiptEl?.files?.[0];
      const receipt_path = receiptFile ? await uploadDocument(receiptFile) : null;
      payments.push({ date: dateEl.value || null, amount: Number(amountEl.value) || 0, method: methodEl.value || null, receipt_path });
    }
  }
  return payments;
}

async function buildClientProfilePayload() {
  const v = id => document.getElementById(id)?.value || null;
  const bookingFile = document.getElementById("cp_booking_file")?.files?.[0];
  const booking_confirmation_path = bookingFile ? await uploadDocument(bookingFile) : null;
  const payments = await collectPayments();

  // The lead belongs to the consultant it's assigned to — not to whoever
  // typed it in. That's what puts it in the right person's tracker, and
  // what the database rules use to decide who may see it. Agents can only
  // assign to themselves; admins and sales admins can assign to anyone.
  const assigned = v("cp_consultant");
  const canAssignOthers = currentProfile.role !== "agent";
  const owner = (canAssignOthers && assigned) ? assigned : currentProfile.id;

  return {
    agent_id: owner,
    created_by: currentProfile.id,
    assigned_consultant: owner,
    client_full_name: v("cp_fullname"),
    client_email: v("cp_email"),
    client_mobile: v("cp_mobile"),
    inquiry_date: v("cp_inquiry_date"),
    inquiry_time: v("cp_inquiry_time"),
    emergency_contact_name: v("cp_emergency_name"),
    emergency_contact_phone: v("cp_emergency_phone"),
    client_address: v("cp_address"),
    package_destination: v("cp_destination"),
    travel_date: v("cp_travel_date"),
    travelers: Number(v("cp_travelers")) || 1,
    visa_status: v("cp_visa_status"),
    lead_source: v("cp_lead_source"),
    deal_value: Number(v("cp_deal_value")) || 0,
    journey_stage: v("cp_stage"),
    lead_temperature: v("cp_temperature"),
    decision_status: v("cp_decision"),
    next_followup: v("cp_followup"),
    concern: v("cp_concern"),
    closing_strategy: v("cp_strategy"),
    remarks: v("cp_remarks"),
    booking_reference: v("cp_booking_ref"),
    booking_confirmation_path,
    payments,
    visa_service_availed: v("cp_visa_availed"),
    visa_service_fee: Number(v("cp_visa_fee")) || 0,
    visa_service_discount: Number(v("cp_visa_discount")) || 0,
    applied_discounts: v("cp_discounts"),
    special_freebies: v("cp_freebies"),
    special_requests: v("cp_requests"),
    preferred_airline: v("cp_airline"),
    seat_preference: v("cp_seat"),
    meal_preference: v("cp_meal"),
    room_preference: v("cp_room"),
    traveler_preferences: v("cp_preferences"),
    optional_tours: v("cp_tours"),
    optional_services: v("cp_services"),
  };
}

async function saveClientProfile(btn, label, syncToHubspot) {
  if (!currentProfile) return;
  // A second click while the first save is still running is what creates
  // duplicate clients, so the button is dead until this finishes.
  if (btn.disabled) return;
  btn.disabled = true;
  btn.style.opacity = "0.6";
  btn.style.cursor = "not-allowed";

  const release = () => {
    btn.disabled = false;
    btn.style.opacity = "";
    btn.style.cursor = "";
    btn.textContent = label;
  };

  btn.textContent = "Uploading files…";
  const payload = await buildClientProfilePayload();
  btn.textContent = "Saving…";
  const { error } = await supabaseClient.from("leads").insert(payload);

  if (error) {
    btn.textContent = "Error — try again";
    setTimeout(release, 1800);
    return;
  }

  await loadLeads();
  renderAll();

  if (!syncToHubspot) {
    btn.textContent = "Saved ✓";
    setTimeout(release, 1500);
    return;
  }

  btn.textContent = "Syncing to HubSpot…";
  const { data: syncResult, error: syncError } = await supabaseClient.functions.invoke("hubspot-sync", {
    body: payload,
  });
  btn.textContent = syncError || syncResult?.error ? "Saved, but HubSpot sync failed" : "Saved & synced ✓";
  setTimeout(release, 2200);
}

document.getElementById("cp_save_draft")?.addEventListener("click", (e) => saveClientProfile(e.target, "Save draft", false));
document.getElementById("cp_save_sync")?.addEventListener("click", (e) => saveClientProfile(e.target, "Save Client Profile & Sync to HubSpot", true));

// The Team Dashboard pills in index.html have no "All" option, so there's no
// way to see the full history. Add one rather than edit index.html.
(function addTeamAllPill() {
  const group = document.getElementById("teamPeriodPills");
  if (!group || group.querySelector('[data-range="all"]')) return;
  const custom = group.querySelector('[data-range="custom"]');
  const pill = document.createElement("button");
  pill.className = "pill";
  pill.dataset.range = "all";
  pill.textContent = "All";
  group.insertBefore(pill, custom);
})();

// ---------- Filter pills ----------
// Each pill carries data-range in index.html; that is what drives filtering.
document.querySelectorAll("#teamPeriodPills .pill").forEach(p => {
  p.addEventListener("click", () => {
    document.querySelectorAll("#teamPeriodPills .pill").forEach(x => x.classList.remove("active"));
    p.classList.add("active");
    currentPeriod = p.dataset.range || "all";
    renderTeamStats();
    renderAgentPerformance();
    renderTeamFunnel();
  });
});

document.querySelectorAll("#leadPills .pill").forEach(p => {
  p.addEventListener("click", () => {
    document.querySelectorAll("#leadPills .pill").forEach(x => x.classList.remove("active"));
    p.classList.add("active");
    currentLeadFilter = p.dataset.range || "all";
    leadPage = 1;
    renderLeadsTable();
  });
});

// Typing in a From/To box switches that panel to Custom automatically.
document.querySelectorAll("#view-team .date-range input[type='date']").forEach(el => {
  el.addEventListener("change", () => {
    document.querySelectorAll("#teamPeriodPills .pill").forEach(x =>
      x.classList.toggle("active", x.dataset.range === "custom"));
    currentPeriod = "custom";
    renderTeamStats();
    renderAgentPerformance();
    renderTeamFunnel();
  });
});

document.querySelectorAll("#view-leads .date-range input[type='date']").forEach(el => {
  el.addEventListener("change", () => {
    document.querySelectorAll("#leadPills .pill").forEach(x =>
      x.classList.toggle("active", x.dataset.range === "custom"));
    currentLeadFilter = "custom";
    renderLeadsTable();
  });
});

document.getElementById("rankDate")?.addEventListener("change", renderRanking);

document.querySelectorAll("#compliancePills .pill").forEach(p => {
  p.addEventListener("click", () => {
    document.querySelectorAll("#compliancePills .pill").forEach(x => x.classList.remove("active"));
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

document.getElementById("sc_submit")?.addEventListener("click", async (e) => {
  const btn = e.target;
  if (!currentProfile) return;
  const agentId = document.getElementById("consultantSelect").value;
  const evaluator = document.querySelector('#view-scorecard input[type="text"]').value;
  const evalDate = document.querySelector('#view-scorecard input[type="date"]').value;
  const scores = {};
  CRITERIA.forEach((c, idx) => { scores[c.title] = ratings[idx] || 0; });
  const total = Number(document.getElementById("totalScore").textContent);
  const v = id => document.getElementById(id)?.value || null;

  btn.textContent = "Saving…";
  const { error } = await supabaseClient.from("scorecards").insert({
    agent_id: agentId,
    evaluator_name: evaluator,
    evaluation_date: evalDate || new Date().toISOString().slice(0, 10),
    scores,
    total_score: total,
    new_leads: Number(v("sc_newleads")) || 0,
    followups_completed: Number(v("sc_followups")) || 0,
    pax_closed: Number(v("sc_paxclosed")) || 0,
    net_sales_collection: Number(v("sc_netsales")) || 0,
    biggest_win: v("sc_win"),
    biggest_challenge: v("sc_challenge"),
    recovery_plan: v("sc_plan"),
    coaching_focus: v("sc_coaching_focus"),
    coaching_status: v("sc_coaching_status"),
    coaching_remarks: v("sc_coaching_remarks"),
    agent_commitment: v("sc_agent_commitment"),
  });
  btn.textContent = error ? "Error — try again" : "Submitted ✓";
  if (!error) {
    await loadScorecards();
    renderAgentPerformance();
    setTimeout(() => (btn.textContent = "Submit Daily Scorecard"), 1500);
  }
});

// ---------- Approvals ----------
document.querySelectorAll("#approvalTypePills .pill").forEach(p => {
  p.addEventListener("click", () => {
    document.querySelectorAll("#approvalTypePills .pill").forEach(x => x.classList.remove("active"));
    p.classList.add("active");
    const isLeave = p.dataset.type === "leave";
    document.getElementById("leaveRequestForm").style.display = isLeave ? "block" : "none";
    document.getElementById("clientRequestForm").style.display = isLeave ? "none" : "block";
  });
});

document.getElementById("lv_submit")?.addEventListener("click", async (e) => {
  const btn = e.target;
  if (!currentProfile) return;
  const v = id => document.getElementById(id)?.value || null;
  btn.textContent = "Submitting…";
  const { error } = await supabaseClient.from("leave_requests").insert({
    agent_id: currentProfile.id,
    leave_type: v("lv_type"),
    start_date: v("lv_start"),
    end_date: v("lv_end"),
    reason: v("lv_reason"),
  });
  btn.textContent = error ? "Error — try again" : "Submitted ✓";
  if (!error) {
    ["lv_start", "lv_end", "lv_reason"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
    await loadApprovals();
  }
  setTimeout(() => (btn.textContent = "Submit Leave Request"), 1800);
});

document.getElementById("cr_submit")?.addEventListener("click", async (e) => {
  const btn = e.target;
  if (!currentProfile) return;
  const v = id => document.getElementById(id)?.value || null;
  btn.textContent = "Submitting…";
  const { error } = await supabaseClient.from("client_approval_requests").insert({
    agent_id: currentProfile.id,
    client_full_name: v("cr_client"),
    package_name: v("cr_package"),
    number_of_persons: Number(v("cr_persons")) || 1,
    original_travel_date: v("cr_orig_date"),
    new_travel_date: v("cr_new_date"),
    original_date_slots: v("cr_orig_slots"),
    new_date_slots: v("cr_new_slots"),
    context: v("cr_context"),
  });
  btn.textContent = error ? "Error — try again" : "Submitted ✓";
  if (!error) {
    ["cr_client", "cr_package", "cr_context"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
    await loadApprovals();
  }
  setTimeout(() => (btn.textContent = "Submit for Approval"), 1800);
});

async function loadApprovals() {
  const list = document.getElementById("approvalsList");
  if (!list || !currentProfile) return;

  // Admins get everyone's requests to decide on; everyone else gets their own.
  const isAdmin = currentProfile.role === "admin";
  const leaveQ = supabaseClient.from("leave_requests").select("*").order("created_at", { ascending: false });
  const clientQ = supabaseClient.from("client_approval_requests").select("*").order("created_at", { ascending: false });
  const pwQ = supabaseClient.from("password_change_requests").select("*").order("created_at", { ascending: false });
  if (!isAdmin) {
    leaveQ.eq("agent_id", currentProfile.id);
    clientQ.eq("agent_id", currentProfile.id);
    pwQ.eq("agent_id", currentProfile.id);
  }
  const [leaves, clientReqs, pwReqs] = await Promise.all([leaveQ, clientQ, pwQ]);

  const items = [
    ...(leaves.data || []).map(r => ({
      table: "leave_requests", id: r.id, kind: "Leave", agent: r.agent_id,
      title: r.leave_type, sub: `${r.start_date || "?"} → ${r.end_date || "?"}${r.reason ? " · " + r.reason : ""}`,
      status: r.status || "Pending", created: r.created_at, decidedBy: r.decided_by, decidedAt: r.decided_at,
    })),
    ...(clientReqs.data || []).map(r => ({
      table: "client_approval_requests", id: r.id, kind: "Client Request", agent: r.agent_id,
      title: r.client_full_name || "Unnamed client",
      sub: `${r.package_name || "—"} · ${r.number_of_persons || 1} pax · ${r.original_travel_date || "?"} → ${r.new_travel_date || "?"}${r.context ? " · " + r.context : ""}`,
      status: r.status || "Pending", created: r.created_at, decidedBy: r.decided_by, decidedAt: r.decided_at,
    })),
    ...(pwReqs.data || []).filter(r => r.status !== "Used").map(r => ({
      table: "password_change_requests", id: r.id, kind: "Password", agent: r.agent_id,
      title: "Password change", sub: r.reason || "No reason given",
      status: r.status || "Pending", created: r.created_at, decidedBy: r.decided_by, decidedAt: r.decided_at,
    })),
  ].sort((a, b) => new Date(b.created) - new Date(a.created));

  // Update the card heading so an admin knows this is a queue, not a log.
  const head = list.closest(".card")?.querySelector(".card-title-row");
  if (head) {
    const h2 = head.querySelector("h2");
    const p = head.querySelector("p");
    const pending = items.filter(i => (i.status || "Pending") === "Pending").length;
    if (h2) h2.textContent = isAdmin ? "Approval Queue" : "My Approval Requests";
    if (p) p.textContent = isAdmin
      ? `${pending} pending decision${pending === 1 ? "" : "s"} across the team`
      : "Status of everything you've submitted";
  }

  if (items.length === 0) {
    list.innerHTML = `<div class="registry-empty">${isAdmin ? "No requests from anyone yet." : "No approval requests submitted yet."}</div>`;
    return;
  }

  const chip = status => {
    const c = status === "Approved" ? "#2e8b57" : status === "Declined" ? "#b42318" : "#c9a227";
    return `<span style="display:inline-block; padding:3px 10px; border-radius:999px; font-size:11px;
      font-weight:700; background:${c}1a; color:${c};">${status}</span>`;
  };

  list.innerHTML = items.map(it => {
    const pending = (it.status || "Pending") === "Pending";
    const decided = it.decidedAt
      ? `<div style="font-size:11px; color:var(--ink-faint); margin-top:4px;">by ${agentName(it.decidedBy)} · ${fmtDate(it.decidedAt)}</div>`
      : "";
    return `
      <div class="rank-row" style="align-items:center;">
        <div class="rank-badge" style="background:${it.kind === "Leave" ? "var(--navy-900)" : it.kind === "Password" ? "#6b5bc4" : "var(--gold-600)"}; color:#fff;">${it.kind === "Leave" ? "L" : it.kind === "Password" ? "P" : "C"}</div>
        <div style="flex:1; min-width:0;">
          <div class="rank-name">${it.title}</div>
          <div class="rank-sub">${isAdmin ? agentName(it.agent) + " · " : ""}${it.kind} · ${it.sub}</div>
        </div>
        <div style="text-align:right;">
          ${chip(it.status)}
          ${decided}
        </div>
        ${isAdmin && pending ? `
          <div style="display:flex; gap:6px; margin-left:14px;">
            <button class="decide-btn" data-table="${it.table}" data-id="${it.id}" data-decision="Approved" type="button"
              style="padding:7px 13px; border:none; border-radius:7px; background:#2e8b57; color:#fff;
              font-size:12px; font-weight:700; cursor:pointer; font-family:inherit;">Approve</button>
            <button class="decide-btn" data-table="${it.table}" data-id="${it.id}" data-decision="Declined" type="button"
              style="padding:7px 13px; border:1px solid #b42318; border-radius:7px; background:#fff; color:#b42318;
              font-size:12px; font-weight:700; cursor:pointer; font-family:inherit;">Decline</button>
          </div>` : ""}
      </div>`;
  }).join("");

  list.querySelectorAll(".decide-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const decision = btn.dataset.decision;
      // Declining someone's leave without a reason is a bad look; ask for one.
      const note = decision === "Declined"
        ? prompt("Reason for declining (the agent will see this):")
        : null;
      if (decision === "Declined" && note === null) return; // cancelled

      const row = btn.closest(".rank-row");
      row.querySelectorAll(".decide-btn").forEach(b => { b.disabled = true; b.style.opacity = "0.5"; });
      btn.textContent = "Saving…";

      const { error } = await supabaseClient.from(btn.dataset.table).update({
        status: decision,
        decided_by: currentProfile.id,
        decided_at: new Date().toISOString(),
        decision_note: note || null,
      }).eq("id", btn.dataset.id);

      if (error) {
        btn.textContent = "Failed — retry";
        row.querySelectorAll(".decide-btn").forEach(b => { b.disabled = false; b.style.opacity = ""; });
        return;
      }
      await loadApprovals();
      await loadMyPwRequest();
      renderPasswordPanel();
    });
  });
}

(function setDates() {
  const opts = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
  const label = new Date().toLocaleDateString("en-US", opts);
  document.querySelectorAll(".date-pill").forEach(el => el.textContent = label);
})();
