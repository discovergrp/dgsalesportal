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
  { title: "Personalized Client Engagement", desc: "Responses are natural, tailored, conversational, and never robotic or AI-like.", max: 10 },
  { title: "Warm & Professional Client Experience", desc: "Communication builds trust through warmth, empathy, professionalism, and confidence.", max: 10 },
  { title: "Strategic Follow-through & Follow-up Compliance", desc: "Every active lead is followed up within 24 hours using value-driven closing strategies.", max: 30 },
  { title: "Product Knowledge & Consultative Expertise", desc: "Information on packages, visas, itineraries, flights, and policies is accurate and confident.", max: 10 },
  { title: "CRM / Sales Tracker & Funnel Management", desc: "Every lead has complete records, correct stage, next action, strategy, and remarks.", max: 10 },
  { title: "Sales Initiative & Opportunity Maximization", desc: "Consultant proactively offers alternatives, dates, packages, promotions, and upgrades.", max: 20 },
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

// Slots-sheet clients are historical closed sales, imported for the Slots
// Tracker. Everywhere that shows *current* sales work — the Leads Tracker,
// the Agent Dashboard, the funnel — filters them out with this.
function isSlotsImport(l) {
  return typeof l.lead_source === "string" && l.lead_source.startsWith("Slots sheet import");
}

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
    .select("id, full_name, role, rank, can_delete_leads")
    .eq("id", userId)
    .single();

  if (error || !profile) {
    document.getElementById("loginError").textContent = "Logged in, but no profile found. Contact your admin.";
    document.getElementById("loginError").style.display = "block";
    return;
  }
  currentProfile = profile;
  enterWorkspace(profile.full_name, profile.role);
  await Promise.all([loadProfiles(), loadLeads(), loadScorecards(), loadDocIndex(), loadApprovals(), loadMyPwRequest(), loadDepartures()]);
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
    .select("id, full_name, role, rank, can_delete_leads")
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
  // Supabase caps a single select at 1000 rows. With the slots import the
  // table is well past that, so fetch in pages or the newest imports would
  // push real leads off the end and they'd silently vanish from every view.
  const PAGE = 1000;
  const MAX_PAGES = 50;               // hard safety cap (50k leads) — prevents any infinite loop
  let all = [];
  let pageErrored = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    const { data, error } = await supabaseClient
      .from("leads")
      .select("*")
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      // Do NOT silently keep a partial cache — that was the 974-undercount bug.
      // Surface it, keep whatever we already have, and stop.
      console.error(`loadLeads: page ${page} (rows ${from}-${from + PAGE - 1}) failed:`, error);
      pageErrored = true;
      break;
    }
    all = all.concat(data || []);
    console.log(`loadLeads: page ${page} fetched ${data ? data.length : 0} rows, running total ${all.length}`);
    if (!data || data.length < PAGE) break;   // short page => last page reached
  }
  if (pageErrored && all.length < 1) {
    // total wipe-out on the very first page: keep the old cache rather than blanking every view
    console.warn("loadLeads: first page errored, retaining previous cache");
    return;
  }
  allLeadsCache = all;
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
  ensureSlotsNav();
  renderSlots();
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

// ---------- Agent Performance Overview (three sections by role) ----------
function renderAgentPerformance() {
  const grid = document.getElementById("agentPerfGrid");
  if (!grid) return;

  // Show ALL leads across ALL time here — this overview is about total
  // contribution, so it deliberately ignores the date pills and does NOT
  // exclude imported leads (unlike the funnel views).
  const allLeads = allLeadsCache;
  const byOwner = (id) => allLeads.filter(l => l.agent_id === id);
  const isStale = (l) => l.next_followup && new Date(l.next_followup) < new Date() && leadIsActive(l);
  const bookedValue = (leads) => leads.filter(leadIsBooked).reduce((s, l) => s + (Number(l.deal_value) || 0), 0);
  const leadHasTranscript = (l) => !!((l.transcript_meta || "").trim() || (l.transcript_viber || "").trim() || (l.transcript_phone || "").trim());
  // Per-admin transcription credit: count transcribed leads this person was the
  // last to edit (updated_by). Admins encode the transcript, so they're the last
  // editor — this captures far more than the transcript_entered_by stamp, which
  // only began recording when that feature was enabled.
  const transcriptsBy = (id) => allLeads.filter(l => leadHasTranscript(l) && l.updated_by === id).length;
  const totalTranscribed = allLeads.filter(leadHasTranscript).length;

  const agents = allProfilesCache.filter(p => p.role === "agent");
  const admins = allProfilesCache.filter(p => p.role === "sales_admin");

  const money = (n) => "₱" + (Number(n) || 0).toLocaleString();

  // ---- section + card builders (self-contained inline styles) ----
  const sectionTitle = (title, sub) => `
    <div style="grid-column:1 / -1; margin:26px 0 4px;">
      <h3 style="margin:0; font-size:16px; color:var(--navy-900); letter-spacing:.02em;">${title}</h3>
      <div style="font-size:12.5px; color:var(--ink-faint); margin-top:2px;">${sub}</div>
      <div style="height:2px; background:linear-gradient(90deg,var(--gold-600),transparent); margin-top:8px;"></div>
    </div>`;

  const metric = (val, label, color) => `
    <div style="flex:1; min-width:90px; background:#fff; border:1px solid var(--line); border-radius:10px; padding:9px 12px;">
      <div style="font-size:18px; font-weight:800; color:${color || "var(--navy-900)"};">${val}</div>
      <div style="font-size:10.5px; letter-spacing:.04em; text-transform:uppercase; color:var(--ink-faint); margin-top:1px;">${label}</div>
    </div>`;

  const card = (name, metricsHtml, accent) => `
    <div style="grid-column:1 / -1; background:#f9fafc; border:1px solid var(--line); border-left:4px solid ${accent}; border-radius:12px; padding:16px 18px; margin-bottom:10px;">
      <div style="font-size:15px; font-weight:700; color:var(--navy-900); margin-bottom:10px;">${name}</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">${metricsHtml}</div>
    </div>`;

  let html = "";

  // ===== WHOLE-TEAM OVERVIEW (everyone: agents + admins + Leslie/all owners) =====
  html += sectionTitle("Whole Team Overview", "Every consultant combined — agents, sales admins, and admins");
  const teamBooked = allLeads.filter(leadIsBooked).length;
  html += card("All Consultants — Combined",
    metric(allLeads.length, "total leads", "#0f2748") +
    metric(totalTranscribed, "leads transcribed", "#2e8b57") +
    metric(teamBooked, "booked", "#2e8b57") +
    metric(money(bookedValue(allLeads)), "booked value", "#2e8b57") +
    metric(allLeads.filter(leadIsActive).length, "in pipeline", "#c9a227") +
    metric(allLeads.filter(isStale).length, "stale", "#b42318"),
    "#0f2748");

  // ===== SECTION 1: TEAM LEADS =====
  html += sectionTitle("Team Lead Performance", "Mex — Sales Agents team · Niña — Sales Admins team");

  // Mex = all agents rolled up
  const agentLeads = allLeads.filter(l => agents.some(a => a.id === l.agent_id));
  html += card("Mex — Sales Agents Team",
    metric(agents.length, "agents", "#4a6fb5") +
    metric(agentLeads.length, "total leads") +
    metric(agentLeads.filter(leadIsBooked).length, "booked", "#2e8b57") +
    metric(money(bookedValue(agentLeads)), "booked value", "#2e8b57") +
    metric(agentLeads.filter(leadIsActive).length, "in pipeline", "#c9a227") +
    metric(agentLeads.filter(isStale).length, "stale", "#b42318"),
    "#4a6fb5");

  // Niña = all admins rolled up. Headline = leads with a transcript (real work).
  // Second number = the sum credited to admins (by last editor), which should
  // track closely to the headline.
  const adminCredited = admins.reduce((s, a) => s + transcriptsBy(a.id), 0);
  html += card("Niña — Sales Admins Team",
    metric(admins.length, "admins", "#6b5bc4") +
    metric(totalTranscribed, "leads transcribed", "#2e8b57") +
    metric(adminCredited, "credited to admins", "#6b5bc4"),
    "#6b5bc4");

  // ===== SECTION 2: SALES AGENTS =====
  html += sectionTitle("Sales Agent Performance", "Booking, value, pipeline and follow-up health — evaluated by Mex");
  const agentRows = agents.map(p => {
    const mine = byOwner(p.id);
    const booked = mine.filter(leadIsBooked).length;
    const conv = mine.length ? Math.round(1000 * booked / mine.length) / 10 : 0;
    return { p, mine, booked, conv };
  }).sort((a, b) => bookedValue(b.mine) - bookedValue(a.mine) || b.mine.length - a.mine.length);

  if (!agentRows.length) html += `<div style="grid-column:1 / -1; color:var(--ink-faint); font-size:13px;">No sales agents.</div>`;
  agentRows.forEach(({ p, mine, booked, conv }) => {
    html += card(p.full_name,
      metric(mine.length, "leads") +
      metric(booked, "booked", "#2e8b57") +
      metric(conv + "%", "conversion") +
      metric(money(bookedValue(mine)), "booked value", "#2e8b57") +
      metric(mine.filter(leadIsActive).length, "in pipeline", "#c9a227") +
      metric(mine.filter(isStale).length, "stale", "#b42318"),
      "#2e8b57");
  });

  // ===== SECTION 3: SALES ADMINS =====
  html += sectionTitle("Sales Admin Performance",
    `Transcriptions encoded (leads with a transcript, credited to the encoder) — evaluated by Niña. Team total: ${totalTranscribed} leads.`);
  const adminRows = admins.map(p => ({ p, n: transcriptsBy(p.id) })).sort((a, b) => b.n - a.n);
  if (!adminRows.length) html += `<div style="grid-column:1 / -1; color:var(--ink-faint); font-size:13px;">No sales admins.</div>`;
  adminRows.forEach(({ p, n }) => {
    html += card(p.full_name,
      metric(n, "transcriptions encoded", "#6b5bc4"),
      "#6b5bc4");
  });

  grid.innerHTML = html;
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
  drawFunnel("funnelGrid", allLeadsCache.filter(l => !isSlotsImport(l) && inRange(leadDate(l), range)));
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
  const scoped = allLeadsCache.filter(l => !isSlotsImport(l) && inRange(leadDate(l), range));
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
  // Exclude historical slots imports so the dashboard reflects current work.
  const theirs = allLeadsCache.filter(l => l.agent_id === who.id && !isSlotsImport(l));
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
            <button id="agentExportBtn" class="pill" type="button">↓ Export to Excel</button>
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
                  <td style="${td}">${fmtDateFlagged(l.travel_date)}</td>
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
  document.getElementById("agentExportBtn")?.addEventListener("click", (e) =>
    exportLeadsExcel(tableLeads, who ? who.full_name : "My leads", e.target));
  body.querySelectorAll(".agent-page").forEach(b => b.addEventListener("click", () => {
    agentPage = Number(b.dataset.page); renderAgentDashboard();
  }));
  body.querySelectorAll(".agent-open").forEach(b => b.addEventListener("click", () => {
    openClientProfile(b.dataset.lead);
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
  // The button is hidden for everyone else, but a hidden button is not a
  // lock — check here too. The database is the third and final check.
  if (!currentProfile?.can_delete_leads) return;
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

// ---------- Complete Client Profile ----------
// Opens the full saved record — every field from the Client Profile form,
// in the same order — rather than the document summary. Built here so
// index.html needs no changes.

function profileRow(label, value) {
  const shown = (value === null || value === undefined || value === "" ) ? "—" : value;
  return `
    <div>
      <div style="font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-faint); margin-bottom:3px;">${label}</div>
      <div style="font-size:13.5px; color:var(--navy-900); font-weight:500; word-break:break-word;">${shown}</div>
    </div>`;
}

function profileSection(title, rows, cols = 3) {
  return `
    <div style="margin-top:24px;">
      <div style="font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase;
        color:var(--gold-600); padding-bottom:8px; border-bottom:1px solid var(--line); margin-bottom:14px;">${title}</div>
      <div style="display:grid; grid-template-columns:repeat(${cols}, 1fr); gap:16px 20px;">${rows}</div>
    </div>`;
}

function paymentsTable(l) {
  const payments = l.payments || [];
  if (payments.length === 0) {
    return `<div style="font-size:13px; color:var(--ink-faint);">No payments recorded.</div>`;
  }
  const th = "padding:8px 10px; text-align:left; font-size:10.5px; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-faint); border-bottom:1px solid var(--line);";
  const td = "padding:10px; font-size:13px; border-bottom:1px solid rgba(0,0,0,.05); color:var(--navy-900);";
  return `
    <table style="width:100%; border-collapse:collapse;">
      <thead><tr>
        <th style="${th}">#</th><th style="${th}">Date</th>
        <th style="${th} text-align:right;">Amount</th>
        <th style="${th}">Method</th><th style="${th}">Receipt</th>
      </tr></thead>
      <tbody>
        ${payments.map((p, i) => `
          <tr>
            <td style="${td}">${String(i + 1).padStart(2, "0")}</td>
            <td style="${td}">${p.date ? fmtDate(p.date) : "—"}</td>
            <td style="${td} text-align:right; font-weight:600;">${currency(p.amount)}</td>
            <td style="${td}">${p.method || "—"}</td>
            <td style="${td}">${p.receipt_path
              ? `<a href="#" onclick="viewDocument('${p.receipt_path}'); return false;" style="color:var(--gold-600); font-weight:600;">View</a>`
              : '<span style="color:var(--ink-faint);">None</span>'}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

function openClientProfile(leadId) {
  const l = allLeadsCache.find(x => x.id === leadId);
  if (!l) return;

  const paid = leadPaid(l);
  const value = Number(l.deal_value) || 0;
  const balance = Math.max(value - paid, 0);
  const docs = docCount(l.id);
  const problems = leadProblems(l);

  let overlay = document.getElementById("profileOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "profileOverlay";
    overlay.style.cssText = `position:fixed; inset:0; background:rgba(8,18,38,.55); z-index:9999;
      display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:32px 20px;`;
    document.body.appendChild(overlay);
    // Clicking the dark area or pressing Escape closes it.
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeClientProfile(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeClientProfile(); });
  }

  overlay.innerHTML = `
    <div style="background:#fff; border-radius:16px; max-width:1080px; width:100%; padding:28px 30px 34px;
      box-shadow:0 24px 60px rgba(0,0,0,.3);">

      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px;">
        <div>
          <div style="font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--gold-600); font-weight:700;">Client Profile</div>
          <h2 style="margin:4px 0 6px; font-size:24px; color:var(--navy-900); letter-spacing:-.02em;">${l.client_full_name || "Unnamed client"}</h2>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <span style="display:inline-block; padding:4px 11px; border-radius:999px; font-size:11px; font-weight:700;
              color:#fff; background:${stageColour(l.journey_stage)};">${l.journey_stage || "No stage"}</span>
            <span style="font-size:12.5px; color:var(--ink-soft);">${l.package_destination || "No package"}</span>
            <span style="font-size:12.5px; color:var(--ink-faint);">· ${agentName(l.agent_id)}</span>
          </div>
        </div>        <button type="button" id="profileClose"
          style="border:1px solid var(--line); background:#fff; border-radius:8px; padding:8px 14px;
          font-size:13px; font-weight:700; color:var(--navy-900); cursor:pointer; font-family:inherit;">Close ✕</button>
      </div>

      <div style="display:flex; gap:12px; margin-top:18px; flex-wrap:wrap;">
        <div style="flex:1; min-width:150px; background:#f4f6fa; border-radius:10px; padding:12px 14px;">
          <div style="font-size:11px; color:var(--ink-soft);">Deal value</div>
          <div style="font-size:19px; font-weight:800; color:var(--navy-900);">${currency(value)}</div>
        </div>
        <div style="flex:1; min-width:150px; background:#f4f6fa; border-radius:10px; padding:12px 14px;">
          <div style="font-size:11px; color:var(--ink-soft);">Paid</div>
          <div style="font-size:19px; font-weight:800; color:#2e8b57;">${currency(paid)}</div>
        </div>
        <div style="flex:1; min-width:150px; background:#f4f6fa; border-radius:10px; padding:12px 14px;">
          <div style="font-size:11px; color:var(--ink-soft);">Balance due</div>
          <div style="font-size:19px; font-weight:800; color:${balance > 0 ? "var(--navy-900)" : "var(--gold-600)"};">${currency(balance)}</div>
        </div>
        <div style="flex:1; min-width:150px; background:#f4f6fa; border-radius:10px; padding:12px 14px;">
          <div style="font-size:11px; color:var(--ink-soft);">Documents</div>
          <div style="font-size:19px; font-weight:800; color:var(--navy-900);">${docs}</div>
        </div>
      </div>

      ${problems.length ? `
        <div style="margin-top:16px; padding:12px 14px; background:#fdecea; border:1px solid #b42318;
          border-radius:10px;">
          <div style="font-size:12.5px; font-weight:700; color:#b42318; margin-bottom:4px;">
            ⚠ ${problems.length} thing${problems.length === 1 ? "" : "s"} to check on this record</div>
          <ul style="margin:0; padding-left:18px; font-size:12.5px; color:#b42318; line-height:1.7;">
            ${problems.map(p => `<li>${p}</li>`).join("")}
          </ul>
        </div>` : ""}

      ${profileSection("Client information", [
        profileRow("Full name", l.client_full_name),
        profileRow("Email", l.client_email),
        profileRow("Mobile number", l.client_mobile),
        profileRow("Date of inquiry", l.inquiry_date ? fmtDate(l.inquiry_date) : null),
        profileRow("Time of inquiry", l.inquiry_time),
        profileRow("Assigned consultant", agentName(l.assigned_consultant || l.agent_id)),
      ].join(""))}

      ${profileSection("Emergency contact & address", [
        profileRow("Emergency contact name", l.emergency_contact_name),
        profileRow("Emergency contact number", l.emergency_contact_phone),
        profileRow("Physical address", l.client_address),
      ].join(""))}

      ${profileSection("Travel profile", [
        profileRow("Package / Destination", l.package_destination),
        profileRow("Preferred travel date", l.travel_date ? fmtDateFlagged(l.travel_date) : null),
        profileRow("Number of travelers", l.travelers),
        profileRow("Visa status", l.visa_status),
        profileRow("Lead source", l.lead_source),
        profileRow("Estimated deal value", currency(l.deal_value)),
      ].join(""))}

      ${profileSection("Sales journey & closing strategy", [
        profileRow("Journey stage", l.journey_stage),
        profileRow("Lead temperature", l.lead_temperature),
        profileRow("Decision status", l.decision_status),
        profileRow("Next follow-up", l.next_followup ? new Date(l.next_followup).toLocaleString() : null),
      ].join(""))}
      <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:16px 20px; margin-top:16px;">
        ${profileRow("Client concern / buying signal", l.concern)}
        ${profileRow("Next closing strategy", l.closing_strategy)}
        ${profileRow("Remarks", l.remarks)}
      </div>

      ${profileSection("Booking & payments", [
        profileRow("Booking reference", l.booking_reference),
        profileRow("Booking confirmation", l.booking_confirmation_path
          ? `<a href="#" onclick="viewDocument('${l.booking_confirmation_path}'); return false;" style="color:var(--gold-600); font-weight:700;">View file</a>`
          : null),
        profileRow("Payments recorded", (l.payments || []).length),
      ].join(""))}
      <div style="margin-top:14px;">${paymentsTable(l)}</div>

      ${profileSection("Visa service, discounts & considerations", [
        profileRow("Visa service availed", l.visa_service_availed),
        profileRow("Visa service fee", currency(l.visa_service_fee)),
        profileRow("Visa service discount", currency(l.visa_service_discount)),
        profileRow("Applied package discounts", l.applied_discounts),
        profileRow("Special freebies", l.special_freebies),
        profileRow("Special client requests", l.special_requests),
      ].join(""))}

      ${profileSection("Traveler preferences & optional services", [
        profileRow("Preferred airline", l.preferred_airline),
        profileRow("Seat preference", l.seat_preference),
        profileRow("Meal preference / allergy", l.meal_preference),
        profileRow("Room preference", l.room_preference),
        profileRow("Traveler preferences", l.traveler_preferences),
        profileRow("Optional tours", l.optional_tours),
        profileRow("Optional services", l.optional_services),
      ].join(""))}

      ${l.suggested_script ? `
        <div style="margin-top:22px;">
          <h3 style="font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--gold-600); margin:0 0 8px;">Suggested script to send</h3>
          <div style="background:#fffdf5; border:1px solid var(--gold-600); border-radius:10px; padding:14px 16px;
            font-size:13.5px; line-height:1.6; color:var(--navy-900); white-space:pre-wrap;">${l.suggested_script.replace(/</g, "&lt;")}</div>
        </div>` : ""}

      ${(l.transcript_meta || l.transcript_viber || l.transcript_phone) ? `
        <div style="margin-top:22px;">
          <h3 style="font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--gold-600); margin:0 0 8px;">Conversation transcripts</h3>
          ${[["Messenger", l.transcript_meta], ["Viber", l.transcript_viber], ["Phone call", l.transcript_phone]]
            .filter(([, t]) => t).map(([label, t]) => `
              <div style="margin-bottom:10px;">
                <div style="font-size:11px; font-weight:700; color:var(--ink-faint); margin-bottom:3px;">${label}</div>
                <div style="background:#f4f6fa; border:1px solid var(--line); border-radius:10px; padding:12px 14px;
                  font-size:13px; line-height:1.6; color:var(--ink-soft); white-space:pre-wrap; max-height:260px; overflow-y:auto;">${t.replace(/</g, "&lt;")}</div>
              </div>`).join("")}
        </div>` : ""}

      <div id="profileNotes" style="margin-top:22px;"></div>

      ${profileSection("Record history", [
        profileRow("Owned by", agentName(l.agent_id)),
        profileRow("Entered by", l.created_by ? agentName(l.created_by) : "—"),
        profileRow("Created", l.created_at ? new Date(l.created_at).toLocaleString() : null),
        profileRow("Last edited by", l.updated_by ? agentName(l.updated_by) : "—"),
        profileRow("Last updated", l.updated_at ? new Date(l.updated_at).toLocaleString() : null),
      ].join(""), 4)}

      <div style="display:flex; gap:10px; margin-top:26px; padding-top:18px; border-top:1px solid var(--line);">
        ${canEditLead(l) ? `
          <button type="button" id="profileEdit"
            style="padding:10px 18px; border:none; border-radius:8px; background:var(--gold-600); color:#fff;
            font-size:13px; font-weight:700; cursor:pointer; font-family:inherit;">Edit profile</button>` : ""}
        <button type="button" id="profileDocs"
          style="padding:10px 18px; border:none; border-radius:8px; background:var(--navy-900); color:#fff;
          font-size:13px; font-weight:700; cursor:pointer; font-family:inherit;">
          Documents${docs ? ` (${docs})` : ""} & upload</button>
        <button type="button" id="profileClose2"
          style="padding:10px 18px; border:1px solid var(--line); border-radius:8px; background:#fff;
          font-size:13px; font-weight:700; color:var(--navy-900); cursor:pointer; font-family:inherit;">Close</button>
      </div>
    </div>`;

  overlay.style.display = "flex";
  document.body.style.overflow = "hidden";

  document.getElementById("profileClose").onclick = closeClientProfile;
  document.getElementById("profileClose2").onclick = closeClientProfile;
  const editBtn = document.getElementById("profileEdit");
  if (editBtn) editBtn.onclick = () => editClientProfile(leadId);

  // Show the conversation-notes log on the read-only profile too.
  renderProfileNotes(leadId);
  document.getElementById("profileDocs").onclick = () => {
    closeClientProfile();
    const sel = document.getElementById("voucherClientSelect");
    if (!sel) return;
    sel.value = leadId;
    sel.dispatchEvent(new Event("change"));
    goToView("voucher");
    setTimeout(() => {
      document.getElementById("voucherCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
  };
}

function closeClientProfile() {
  const overlay = document.getElementById("profileOverlay");
  if (overlay) overlay.style.display = "none";
  document.body.style.overflow = "";
}

// ---------- Editing a client profile ----------
// An agent may correct their own client; admins and sales admins may correct
// anyone's. The database enforces the same rule, so a blocked edit fails
// rather than silently doing nothing.
function canEditLead(l) {
  if (!currentProfile) return false;
  if (currentProfile.role !== "agent") return true;
  return l.agent_id === currentProfile.id;
}

const STAGE_OPTIONS = [
  "New Inquiry", "Discovery & Qualification", "Solution Presented",
  "Decision in Progress", "Strategic Nurturing", "Reservation / Payment Processing",
  "Successfully Booked", "Lost Opportunity",
];
const TEMP_OPTIONS = [
  "Hot – likely to close within 7 days",
  "Warm – engaged, needs nurturing",
  "Cold – early stage, low urgency",
];
const DECISION_OPTIONS = ["Ready to reserve", "Comparing options", "Awaiting approval", "On hold"];
const VISA_OPTIONS = ["Not yet applied", "In progress", "Approved", "Not required"];
const SOURCE_OPTIONS = ["Facebook", "Instagram", "Referral", "Walk-in", "Website"];
const METHOD_OPTIONS = ["Bank transfer", "Credit card", "Cash", "GCash", "Travel Fund"];

function editField(label, id, value, type = "text") {
  return `
    <div>
      <label style="display:block; font-size:11px; letter-spacing:.05em; text-transform:uppercase;
        color:var(--ink-faint); margin-bottom:4px;">${label}</label>
      <input type="${type}" id="${id}" value="${value === null || value === undefined ? "" : String(value).replace(/"/g, "&quot;")}"
        style="width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:7px;
        font-size:13.5px; font-family:inherit; color:var(--navy-900);">
    </div>`;
}

function editArea(label, id, value) {
  return `
    <div style="grid-column:1 / -1;">
      <label style="display:block; font-size:11px; letter-spacing:.05em; text-transform:uppercase;
        color:var(--ink-faint); margin-bottom:4px;">${label}</label>
      <textarea id="${id}" rows="2"
        style="width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:7px;
        font-size:13.5px; font-family:inherit; color:var(--navy-900); resize:vertical;">${value || ""}</textarea>
    </div>`;
}

function editSelect(label, id, value, options) {
  return `
    <div>
      <label style="display:block; font-size:11px; letter-spacing:.05em; text-transform:uppercase;
        color:var(--ink-faint); margin-bottom:4px;">${label}</label>
      <select id="${id}" style="width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:7px;
        font-size:13.5px; font-family:inherit; background:#fff; color:var(--navy-900);">
        ${options.map(o => `<option ${o === value ? "selected" : ""}>${o}</option>`).join("")}
      </select>
    </div>`;
}

function editGroup(title, inner, cols = 3) {
  return `
    <div style="margin-top:22px;">
      <div style="font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase;
        color:var(--gold-600); padding-bottom:8px; border-bottom:1px solid var(--line); margin-bottom:14px;">${title}</div>
      <div style="display:grid; grid-template-columns:repeat(${cols}, 1fr); gap:14px 18px;">${inner}</div>
    </div>`;
}

// Receipts and booking files are left exactly as they are. Editing text
// fields must never silently drop an uploaded receipt.
// Payments are edited inline here so every department sees the same numbers.
// Rows can be added or removed; receipt files are preserved untouched.
function editPaymentRows(payments) {
  const rows = (payments && payments.length) ? payments : [];
  const rowHtml = (p, i) => `
    <div class="ep-row" data-row="${i}" style="display:grid; grid-template-columns:28px 1fr 1fr 1fr auto 34px; gap:8px; align-items:end; margin-bottom:8px;">
      <div style="font-size:12px; font-weight:700; color:var(--ink-faint); padding-bottom:9px;">${String(i + 1).padStart(2, "0")}</div>
      ${editField("Date", `ep_date_${i}`, p.date, "date")}
      ${editField("Amount", `ep_amt_${i}`, Number(p.amount) || 0, "number")}
      ${editSelect("Method", `ep_method_${i}`, p.method || "", ["", ...METHOD_OPTIONS])}
      <div style="padding-bottom:6px;">
        <label style="display:block; font-size:11px; letter-spacing:.03em; text-transform:uppercase; color:var(--ink-faint); margin-bottom:3px;">Proof of payment</label>
        <input type="file" id="ep_receipt_${i}" class="ep-receipt" data-existing="${p.receipt_path || ""}"
          accept="image/*,application/pdf" style="font-size:11px; max-width:150px;">
        ${p.receipt_path
          ? `<a href="#" onclick="viewDocument('${p.receipt_path}'); return false;" style="display:block; color:var(--gold-600); font-weight:600; font-size:11px; margin-top:2px;">View current</a>`
          : '<span style="display:block; color:var(--ink-faint); font-size:11px; margin-top:2px;">No receipt yet</span>'}
      </div>
      <button type="button" class="ep-remove" data-row="${i}" title="Remove this payment"
        style="padding-bottom:9px; background:none; border:none; color:#b42318; font-size:18px; cursor:pointer;">&times;</button>
    </div>`;
  return `
    <div id="epRows">${rows.map(rowHtml).join("")}</div>
    <button type="button" id="epAdd" style="margin-top:6px; padding:7px 13px; border:1px dashed var(--line);
      border-radius:7px; background:#fff; font-size:12.5px; font-weight:600; color:var(--navy-900);
      cursor:pointer; font-family:inherit;">+ Add payment</button>
    <div style="font-size:11px; color:var(--ink-faint); margin-top:6px;">
      Receipts stay attached to their row. Upload new receipt files from Client's Documents.</div>`;
}

// Read the payment rows currently on screen back into an array. If a new
// receipt file was attached to a row, upload it and store its path; otherwise
// keep whatever receipt the row already had.
async function collectPaymentRows(existing) {
  const rows = [];
  const els = [...document.querySelectorAll("#epRows .ep-row")];
  for (const el of els) {
    const i = el.dataset.row;
    const date = document.getElementById(`ep_date_${i}`)?.value || null;
    const amount = Number(document.getElementById(`ep_amt_${i}`)?.value) || 0;
    const method = document.getElementById(`ep_method_${i}`)?.value || null;
    // Start from the original receipt path for this row if there was one.
    let receipt = (existing && existing[Number(i)] && existing[Number(i)].receipt_path) || null;
    // If the user attached a new proof-of-payment file, upload it and use that.
    const fileEl = document.getElementById(`ep_receipt_${i}`);
    const file = fileEl?.files?.[0];
    if (file) {
      try { const up = await uploadDocument(file); if (up) receipt = up; }
      catch (_) { /* if the upload fails, keep the existing receipt rather than losing the row */ }
    }
    if (date || amount || method || receipt) rows.push({ date, amount, method, receipt_path: receipt });
  }
  return rows;
}

function editClientProfile(leadId) {
  const l = allLeadsCache.find(x => x.id === leadId);
  if (!l || !canEditLead(l)) return;

  // Create the overlay if it isn't there yet. Opening Edit straight from the
  // Slots Tracker skips openClientProfile, so the overlay may not exist.
  let overlay = document.getElementById("profileOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "profileOverlay";
    overlay.style.cssText = `position:fixed; inset:0; background:rgba(8,18,38,.55); z-index:9999;
      display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:32px 20px;`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeClientProfile(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeClientProfile(); });
  }
  overlay.style.display = "flex";
  document.body.style.overflow = "hidden";

  const canReassign = currentProfile.role !== "agent";
  const consultants = allProfilesCache
    .map(p => `<option value="${p.id}" ${p.id === l.agent_id ? "selected" : ""}>${p.full_name}</option>`).join("");

  overlay.innerHTML = `
    <div style="background:#fff; border-radius:16px; max-width:1080px; width:100%; padding:28px 30px 34px;
      box-shadow:0 24px 60px rgba(0,0,0,.3);">

      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px;">
        <div>
          <div style="font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--gold-600); font-weight:700;">Editing</div>
          <h2 style="margin:4px 0 6px; font-size:24px; color:var(--navy-900); letter-spacing:-.02em;">${l.client_full_name || "Unnamed client"}</h2>
        </div>
        <button type="button" id="editCancelX" style="background:none; border:none; font-size:24px;
          color:var(--ink-faint); cursor:pointer; line-height:1;">&times;</button>
      </div>

      <div id="editError" style="display:none; margin-top:12px; padding:10px 12px; background:#fdecea;
        border:1px solid #b42318; border-radius:8px; font-size:13px; color:#b42318;"></div>

      ${editGroup("Client information",
        editField("Full name", "e_fullname", l.client_full_name) +
        editField("Email", "e_email", l.client_email, "email") +
        editField("Mobile number", "e_mobile", l.client_mobile) +
        editField("Date of inquiry", "e_inquiry_date", l.inquiry_date, "date") +
        editField("Time of inquiry", "e_inquiry_time", l.inquiry_time, "time") +
        `<div>
          <label style="display:block; font-size:11px; letter-spacing:.05em; text-transform:uppercase;
            color:var(--ink-faint); margin-bottom:4px;">Assigned consultant${canReassign ? "" : " (locked)"}</label>
          <select id="e_consultant" ${canReassign ? "" : "disabled"}
            style="width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:7px;
            font-size:13.5px; font-family:inherit; background:${canReassign ? "#fff" : "#f4f6fa"}; color:var(--navy-900);">
            ${consultants}
          </select>
        </div>`)}

      ${editGroup("Emergency contact & address",
        editField("Emergency contact name", "e_emg_name", l.emergency_contact_name) +
        editField("Emergency contact number", "e_emg_phone", l.emergency_contact_phone) +
        `<div></div>` +
        editArea("Physical address", "e_address", l.client_address))}

      ${editGroup("Travel profile",
        editField("Package / Destination", "e_destination", l.package_destination) +
        editField("Preferred travel date", "e_travel_date", l.travel_date, "date") +
        editField("Number of travelers", "e_travelers", Number(l.travelers) || 1, "number") +
        editSelect("Visa status", "e_visa_status", l.visa_status, VISA_OPTIONS) +
        editSelect("Lead source", "e_lead_source", l.lead_source, SOURCE_OPTIONS) +
        editField("Estimated deal value", "e_deal_value", Number(l.deal_value) || 0, "number") +
        `<div style="grid-column:1 / -1;">
          <label style="display:block; font-size:11px; letter-spacing:.05em; text-transform:uppercase;
            color:var(--ink-faint); margin-bottom:4px;">Departure — which trip is this client on?</label>
          <select id="e_departure" style="width:100%; padding:8px 10px; border:1px solid var(--line);
            border-radius:7px; font-size:13.5px; font-family:inherit; background:#fff; color:var(--navy-900);">
            <option value="">Not assigned to a departure</option>
            ${allDeparturesCache.map(d => {
              const s = departureStats(d);
              return `<option value="${d.id}" ${d.id === l.departure_id ? "selected" : ""}>
                ${d.route} — ${departureDates(d)} (${s.available} of ${d.capacity} seats left)</option>`;
            }).join("")}
          </select>
          <div style="font-size:11px; color:var(--ink-faint); margin-top:4px;">
            The seat is counted once this client reaches Reservation or Successfully Booked.</div>
        </div>`)}

      ${editGroup("Sales journey & closing strategy",
        editSelect("Journey stage", "e_stage", l.journey_stage, STAGE_OPTIONS) +
        editSelect("Lead temperature", "e_temperature", l.lead_temperature, TEMP_OPTIONS) +
        editSelect("Decision status", "e_decision", l.decision_status, DECISION_OPTIONS) +
        editField("Next follow-up", "e_followup", l.next_followup ? String(l.next_followup).slice(0, 16) : "", "datetime-local") +
        `<div style="display:flex; align-items:center; gap:8px; align-self:end; padding-bottom:8px;">
          <input type="checkbox" id="e_awaiting" ${l.awaiting_reply ? "checked" : ""} style="width:16px; height:16px; cursor:pointer;">
          <label for="e_awaiting" style="font-size:13px; color:var(--navy-900); cursor:pointer;">Awaiting our reply (client messaged last)</label>
        </div><div></div>` +
        editArea("Client concern / buying signal", "e_concern", l.concern) +
        `<div style="grid-column:1 / -1;">
          <label style="display:block; font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-faint); margin-bottom:4px;">Next closing strategy</label>
          <textarea id="e_strategy" rows="2"
            style="width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:7px; font-size:13.5px; font-family:inherit; color:var(--navy-900); resize:vertical;">${l.closing_strategy || ""}</textarea>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px;">
            <select id="e_expert" style="padding:8px 11px; border:1px solid var(--line); border-radius:8px; font-size:13px; font-family:inherit; background:#fff; color:var(--navy-900);">
              <option value="hormozi">Alex Hormozi — value & offer stacking</option>
              <option value="elliott">Andy Elliott — high-energy assumptive close</option>
              <option value="levitin">Shari Levitin — heart & emotional connection</option>
              <option value="blount">Jeb Blount — objection handling & follow-up</option>
              <option value="carnegie">Dale Carnegie — rapport & making them feel valued</option>
              <option value="ogilvy">David Ogilvy — persuasive benefit-driven copy</option>
            </select>
            <button type="button" id="e_expert_gen" style="padding:8px 15px; border:none; border-radius:8px; background:var(--navy-900); color:#fff; font-size:13px; font-weight:700; cursor:pointer; font-family:inherit;">✨ Suggest strategy</button>
            <span id="e_expert_note" style="font-size:12px; color:var(--ink-faint);"></span>
          </div>
          <div style="font-size:11.5px; color:var(--ink-faint); margin-top:5px;">Fills the strategy above with this expert's approach for closing the sale.</div>
          <div id="e_expert_strategy" style="display:none;"></div>
        </div>` +
        editArea("Remarks", "e_remarks", l.remarks))}

      ${editGroup("Conversation transcripts",
        `<div style="grid-column:1 / -1; display:grid; gap:14px;">
          <div>
            <label style="display:block; font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-faint); margin-bottom:4px;">Messenger (Meta) transcript</label>
            <textarea id="e_tx_meta" rows="5" placeholder="Paste the Messenger conversation…"
              style="width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; font-size:13px; font-family:inherit; resize:vertical; line-height:1.5;">${(l.transcript_meta || "").replace(/</g, "&lt;")}</textarea>
          </div>
          <div>
            <label style="display:block; font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-faint); margin-bottom:4px;">Viber transcript</label>
            <textarea id="e_tx_viber" rows="5" placeholder="Paste the Viber conversation…"
              style="width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; font-size:13px; font-family:inherit; resize:vertical; line-height:1.5;">${(l.transcript_viber || "").replace(/</g, "&lt;")}</textarea>
          </div>
          <div>
            <label style="display:block; font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-faint); margin-bottom:4px;">Phone call transcript / notes</label>
            <textarea id="e_tx_phone" rows="5" placeholder="Paste or type what was discussed on the call…"
              style="width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; font-size:13px; font-family:inherit; resize:vertical; line-height:1.5;">${(l.transcript_phone || "").replace(/</g, "&lt;")}</textarea>
          </div>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <button type="button" id="e_suggest" style="padding:9px 16px; border:none; border-radius:8px; background:var(--gold-600); color:#fff; font-size:13px; font-weight:700; cursor:pointer; font-family:inherit;">✨ Fill status, score, concern, strategy & follow-up</button>
            <span id="e_suggest_note" style="font-size:12px; color:var(--ink-faint);"></span>
            <input type="hidden" id="e_ai_score" value="${l.ai_lead_score ?? ""}">
          </div>
        </div>`)}

      ${editGroup("Suggested script & strategy",
        `<div style="grid-column:1 / -1;">
          <textarea id="e_script" rows="6" placeholder="Click Generate to get a ready-to-send message based on the conversation…"
            style="width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; font-size:13.5px; font-family:inherit; resize:vertical; line-height:1.6; background:#fffdf5;">${(l.suggested_script || "").replace(/</g, "&lt;")}</textarea>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px;">
            <button type="button" id="e_gen_script" style="padding:9px 16px; border:none; border-radius:8px; background:var(--navy-900); color:#fff; font-size:13px; font-weight:700; cursor:pointer; font-family:inherit;">✨ Generate script</button>
            <button type="button" id="e_handle_obj" style="padding:9px 16px; border:none; border-radius:8px; background:var(--gold-600); color:#fff; font-size:13px; font-weight:700; cursor:pointer; font-family:inherit;">🛡️ Handle objection</button>
            <button type="button" id="e_copy_script" style="padding:9px 14px; border:1px solid var(--line); border-radius:8px; background:#fff; font-size:13px; font-weight:700; color:var(--navy-900); cursor:pointer; font-family:inherit;">Copy</button>
            <span id="e_script_note" style="font-size:12px; color:var(--ink-faint);"></span>
          </div>
          <div style="margin-top:8px;">
            <input id="e_script_instruction" type="text" placeholder="Want it different? e.g. 'make it warmer', 'shorter', 'offer the promo' — then Generate again"
              style="width:100%; padding:8px 11px; border:1px solid var(--line); border-radius:8px; font-size:12.5px; font-family:inherit;">
          </div>
        </div>`)}

      ${editGroup("Approved script",
        `<div style="grid-column:1 / -1;">
          ${l.script_approved && l.suggested_script ? `
            <div style="background:#eef7ee; border:1px solid #2e8b57; border-radius:10px; padding:14px 16px;
              font-size:13.5px; line-height:1.6; color:var(--navy-900); white-space:pre-wrap;">${(l.suggested_script || "").replace(/</g, "&lt;")}</div>
            <div style="font-size:11px; color:var(--ink-faint); margin-top:5px;">
              ✅ Approved${l.script_approved_by ? " by " + agentName(l.script_approved_by) : ""}${l.script_approved_at ? " · " + new Date(l.script_approved_at).toLocaleString() : ""}</div>` : `
            <div style="font-size:12.5px; color:var(--ink-faint);">No approved script yet. Generate a script above, then click <strong>Approve this script</strong> to save it here.</div>`}
          <div style="display:flex; gap:8px; align-items:center; margin-top:10px;">
            <button type="button" id="e_approve_script" style="padding:9px 16px; border:none; border-radius:8px;
              background:#2e8b57; color:#fff; font-size:13px; font-weight:700; cursor:pointer; font-family:inherit;">✅ Approve this script</button>
            <span id="e_approve_note" style="font-size:12px; color:var(--ink-faint);"></span>
          </div>
        </div>`)}

      ${editGroup("Client conversation notes",
        `<div style="grid-column:1 / -1;">
          <div id="e_notes_list" style="display:flex; flex-direction:column; gap:8px; margin-bottom:10px;">
            <div style="font-size:12.5px; color:var(--ink-faint);">Loading notes…</div>
          </div>
          <textarea id="e_new_note" rows="2" placeholder="Add a note about this client… (saved with your name and the time)"
            style="width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; font-size:13px; font-family:inherit; resize:vertical;"></textarea>
          <button type="button" id="e_add_note" style="margin-top:8px; padding:8px 15px; border:none; border-radius:8px; background:var(--gold-600); color:#fff; font-size:13px; font-weight:700; cursor:pointer; font-family:inherit;">Add note</button>
          <span id="e_note_status" style="margin-left:10px; font-size:12px; color:var(--ink-faint);"></span>
        </div>`)}

      ${editGroup("Booking & payments",
        editField("Booking reference", "e_booking_ref", l.booking_reference) + `<div></div><div></div>`)}
      <div style="margin-top:10px;">${editPaymentRows(l.payments)}</div>
      <div style="font-size:11.5px; color:var(--ink-faint); margin-top:8px;">
        Receipts and the booking confirmation stay as they are — upload new files from Client's Documents.
      </div>

      ${editGroup("Visa service, discounts & considerations",
        editSelect("Visa service availed", "e_visa_availed", l.visa_service_availed, ["No", "Yes"]) +
        editField("Visa service fee", "e_visa_fee", Number(l.visa_service_fee) || 0, "number") +
        editField("Visa service discount", "e_visa_discount", Number(l.visa_service_discount) || 0, "number") +
        editArea("Applied package discounts", "e_discounts", l.applied_discounts) +
        editArea("Special freebies", "e_freebies", l.special_freebies) +
        editArea("Special client requests", "e_requests", l.special_requests))}

      ${editGroup("Traveler preferences & optional services",
        editField("Preferred airline", "e_airline", l.preferred_airline) +
        editField("Seat preference", "e_seat", l.seat_preference) +
        editField("Meal preference / allergy", "e_meal", l.meal_preference) +
        editField("Room preference", "e_room", l.room_preference) +
        `<div></div><div></div>` +
        editArea("Traveler preferences", "e_preferences", l.traveler_preferences) +
        editArea("Optional tours", "e_tours", l.optional_tours) +
        editArea("Optional services", "e_services", l.optional_services))}

      <div style="display:flex; gap:10px; margin-top:26px; padding-top:18px; border-top:1px solid var(--line);">
        <button type="button" id="editSave"
          style="padding:10px 20px; border:none; border-radius:8px; background:var(--navy-900); color:#fff;
          font-size:13px; font-weight:700; cursor:pointer; font-family:inherit;">Save changes</button>
        <button type="button" id="editCancel"
          style="padding:10px 18px; border:1px solid var(--line); border-radius:8px; background:#fff;
          font-size:13px; font-weight:700; color:var(--navy-900); cursor:pointer; font-family:inherit;">Cancel</button>
      </div>
    </div>`;

  overlay.scrollTop = 0;
  const back = () => openClientProfile(leadId);
  document.getElementById("editCancel").onclick = back;
  document.getElementById("editCancelX").onclick = back;
  document.getElementById("editSave").onclick = () => saveProfileEdits(leadId);

  // Payment rows: add and remove, so payments are fully editable here.
  wirePaymentEditor(leadId);

  // Pull the three channels together into one text for the AI to read.
  const gatherTranscript = () => {
    const parts = [];
    const m = document.getElementById("e_tx_meta")?.value?.trim();
    const v2 = document.getElementById("e_tx_viber")?.value?.trim();
    const p = document.getElementById("e_tx_phone")?.value?.trim();
    if (m) parts.push("[Messenger]\n" + m);
    if (v2) parts.push("[Viber]\n" + v2);
    if (p) parts.push("[Phone call]\n" + p);
    return parts.join("\n\n");
  };

  // Fill concern, strategy, follow-up from the conversation. Remarks left alone.
  const suggestBtn = document.getElementById("e_suggest");
  if (suggestBtn) suggestBtn.onclick = async () => {
    const note = document.getElementById("e_suggest_note");
    const tx = gatherTranscript();
    if (!tx) { note.textContent = "Paste a conversation first."; return; }
    suggestBtn.disabled = true; suggestBtn.textContent = "✨ Reading…"; note.textContent = "";
    try {
      const { data, error } = await supabaseClient.functions.invoke("suggest-from-transcript", {
        body: { transcript: tx, stage: document.getElementById("e_stage")?.value || "",
          package_destination: document.getElementById("e_destination")?.value || "",
          today: new Date().toISOString().slice(0, 10) },
      });
      if (error || data?.error) note.textContent = "Couldn't read it — " + (data?.error || error.message);
      else {
        if (data.client_concern) document.getElementById("e_concern").value = data.client_concern;
        if (data.closing_strategy) document.getElementById("e_strategy").value = data.closing_strategy;
        if (data.next_followup) { const el = document.getElementById("e_followup"); if (el) el.value = data.next_followup + "T09:00"; }
        // AI-set status (Hot/Warm/Cold) mapped to the dropdown's full label.
        if (data.status) {
          const el = document.getElementById("e_temperature");
          const match = TEMP_OPTIONS.find(o => o.toLowerCase().startsWith(data.status.toLowerCase()));
          if (el && match) el.value = match;
        }
        if (data.lead_score != null) { const el = document.getElementById("e_ai_score"); if (el) el.value = data.lead_score; }
        note.textContent = "Suggested — status, score, concern, strategy & follow-up filled. Review, then Save.";
      }
    } catch (e) { note.textContent = "Couldn't reach the AI service."; }
    suggestBtn.disabled = false; suggestBtn.textContent = "✨ Fill concern, strategy & follow-up";
  };

  // Generate the exact message to send. Reads the optional instruction box so
  // the agent can regenerate / paraphrase to their liking.
  const genBtn = document.getElementById("e_gen_script");
  if (genBtn) genBtn.onclick = async () => {
    const note = document.getElementById("e_script_note");
    const tx = gatherTranscript();
    if (!tx) { note.textContent = "Paste a conversation first."; return; }
    genBtn.disabled = true; genBtn.textContent = "✨ Writing…"; note.textContent = "";
    try {
      const { data, error } = await supabaseClient.functions.invoke("suggest-script", {
        body: { transcript: tx, stage: document.getElementById("e_stage")?.value || "",
          package_destination: document.getElementById("e_destination")?.value || "",
          client_name: (allLeadsCache.find(x => x.id === leadId)?.client_full_name) || "",
          instruction: document.getElementById("e_script_instruction")?.value || "" },
      });
      if (error || data?.error) note.textContent = "Couldn't write it — " + (data?.error || error.message);
      else if (data.script) { document.getElementById("e_script").value = data.script; note.textContent = "Ready — edit if needed, Copy, then Save."; }
      else note.textContent = "No script returned — try again.";
    } catch (e) { note.textContent = "Couldn't reach the AI service."; }
    genBtn.disabled = false; genBtn.textContent = "✨ Generate script";
  };

  // Objection handler — reframes a client's pushback into Sel's next message,
  // using the instruction box as the specific objection if the agent typed one.
  const objBtn = document.getElementById("e_handle_obj");
  if (objBtn) objBtn.onclick = async () => {
    const note = document.getElementById("e_script_note");
    const tx = gatherTranscript();
    if (!tx) { note.textContent = "Paste the conversation first."; return; }
    objBtn.disabled = true; objBtn.textContent = "🛡️ Thinking…"; note.textContent = "";
    try {
      const { data, error } = await supabaseClient.functions.invoke("handle-objection", {
        body: { transcript: tx,
          objection: document.getElementById("e_script_instruction")?.value || "",
          client_name: (allLeadsCache.find(x => x.id === leadId)?.client_full_name) || "" },
      });
      if (error || data?.error) note.textContent = "Couldn't handle it — " + (data?.error || error.message);
      else if (data.script) { document.getElementById("e_script").value = data.script; note.textContent = "Objection reframed — review, Copy, then Save."; }
      else note.textContent = "Nothing returned — try again.";
    } catch (e) { note.textContent = "Couldn't reach the AI service."; }
    objBtn.disabled = false; objBtn.textContent = "🛡️ Handle objection";
  };

  // Approve the current script: mark it on the lead and add to the library.
  const approveBtn = document.getElementById("e_approve_script");
  if (approveBtn) approveBtn.onclick = async () => {
    const note = document.getElementById("e_approve_note");
    const script = (document.getElementById("e_script")?.value || "").trim();
    if (!script) { note.textContent = "Generate a script first."; return; }
    approveBtn.disabled = true; note.textContent = "Saving…";
    const clientName = (allLeadsCache.find(x => x.id === leadId)?.client_full_name) || "";
    const now = new Date().toISOString();
    try {
      const up = await supabaseClient.from("leads").update({
        suggested_script: script, script_approved: true,
        script_approved_by: currentProfile.id, script_approved_at: now,
      }).eq("id", leadId);
      await supabaseClient.from("approved_scripts").insert({
        lead_id: leadId, client_name: clientName, script,
        approved_by: currentProfile.id, approved_at: now,
      });
      if (up.error) note.textContent = "Couldn't save — " + up.error.message;
      else {
        note.textContent = "✅ Approved and saved to the library.";
        const c = allLeadsCache.find(x => x.id === leadId);
        if (c) { c.suggested_script = script; c.script_approved = true; c.script_approved_by = currentProfile.id; c.script_approved_at = now; }
      }
    } catch (e) { note.textContent = "Couldn't save — " + e.message; }
    approveBtn.disabled = false;
  };

  // Six-expert closing strategy: fill the "Next closing strategy" field with a
  // chosen expert's approach for closing this lead. Strategy only — no script.
  const expGen = document.getElementById("e_expert_gen");
  if (expGen) expGen.onclick = async () => {
    const note = document.getElementById("e_expert_note");
    const tx = gatherTranscript();
    if (!tx) { note.textContent = "Paste a conversation first."; return; }
    expGen.disabled = true; expGen.textContent = "✨ Thinking…"; note.textContent = "";
    try {
      const { data, error } = await supabaseClient.functions.invoke("expert-strategy", {
        body: { transcript: tx,
          expert: document.getElementById("e_expert")?.value || "hormozi",
          client_name: (allLeadsCache.find(x => x.id === leadId)?.client_full_name) || "" },
      });
      if (error || data?.error) note.textContent = "Couldn't generate — " + (data?.error || error.message);
      else {
        if (data.strategy && document.getElementById("e_strategy")) document.getElementById("e_strategy").value = data.strategy;  // fill Next closing strategy
        note.textContent = data.strategy ? "Strategy filled above." : "No strategy returned.";
      }
    } catch (e) { note.textContent = "Couldn't reach the AI service."; }
    expGen.disabled = false; expGen.textContent = "✨ Suggest strategy";
  };

  const copyBtn = document.getElementById("e_copy_script");
  if (copyBtn) copyBtn.onclick = () => {
    const t = document.getElementById("e_script")?.value || "";
    navigator.clipboard?.writeText(t);
    copyBtn.textContent = "Copied ✓";
    setTimeout(() => copyBtn.textContent = "Copy", 1500);
  };

  // Client conversation notes — load existing, allow adding with author + time.
  loadClientNotes(leadId);
  const addNoteBtn = document.getElementById("e_add_note");
  if (addNoteBtn) addNoteBtn.onclick = async () => {
    const box = document.getElementById("e_new_note");
    const status = document.getElementById("e_note_status");
    const text = (box?.value || "").trim();
    if (!text) { status.textContent = "Write a note first."; return; }
    addNoteBtn.disabled = true; status.textContent = "Saving…";
    const { error } = await supabaseClient.from("client_notes")
      .insert({ lead_id: leadId, note: text, created_by: currentProfile.id });
    if (error) status.textContent = "Couldn't save — " + error.message;
    else { box.value = ""; status.textContent = ""; await loadClientNotes(leadId); }
    addNoteBtn.disabled = false;
  };
}

// Loads the note log for a lead, newest first, each with author and timestamp.
// Renders the notes log (read-only) on the client profile.
async function renderProfileNotes(leadId) {
  const box = document.getElementById("profileNotes");
  if (!box) return;
  const { data } = await supabaseClient.from("client_notes")
    .select("note, created_at, created_by").eq("lead_id", leadId)
    .order("created_at", { ascending: false });
  if (!data || data.length === 0) return;   // nothing to show
  box.innerHTML = `
    <h3 style="font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--gold-600); margin:0 0 8px;">Client conversation notes</h3>
    ${data.map(n => `
      <div style="background:#f4f6fa; border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:8px;">
        <div style="font-size:13px; color:var(--navy-900); white-space:pre-wrap; line-height:1.5;">${(n.note || "").replace(/</g, "&lt;")}</div>
        <div style="font-size:11px; color:var(--ink-faint); margin-top:5px;">${agentName(n.created_by)} · ${new Date(n.created_at).toLocaleString()}</div>
      </div>`).join("")}`;
}

async function loadClientNotes(leadId) {
  const list = document.getElementById("e_notes_list");
  if (!list) return;
  const { data, error } = await supabaseClient.from("client_notes")
    .select("note, created_at, created_by").eq("lead_id", leadId)
    .order("created_at", { ascending: false });
  if (error) { list.innerHTML = '<div style="font-size:12.5px; color:var(--ink-faint);">Couldn\'t load notes.</div>'; return; }
  if (!data || data.length === 0) {
    list.innerHTML = '<div style="font-size:12.5px; color:var(--ink-faint);">No notes yet. Add the first one below.</div>';
    return;
  }
  list.innerHTML = data.map(n => `
    <div style="background:#f4f6fa; border:1px solid var(--line); border-radius:8px; padding:10px 12px;">
      <div style="font-size:13px; color:var(--navy-900); white-space:pre-wrap; line-height:1.5;">${(n.note || "").replace(/</g, "&lt;")}</div>
      <div style="font-size:11px; color:var(--ink-faint); margin-top:5px;">
        ${agentName(n.created_by)} · ${new Date(n.created_at).toLocaleString()}</div>
    </div>`).join("");
}

// Keeps the payment editor's add/remove working after any re-render.
function wirePaymentEditor(leadId) {
  const add = document.getElementById("epAdd");
  const rowsBox = document.getElementById("epRows");
  if (!rowsBox) return;

  const bindRemovers = () => {
    rowsBox.querySelectorAll(".ep-remove").forEach(b => b.onclick = () => {
      b.closest(".ep-row").remove();
    });
  };
  bindRemovers();

  if (add) add.onclick = () => {
    const i = "new" + Date.now();  // unique id for the fresh row
    const div = document.createElement("div");
    div.className = "ep-row";
    div.dataset.row = i;
    div.style.cssText = "display:grid; grid-template-columns:28px 1fr 1fr 1fr auto 34px; gap:8px; align-items:end; margin-bottom:8px;";
    div.innerHTML = `
      <div style="font-size:12px; font-weight:700; color:var(--ink-faint); padding-bottom:9px;">+</div>
      ${editField("Date", `ep_date_${i}`, "", "date")}
      ${editField("Amount", `ep_amt_${i}`, 0, "number")}
      ${editSelect("Method", `ep_method_${i}`, "", ["", ...METHOD_OPTIONS])}
      <div style="padding-bottom:6px;">
        <label style="display:block; font-size:11px; letter-spacing:.03em; text-transform:uppercase; color:var(--ink-faint); margin-bottom:3px;">Proof of payment</label>
        <input type="file" id="ep_receipt_${i}" class="ep-receipt" data-existing=""
          accept="image/*,application/pdf" style="font-size:11px; max-width:150px;">
      </div>
      <button type="button" class="ep-remove" style="padding-bottom:9px; background:none; border:none; color:#b42318; font-size:18px; cursor:pointer;">&times;</button>`;
    rowsBox.appendChild(div);
    bindRemovers();
  };
}

async function saveProfileEdits(leadId) {
  const lead = allLeadsCache.find(x => x.id === leadId);
  if (!lead || !canEditLead(lead)) return;

  const btn = document.getElementById("editSave");
  const err = document.getElementById("editError");
  const v = id => { const el = document.getElementById(id); return el && el.value !== "" ? el.value : null; };
  const num = id => Number(document.getElementById(id)?.value) || 0;

  const name = v("e_fullname");
  if (!name) {
    err.textContent = "A client needs a name.";
    err.style.display = "block";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Saving…";
  err.style.display = "none";

  // Rebuild payments from the rows on screen — including any the user added
  // or removed — carrying each receipt path across untouched.
  const payments = await collectPaymentRows(lead.payments || []);

  const owner = document.getElementById("e_consultant")?.value || lead.agent_id;

  const patch = {
    client_full_name: name,
    client_email: v("e_email"),
    client_mobile: v("e_mobile"),
    inquiry_date: v("e_inquiry_date"),
    inquiry_time: v("e_inquiry_time"),
    agent_id: owner,
    assigned_consultant: owner,
    emergency_contact_name: v("e_emg_name"),
    emergency_contact_phone: v("e_emg_phone"),
    client_address: v("e_address"),
    package_destination: v("e_destination"),
    travel_date: v("e_travel_date"),
    departure_id: document.getElementById("e_departure")?.value || null,
    travelers: Number(document.getElementById("e_travelers")?.value) || 1,
    visa_status: v("e_visa_status"),
    lead_source: v("e_lead_source"),
    deal_value: num("e_deal_value"),
    journey_stage: v("e_stage"),
    lead_temperature: v("e_temperature"),
    decision_status: v("e_decision"),
    next_followup: v("e_followup"),
    concern: v("e_concern"),
    closing_strategy: v("e_strategy"),
    remarks: v("e_remarks"),   // agent-only; never auto-filled from the transcript
    transcript_meta: (document.getElementById("e_tx_meta")?.value || "").trim() || null,
    transcript_viber: (document.getElementById("e_tx_viber")?.value || "").trim() || null,
    transcript_phone: (document.getElementById("e_tx_phone")?.value || "").trim() || null,
    suggested_script: (document.getElementById("e_script")?.value || "").trim() || null,
    ai_lead_score: (function () { const v = document.getElementById("e_ai_score")?.value; return v === "" || v == null ? null : Number(v); })(),
    awaiting_reply: !!document.getElementById("e_awaiting")?.checked,
    transcript_updated_at: new Date().toISOString(),
    booking_reference: v("e_booking_ref"),
    payments,
    visa_service_availed: v("e_visa_availed"),
    visa_service_fee: num("e_visa_fee"),
    visa_service_discount: num("e_visa_discount"),
    applied_discounts: v("e_discounts"),
    special_freebies: v("e_freebies"),
    special_requests: v("e_requests"),
    preferred_airline: v("e_airline"),
    seat_preference: v("e_seat"),
    meal_preference: v("e_meal"),
    room_preference: v("e_room"),
    traveler_preferences: v("e_preferences"),
    optional_tours: v("e_tours"),
    optional_services: v("e_services"),
    // Audit trail: record who made this edit. updated_at is set by the DB
    // trigger; this adds the "who".
    updated_by: currentProfile.id,
    updated_at: new Date().toISOString(),
  };

  // Transcription encoder: record WHO first entered a transcript and WHEN,
  // based on the logged-in user. Only stamps if a transcript is present now
  // and no encoder was recorded before — so the original encoder is kept
  // even if someone else edits the lead later.
  const hasTx = !!(patch.transcript_meta || patch.transcript_viber || patch.transcript_phone);
  if (hasTx && !lead.transcript_entered_by) {
    patch.transcript_entered_by = currentProfile.id;
    patch.transcript_entered_at = new Date().toISOString();
  }

  // UPDATE, pinned to this one row. Never an insert — that would duplicate
  // the client instead of correcting them.
  const { error } = await supabaseClient.from("leads").update(patch).eq("id", leadId);

  if (error) {
    err.textContent = "Couldn't save — " + error.message;
    err.style.display = "block";
    btn.disabled = false;
    btn.textContent = "Save changes";
    return;
  }

  // Patch the cached copy directly rather than re-downloading every lead,
  // which is what made saving an edit feel slow.
  const idx = allLeadsCache.findIndex(l => l.id === leadId);
  if (idx !== -1) allLeadsCache[idx] = { ...allLeadsCache[idx], ...patch };

  // Activity log: record every meaningful change as its own reviewable row —
  // who (logged-in user), which field, old value -> new value, when. Only the
  // key fields are logged to keep the history readable. Fire-and-forget: a log
  // failure must never block or undo the save the user just made.
  try {
    const LOGGED_FIELDS = {
      client_full_name: "Client name", client_email: "Email", client_mobile: "Mobile",
      package_destination: "Package", travel_date: "Travel date", journey_stage: "Stage",
      lead_temperature: "Status", decision_status: "Decision", deal_value: "Deal value",
      agent_id: "Assigned to", departure_id: "Departure", visa_status: "Visa status",
      next_followup: "Next follow-up", booking_reference: "Booking ref",
      concern: "Concern", closing_strategy: "Closing strategy", awaiting_reply: "Awaiting reply",
      transcript_meta: "Messenger transcript", transcript_viber: "Viber transcript",
      transcript_phone: "Phone transcript", suggested_script: "Suggested script",
    };
    const norm = (x) => (x === null || x === undefined) ? "" : String(x);
    const shorten = (s) => { s = norm(s); return s.length > 300 ? s.slice(0, 300) + "…" : s; };
    const logs = [];
    for (const [key, label] of Object.entries(LOGGED_FIELDS)) {
      if (!(key in patch)) continue;
      if (norm(lead[key]) === norm(patch[key])) continue;   // unchanged
      logs.push({
        lead_id: leadId,
        actor_id: currentProfile.id,
        actor_name: currentProfile.full_name || "",
        action: "edit",
        field: label,
        old_value: shorten(lead[key]),
        new_value: shorten(patch[key]),
      });
    }
    if (logs.length) supabaseClient.from("activity_log").insert(logs).then(() => {}, () => {});
  } catch (_) { /* logging must never break saving */ }
  await loadDepartures();
  renderAll();
  openClientProfile(leadId);   // back to the read-only view, now updated
}

// ---------- Slots Tracker ----------
// Departures are entered by hand — route, dates and seats are facts, not
// something to infer from lead data. Occupancy is then counted from the
// clients placed on each departure.
let allDeparturesCache = [];
let slotSearch = "";
let slotMonth = "";
let slotStatus = "all";
let openDepartureId = null;

// A seat is only taken once a client is reserving or booked. An inquiry
// isn't a seat — counting it would show trips as full that have sold nothing.
const SEAT_TAKING_STAGES = ["Reservation / Payment Processing", "Successfully Booked"];

async function loadDepartures() {
  const { data, error } = await supabaseClient
    .from("departures")
    .select("*")
    .order("start_date");
  allDeparturesCache = (!error && data) ? data : [];
}

function departureLeads(depId) {
  return allLeadsCache.filter(l => l.departure_id === depId);
}

function departureStats(d) {
  const leads = departureLeads(d.id);
  const seated = leads.filter(l => SEAT_TAKING_STAGES.includes(l.journey_stage));
  const occupied = seated.reduce((s, l) => s + (Number(l.travelers) || 0), 0);
  const available = d.capacity - occupied;
  const revenue = seated.reduce((s, l) => s + (Number(l.deal_value) || 0), 0);
  const paid = seated.reduce((s, l) => s + leadPaid(l), 0);
  const paidPct = revenue > 0 ? Math.round((paid / revenue) * 100) : 0;

  let status = "Available";
  if (d.status_override) status = d.status_override;
  else if (available < 0) status = "Overbooked";
  else if (available === 0) status = "Full";
  else if (available <= 5) status = "Nearly Full";

  return { leads, seated, occupied, available, revenue, paid, paidPct, status };
}

const SLOT_STATUS_COLOUR = {
  "Available": "#2e8b57", "Nearly Full": "#c9a227", "Full": "#2f5596",
  "Overbooked": "#b42318", "Transfer": "#6b5bc4", "Closed": "#8a94a6", "Cancelled": "#8a94a6",
};

function slotBadge(status) {
  const c = SLOT_STATUS_COLOUR[status] || "#8a94a6";
  return `<span style="display:inline-block; padding:4px 11px; border-radius:999px; font-size:11px;
    font-weight:700; background:${c}1a; color:${c};">${status}</span>`;
}

function departureDates(d) {
  if (!d.end_date) return fmtDate(d.start_date);
  const a = new Date(d.start_date + "T00:00:00");
  const b = new Date(d.end_date + "T00:00:00");
  const sameYear = a.getFullYear() === b.getFullYear();
  const left = a.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const right = b.toLocaleDateString("en-US", sameYear
    ? { month: "short", day: "numeric", year: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
  return `${left} – ${right}`;
}

function filteredDepartures() {
  const q = slotSearch.trim().toLowerCase();
  return allDeparturesCache.filter(d => {
    if (slotMonth && String(d.start_date).slice(0, 7) !== slotMonth) return false;
    if (slotStatus !== "all" && departureStats(d).status !== slotStatus) return false;
    if (q) {
      const inRoute = (d.route || "").toLowerCase().includes(q);
      const inClients = departureLeads(d.id).some(l => (l.client_full_name || "").toLowerCase().includes(q));
      if (!inRoute && !inClients) return false;
    }
    return true;
  });
}

function canManageDepartures() {
  return currentProfile && currentProfile.role !== "agent";
}

// The nav button and the view aren't in index.html, so they're created here.
function ensureSlotsNav() {
  if (document.getElementById("view-slots")) return;

  const nav = document.getElementById("nav");
  const agentBtn = nav?.querySelector('button[data-view="agent"]');
  if (!nav || !agentBtn) return;

  const btn = document.createElement("button");
  btn.dataset.view = "slots";
  btn.textContent = "Slots Tracker";
  agentBtn.insertAdjacentElement("afterend", btn);

  const view = document.createElement("section");
  view.className = "view";
  view.id = "view-slots";
  view.innerHTML = `
    <div class="view-head">
      <div>
        <div class="eyebrow-line">Discover Group Sales OS</div>
        <h1>Slots Tracker</h1>
        <p>Monitor departures, available seats, payment status, and client allocations.</p>
      </div>
      <div class="date-pill">${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</div>
    </div>
    <div id="slotsBody"></div>`;
  document.querySelector(".main")?.appendChild(view);

  // Wire the new button into the existing nav behaviour.
  btn.addEventListener("click", () => {
    document.querySelectorAll("#nav button[data-view]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    view.classList.add("active");
    renderSlots();
  });
}

function slotStat(label, value, hint, colour) {
  return `
    <div class="stat-card">
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div class="label">${label}</div>
        <span style="width:11px; height:11px; border-radius:50%; background:${colour}; flex-shrink:0; margin-top:3px;"></span>
      </div>
      <div class="value">${value}</div>
      <div class="hint">${hint}</div>
    </div>`;
}

function renderSlots() {
  const body = document.getElementById("slotsBody");
  if (!body) return;

  const list = filteredDepartures();
  const all = allDeparturesCache;
  // The stat cards reflect whatever is currently filtered, so they always
  // match the table beneath them.
  const shown = list.map(departureStats);
  const seatsAvailable = shown.reduce((s, t) => s + Math.max(t.available, 0), 0);
  const nearlyFull = shown.filter(t => t.status === "Nearly Full").length;
  const overbooked = shown.filter(t => t.status === "Overbooked").length;
  const totalRevenue = shown.reduce((s, t) => s + t.revenue, 0);
  const totalCollected = shown.reduce((s, t) => s + t.paid, 0);
  const isFiltered = list.length !== all.length;

  const months = [...new Set(all.map(d => String(d.start_date).slice(0, 7)))].sort();
  const th = "padding:10px 12px; text-align:left; font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-faint); border-bottom:1px solid var(--line); white-space:nowrap;";
  const td = "padding:14px 12px; font-size:13px; border-bottom:1px solid rgba(0,0,0,.05); color:var(--ink-soft);";

  const unassigned = allLeadsCache.filter(l => !l.departure_id).length;

  body.innerHTML = `
    <div class="stat-grid" style="grid-template-columns:repeat(5,1fr);">
      ${slotStat(isFiltered ? "Departures Shown" : "Total Departures", list.length, isFiltered ? `of ${all.length} total` : "On the schedule", "#4a6fb5")}
      ${slotStat("Seats Available", seatsAvailable, "Across shown routes", "#2e8b57")}
      ${slotStat("Nearly Full", nearlyFull, "5 seats or fewer", "#c9a227")}
      ${slotStat("Overbooked", overbooked, "Needs immediate action", "#b42318")}
      ${slotStat("Total Revenue", shortCurrency(totalRevenue),
        totalCollected > 0 ? currency(totalCollected) + " collected" : (isFiltered ? "for shown departures" : "booked value, all departures"),
        "#6b5bc4")}
    </div>

    <div style="margin:14px 0 0; padding:12px 16px; background:#f4f6fa; border:1px solid var(--line);
      border-radius:10px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
      <span style="font-size:13px; color:var(--ink-soft);">
        ${isFiltered ? "Filtered total" : "Grand total"} — ${list.length} departure${list.length === 1 ? "" : "s"},
        ${shown.reduce((s, t) => s + t.occupied, 0)} seats taken
      </span>
      <span style="font-size:18px; font-weight:800; color:var(--navy-900);">${currency(totalRevenue)}</span>
    </div>

    <div class="card">
      <div class="card-title-row" style="align-items:flex-start;">
        <div>
          <h2>Departure Inventory</h2>
          <p>One row per departure. Open a departure to see the clients on it.</p>
        </div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <input id="slotSearch" type="search" placeholder="Search route or client" value="${slotSearch.replace(/"/g, "&quot;")}"
            style="padding:8px 13px; border:1px solid var(--line); border-radius:8px; font-size:13px; font-family:inherit; min-width:190px;">
          <select id="slotMonth" style="padding:8px 12px; border:1px solid var(--line); border-radius:8px; font-size:13px; font-family:inherit; background:#fff;">
            <option value="">Month: All</option>
            ${months.map(m => `<option value="${m}" ${m === slotMonth ? "selected" : ""}>
              ${new Date(m + "-01T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" })}</option>`).join("")}
          </select>
          <select id="slotStatus" style="padding:8px 12px; border:1px solid var(--line); border-radius:8px; font-size:13px; font-family:inherit; background:#fff;">
            ${["all", "Available", "Nearly Full", "Full", "Overbooked", "Transfer", "Closed", "Cancelled"]
              .map(s => `<option value="${s}" ${s === slotStatus ? "selected" : ""}>${s === "all" ? "Status: All" : s}</option>`).join("")}
          </select>
          <button id="slotExport" class="pill" type="button">↓ Export</button>
          ${canManageDepartures() ? `
            <button id="slotAdd" type="button" style="padding:8px 15px; border:none; border-radius:8px;
              background:var(--navy-900); color:#fff; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit;">
              + Add Departure</button>` : ""}
        </div>
      </div>

      ${all.length === 0 ? `
        <div class="registry-empty" style="padding:40px 20px;">
          No departures yet.${canManageDepartures()
            ? ' Click <strong>+ Add Departure</strong> to put the first trip on the schedule.'
            : " An admin needs to add them."}
        </div>` : list.length === 0 ? `
        <div class="registry-empty">No departures match these filters.</div>` : `
        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; min-width:940px;">
            <thead><tr>
              <th style="${th}">Route</th>
              <th style="${th}">Travel date</th>
              <th style="${th} text-align:center;">Capacity</th>
              <th style="${th} text-align:center;">Occupied</th>
              <th style="${th} text-align:center;">Available</th>
              <th style="${th}">Status</th>
              <th style="${th} text-align:right;">Revenue</th>
              <th style="${th} text-align:right;">Payment</th>
              <th style="${th}">Action</th>
            </tr></thead>
            <tbody>
              ${list.map(d => {
                const s = departureStats(d);
                return `
                  <tr>
                    <td style="${td} font-weight:700; color:var(--navy-900);">${d.route}</td>
                    <td style="${td}">${departureDates(d)}</td>
                    <td style="${td} text-align:center;">${d.capacity}</td>
                    <td style="${td} text-align:center;">${s.occupied}</td>
                    <td style="${td} text-align:center; font-weight:700; color:${s.available < 0 ? FLAG_RED : "var(--navy-900)"};">${s.available}</td>
                    <td style="${td}">${slotBadge(s.status)}</td>
                    <td style="${td} text-align:right;">${s.revenue ? shortCurrency(s.revenue) : "₱0"}</td>
                    <td style="${td} text-align:right;">${s.revenue ? s.paidPct + "% Paid" : "—"}</td>
                    <td style="${td}">
                      <button class="slot-view" data-dep="${d.id}" type="button"
                        style="padding:6px 12px; border:1px solid var(--line); border-radius:7px; background:#fff;
                        font-size:12px; font-weight:600; color:var(--navy-900); cursor:pointer; font-family:inherit;">View Details</button>
                    </td>
                  </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>`}

      ${unassigned > 0 ? `
        <div style="margin-top:16px; padding:12px 14px; background:#f4f6fa; border:1px solid var(--line);
          border-radius:10px; font-size:12.5px; color:var(--ink-soft);">
          <strong style="color:var(--navy-900);">${unassigned}</strong> client${unassigned === 1 ? " is" : "s are"} not on any departure yet.
          Open a client, choose <strong>Edit profile</strong>, and pick their departure — they'll be counted here once they are.
        </div>` : ""}
    </div>`;

  document.getElementById("slotSearch")?.addEventListener("input", (e) => {
    slotSearch = e.target.value;
    renderSlots();
    const el = document.getElementById("slotSearch");
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  });
  document.getElementById("slotMonth")?.addEventListener("change", (e) => { slotMonth = e.target.value; renderSlots(); });
  document.getElementById("slotStatus")?.addEventListener("change", (e) => { slotStatus = e.target.value; renderSlots(); });
  document.getElementById("slotAdd")?.addEventListener("click", () => departureForm(null));
  document.getElementById("slotExport")?.addEventListener("click", (e) => exportDeparturesExcel(e.target));
  body.querySelectorAll(".slot-view").forEach(b =>
    b.addEventListener("click", () => openDeparture(b.dataset.dep)));
}

async function exportDeparturesExcel(btn) {
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Preparing…";
  try {
    const XLSX = await loadXlsx();
    const rows = filteredDepartures().map(d => {
      const s = departureStats(d);
      return {
        "Route": d.route,
        "Start date": fmtDate(d.start_date),
        "End date": d.end_date ? fmtDate(d.end_date) : "",
        "Capacity": d.capacity,
        "Occupied": s.occupied,
        "Available": s.available,
        "Status": s.status,
        "Clients": s.seated.length,
        "Revenue": s.revenue,
        "Paid": s.paid,
        "Payment %": s.paidPct,
        "Notes": d.notes || "",
      };
    });
    if (rows.length === 0) { btn.textContent = "Nothing to export"; setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 1600); return; }
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
                   { wch: 14 }, { wch: 9 }, { wch: 14 }, { wch: 14 }, { wch: 11 }, { wch: 30 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Departures");
    XLSX.writeFile(wb, `discover-group-departures-${new Date().toISOString().slice(0, 10)}.xlsx`);
    btn.textContent = `Exported ${rows.length}`;
  } catch (e) {
    btn.textContent = "Export failed";
    console.error(e);
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 1600);
}

// ---------- Adding and editing a departure ----------
function departureForm(dep) {
  if (!canManageDepartures()) return;
  const editing = !!dep;

  let ov = document.getElementById("depFormOverlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "depFormOverlay";
    ov.style.cssText = `position:fixed; inset:0; background:rgba(8,18,38,.55); z-index:10000;
      display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:40px 20px;`;
    document.body.appendChild(ov);
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.style.display = "none"; });
  }

  ov.innerHTML = `
    <div style="background:#fff; border-radius:16px; max-width:620px; width:100%; padding:26px 28px 30px;
      box-shadow:0 24px 60px rgba(0,0,0,.3);">
      <h2 style="margin:0 0 4px; font-size:20px; color:var(--navy-900);">${editing ? "Edit departure" : "Add a departure"}</h2>
      <p style="margin:0 0 18px; font-size:13px; color:var(--ink-soft);">Route, dates and seats. Clients are placed on it afterwards.</p>

      <div id="depError" style="display:none; margin-bottom:12px; padding:10px 12px; background:#fdecea;
        border:1px solid ${FLAG_RED}; border-radius:8px; font-size:13px; color:${FLAG_RED};"></div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px 16px;">
        <div style="grid-column:1 / -1;">
          <label style="display:block; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--ink-faint); margin-bottom:4px;">Route name</label>
          <input id="d_route" type="text" value="${(dep?.route || "").replace(/"/g, "&quot;")}" placeholder="e.g. Route N Deluxe"
            style="width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; font-size:13.5px; font-family:inherit;">
        </div>
        <div>
          <label style="display:block; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--ink-faint); margin-bottom:4px;">Departure date</label>
          <input id="d_start" type="date" value="${dep?.start_date || ""}"
            style="width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; font-size:13.5px; font-family:inherit;">
        </div>
        <div>
          <label style="display:block; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--ink-faint); margin-bottom:4px;">Return date (optional)</label>
          <input id="d_end" type="date" value="${dep?.end_date || ""}"
            style="width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; font-size:13.5px; font-family:inherit;">
        </div>
        <div>
          <label style="display:block; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--ink-faint); margin-bottom:4px;">Seats</label>
          <input id="d_capacity" type="number" min="1" value="${dep?.capacity ?? 40}"
            style="width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; font-size:13.5px; font-family:inherit;">
        </div>
        <div>
          <label style="display:block; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--ink-faint); margin-bottom:4px;">Status override</label>
          <select id="d_override" style="width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; font-size:13.5px; font-family:inherit; background:#fff;">
            ${["", "Transfer", "Closed", "Cancelled"].map(o =>
              `<option value="${o}" ${o === (dep?.status_override || "") ? "selected" : ""}>${o || "Calculate automatically"}</option>`).join("")}
          </select>
        </div>
        <div style="grid-column:1 / -1;">
          <label style="display:block; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--ink-faint); margin-bottom:4px;">Notes</label>
          <textarea id="d_notes" rows="2" style="width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; font-size:13.5px; font-family:inherit; resize:vertical;">${dep?.notes || ""}</textarea>
        </div>
      </div>

      <div style="display:flex; gap:10px; margin-top:22px;">
        <button type="button" id="depSave" style="padding:10px 20px; border:none; border-radius:8px;
          background:var(--navy-900); color:#fff; font-size:13px; font-weight:700; cursor:pointer; font-family:inherit;">
          ${editing ? "Save changes" : "Add departure"}</button>
        <button type="button" id="depCancel" style="padding:10px 18px; border:1px solid var(--line); border-radius:8px;
          background:#fff; font-size:13px; font-weight:700; color:var(--navy-900); cursor:pointer; font-family:inherit;">Cancel</button>
      </div>
    </div>`;

  ov.style.display = "flex";
  document.getElementById("depCancel").onclick = () => { ov.style.display = "none"; };
  document.getElementById("depSave").onclick = () => saveDeparture(dep?.id || null, ov);
}

async function saveDeparture(depId, ov) {
  const err = document.getElementById("depError");
  const btn = document.getElementById("depSave");
  const route = document.getElementById("d_route").value.trim();
  const start = document.getElementById("d_start").value;
  const end = document.getElementById("d_end").value || null;
  const capacity = Number(document.getElementById("d_capacity").value) || 0;

  const fail = msg => { err.textContent = msg; err.style.display = "block"; };

  if (!route) return fail("Give the departure a route name.");
  if (!start) return fail("A departure needs a date.");
  if (capacity < 1) return fail("Seats must be at least 1.");
  if (end && end < start) return fail("The return date can't be before the departure date.");
  if (dateLooksWrong(start) || (end && dateLooksWrong(end))) {
    return fail("That date's year looks wrong — check it before saving.");
  }

  btn.disabled = true;
  btn.textContent = "Saving…";
  err.style.display = "none";

  const payload = {
    route, start_date: start, end_date: end, capacity,
    status_override: document.getElementById("d_override").value || null,
    notes: document.getElementById("d_notes").value.trim() || null,
  };

  const { error } = depId
    ? await supabaseClient.from("departures").update({ ...payload, updated_by: currentProfile.id }).eq("id", depId)
    : await supabaseClient.from("departures").insert({ ...payload, created_by: currentProfile.id });

  if (error) {
    fail("Couldn't save — " + error.message);
    btn.disabled = false;
    btn.textContent = depId ? "Save changes" : "Add departure";
    return;
  }

  await loadDepartures();
  ov.style.display = "none";
  renderSlots();
}

// ---------- One departure's clients ----------
function openDeparture(depId) {
  const d = allDeparturesCache.find(x => x.id === depId);
  if (!d) return;
  const s = departureStats(d);
  openDepartureId = depId;

  let ov = document.getElementById("depDrawer");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "depDrawer";
    ov.style.cssText = `position:fixed; inset:0; background:rgba(8,18,38,.55); z-index:9998;
      display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:32px 20px;`;
    document.body.appendChild(ov);
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.style.display = "none"; });
  }

  const th = "padding:9px 10px; text-align:left; font-size:10.5px; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-faint); border-bottom:1px solid var(--line);";
  const td = "padding:11px 10px; font-size:13px; border-bottom:1px solid rgba(0,0,0,.05); color:var(--ink-soft);";

  // Everyone on the trip, including those still deciding — they're not a seat
  // yet, but the consultant needs to see them.
  const rows = s.leads.sort((a, b) => (b.travelers || 0) - (a.travelers || 0));

  ov.innerHTML = `
    <div style="background:#fff; border-radius:16px; max-width:1000px; width:100%; padding:26px 28px 30px;
      box-shadow:0 24px 60px rgba(0,0,0,.3);">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px;">
        <div>
          <div style="font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--gold-600); font-weight:700;">Departure</div>
          <h2 style="margin:4px 0 6px; font-size:23px; color:var(--navy-900);">${d.route}</h2>
          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
            ${slotBadge(s.status)}
            <span style="font-size:13px; color:var(--ink-soft);">${departureDates(d)}</span>
          </div>
        </div>
        <button type="button" id="depDrawerX" style="background:none; border:none; font-size:24px; color:var(--ink-faint); cursor:pointer;">&times;</button>
      </div>

      <div style="display:grid; grid-template-columns:repeat(5,1fr); gap:12px; margin-top:20px;">
        ${[["Capacity", d.capacity], ["Occupied", s.occupied],
           ["Available", s.available], ["Revenue", currency(s.revenue)],
           ["Collected", currency(s.paid) + (s.revenue ? ` · ${s.paidPct}%` : "")]]
          .map(([k, v]) => `
            <div style="background:#f4f6fa; border-radius:10px; padding:12px 14px;">
              <div style="font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--ink-faint);">${k}</div>
              <div style="font-size:17px; font-weight:800; color:${k === "Available" && s.available < 0 ? FLAG_RED : "var(--navy-900)"};">${v}</div>
            </div>`).join("")}
      </div>

      ${d.notes ? `<div style="margin-top:14px; font-size:12.5px; color:var(--ink-soft);"><strong>Notes:</strong> ${d.notes}</div>` : ""}

      <h3 style="margin:22px 0 10px; font-size:15px; color:var(--navy-900);">Clients on this departure (${rows.length})</h3>
      ${rows.length === 0 ? `
        <div class="registry-empty">Nobody is on this departure yet. Open a client, choose Edit profile, and pick this departure.</div>` : `
        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; min-width:760px;">
            <thead><tr>
              <th style="${th}">Client</th><th style="${th} text-align:center;">Pax</th>
              <th style="${th}">Stage</th><th style="${th}">Consultant</th>
              <th style="${th} text-align:right;">Deal value</th><th style="${th} text-align:right;">Paid</th>
              <th style="${th} text-align:right;">Balance</th><th style="${th}"></th>
            </tr></thead>
            <tbody>
              ${rows.map(l => {
                const paid = leadPaid(l);
                const val = Number(l.deal_value) || 0;
                const seat = SEAT_TAKING_STAGES.includes(l.journey_stage);
                return `
                  <tr style="${seat ? "" : "opacity:.62;"}">
                    <td style="${td} font-weight:600; color:var(--navy-900);">${l.client_full_name || "Unnamed"}</td>
                    <td style="${td} text-align:center;">${Number(l.travelers) || 0}</td>
                    <td style="${td}">${l.journey_stage || "—"}${seat ? "" : '<div style="font-size:10.5px; color:var(--ink-faint);">not holding a seat</div>'}</td>
                    <td style="${td}">${agentName(l.agent_id)}</td>
                    <td style="${td} text-align:right;">${currency(val)}</td>
                    <td style="${td} text-align:right;">${currency(paid)}</td>
                    <td style="${td} text-align:right; font-weight:600;">${currency(Math.max(val - paid, 0))}</td>
                    <td style="${td}"><button class="dep-client" data-lead="${l.id}" type="button"
                      style="padding:5px 11px; border:1px solid var(--line); border-radius:6px; background:#fff;
                      font-size:12px; font-weight:600; color:var(--navy-900); cursor:pointer; font-family:inherit;">${canEditLead(l) ? "Edit" : "Open"}</button></td>
                  </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>`}

      <div style="display:flex; gap:10px; margin-top:22px; padding-top:16px; border-top:1px solid var(--line);">
        ${canManageDepartures() ? `
          <button type="button" id="depEdit" style="padding:10px 18px; border:none; border-radius:8px;
            background:var(--gold-600); color:#fff; font-size:13px; font-weight:700; cursor:pointer; font-family:inherit;">Edit departure</button>` : ""}
        <button type="button" id="depDrawerClose" style="padding:10px 18px; border:1px solid var(--line); border-radius:8px;
          background:#fff; font-size:13px; font-weight:700; color:var(--navy-900); cursor:pointer; font-family:inherit;">Close</button>
      </div>
    </div>`;

  ov.style.display = "flex";
  const close = () => { ov.style.display = "none"; openDepartureId = null; };
  document.getElementById("depDrawerX").onclick = close;
  document.getElementById("depDrawerClose").onclick = close;
  const de = document.getElementById("depEdit");
  if (de) de.onclick = () => { close(); departureForm(d); };
  ov.querySelectorAll(".dep-client").forEach(b => b.addEventListener("click", () => {
    const leadId = b.dataset.lead;
    const lead = allLeadsCache.find(l => l.id === leadId);
    close();
    // Straight into the edit form for anyone allowed to edit; otherwise the
    // read-only profile. Editing here updates the same record — it can't
    // create a duplicate.
    if (lead && canEditLead(lead)) editClientProfile(leadId);
    else openClientProfile(leadId);
  }));
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
let leadTempFilter = "all";   // all | hot | warm | cold | none
let leadTranscriptFilter = "all";  // all | transcribed | untranscribed | unanswered
let leadSort = { key: "inquiry", dir: "desc" };
let leadPage = 1;
const LEADS_PER_PAGE = 25;

function filteredLeads() {
  const { from, to } = dateInputs("view-leads");
  const range = rangeFor(currentLeadFilter, from, to);
  // Slots-sheet clients are historical closed sales that live in the Slots
  // Tracker. The Leads Tracker is for current inquiries the team is working,
  // so those imports are kept out of it. Leads at "Reservation / Payment
  // Processing" have moved into the Slots Tracker, so they're hidden from the
  // working leads list too — the rows still exist and still feed the Slots
  // Tracker. (Successfully Booked leads are intentionally left visible here.)
  let leads = allLeadsCache.filter(l =>
    !isSlotsImport(l)
    && l.journey_stage !== "Reservation / Payment Processing"
    && inRange(leadDate(l), range));

  if (leadAgentFilter !== "all") {
    leads = leads.filter(l => l.agent_id === leadAgentFilter);
  }

  if (leadTempFilter !== "all") {
    leads = leads.filter(l => {
      const t = (l.lead_temperature || "").toLowerCase();
      if (leadTempFilter === "none") return !t;
      return t.startsWith(leadTempFilter);
    });
  }

  if (leadTranscriptFilter !== "all") {
    leads = leads.filter(l => {
      const has = hasTranscript(l);
      if (leadTranscriptFilter === "transcribed") return has;
      if (leadTranscriptFilter === "untranscribed") return !has;
      if (leadTranscriptFilter === "unanswered") return !!l.awaiting_reply;
      return true;
    });
  }

  const q = leadSearch.trim().toLowerCase();
  if (q) {
    leads = leads.filter(l =>
      [l.client_full_name, l.client_email, l.client_mobile, l.package_destination, l.remarks, agentName(l.agent_id)]
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

// ---------- Data quality flags ----------
// Nothing here changes a record. It marks values that look wrong so the
// person who entered them can decide — a travel date in the year 0001 is
// almost certainly a half-typed year, but only the agent knows what it
// should have been.
function dateLooksWrong(value) {
  if (!value) return false;
  const d = value.length <= 10 ? new Date(value + "T00:00:00") : new Date(value);
  if (isNaN(d)) return true;
  const y = d.getFullYear();
  return y < 2000 || y > 2100;
}

// Everything suspect about one lead, in plain words.
function leadProblems(l) {
  const out = [];
  if (dateLooksWrong(l.travel_date)) out.push("Travel date looks wrong — the year didn't save");
  if (dateLooksWrong(l.inquiry_date)) out.push("Inquiry date looks wrong — the year didn't save");
  if (dateLooksWrong(l.next_followup)) out.push("Follow-up date looks wrong");
  if (l.travel_date && l.inquiry_date && !dateLooksWrong(l.travel_date) && !dateLooksWrong(l.inquiry_date)
      && new Date(l.travel_date) < new Date(l.inquiry_date)) {
    out.push("Travel date is before the inquiry date");
  }
  if (isDuplicateLead(l)) out.push("Possible duplicate — same name or email as another lead. Not deleted; please review.");
  return out;
}

// A lead is a possible duplicate if another lead (not the slots import, not
// itself) shares its name or email. Nothing is deleted — this only flags.
let _dupNameMap = null, _dupEmailMap = null;
function rebuildDuplicateIndex() {
  _dupNameMap = new Map();
  _dupEmailMap = new Map();
  for (const l of allLeadsCache) {
    if (isSlotsImport(l)) continue;
    const nm = (l.client_full_name || "").trim().toLowerCase();
    const em = (l.client_email || "").trim().toLowerCase();
    if (nm) _dupNameMap.set(nm, (_dupNameMap.get(nm) || 0) + 1);
    if (em && em !== "n/a") _dupEmailMap.set(em, (_dupEmailMap.get(em) || 0) + 1);
  }
}
function isDuplicateLead(l) {
  if (isSlotsImport(l)) return false;
  if (!_dupNameMap) rebuildDuplicateIndex();
  const nm = (l.client_full_name || "").trim().toLowerCase();
  const em = (l.client_email || "").trim().toLowerCase();
  if (nm && (_dupNameMap.get(nm) || 0) > 1) return true;
  if (em && em !== "n/a" && (_dupEmailMap.get(em) || 0) > 1) return true;
  return false;
}

const FLAG_RED = "#b42318";

// A date for display, in red with a warning if it doesn't look right.
function fmtDateFlagged(value) {
  if (!dateLooksWrong(value)) return fmtDate(value);
  const raw = String(value).slice(0, 10);
  return `<span style="color:${FLAG_RED}; font-weight:700;" title="This date looks wrong — please correct it">⚠ ${raw}</span>`;
}

function fmtDate(value) {
  if (!value) return "—";
  const d = value.length <= 10 ? new Date(value + "T00:00:00") : new Date(value);
  return isNaN(d) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ---------- Exporting to Excel ----------
// SheetJS is fetched only when someone actually exports, so it costs nothing
// on a normal page load.
let xlsxLoading = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxLoading) {
    xlsxLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => { xlsxLoading = null; reject(new Error("no library")); };
      document.head.appendChild(s);
    });
  }
  return xlsxLoading;
}

function leadToRow(l) {
  const paid = leadPaid(l);
  const value = Number(l.deal_value) || 0;
  return {
    "Date of inquiry": fmtDate(l.inquiry_date || l.created_at),
    "Client's name": l.client_full_name || "",
    "Travel date": l.travel_date ? fmtDate(l.travel_date) : "",
    // Kept as real numbers, not text, so Excel can total the columns.
    "No. of persons": Number(l.travelers) || 0,
    "Contact no.": l.client_mobile || "",
    "Email": l.client_email || "",
    "Agent": agentName(l.agent_id),
    "Package": l.package_destination || "",
    "Stage": l.journey_stage || "",
    "Lead temperature": l.lead_temperature || "",
    "Deal value": value,
    "Paid": paid,
    "Balance": Math.max(value - paid, 0),
    "Next follow-up": l.next_followup ? fmtDate(l.next_followup) : "",
    "Booking reference": l.booking_reference || "",
  };
}

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function exportLeadsExcel(rows, label, btn) {
  const original = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = "Preparing…"; }

  try {
    const XLSX = await loadXlsx();
    if (rows.length === 0) {
      if (btn) { btn.textContent = "Nothing to export"; setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 1600); }
      return;
    }

    const data = rows.map(leadToRow);
    const ws = XLSX.utils.json_to_sheet(data);
    ws["!cols"] = [
      { wch: 14 }, { wch: 26 }, { wch: 14 }, { wch: 13 }, { wch: 16 }, { wch: 26 },
      { wch: 22 }, { wch: 20 }, { wch: 26 }, { wch: 30 }, { wch: 13 }, { wch: 13 },
      { wch: 13 }, { wch: 14 }, { wch: 18 },
    ];
    ws["!autofilter"] = { ref: ws["!ref"] };

    const wb = XLSX.utils.book_new();
    // Sheet names can't exceed 31 characters or Excel refuses to open it.
    XLSX.utils.book_append_sheet(wb, ws, String(label || "Leads").slice(0, 31));
    XLSX.writeFile(wb, `discover-group-leads-${slug(label) || "all"}-${new Date().toISOString().slice(0, 10)}.xlsx`);

    if (btn) { btn.textContent = `Exported ${rows.length}`; setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 1600); }
  } catch (e) {
    // Offline, or the CDN is blocked — say so rather than fail silently.
    if (btn) { btn.textContent = "Export failed"; setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 2200); }
    console.error("Excel export failed:", e);
  }
}

// Exports exactly what the Leads Tracker is showing — consultant filter,
// date range and search all included.
function exportTrackerExcel(btn) {
  const label = leadAgentFilter === "all" ? "All consultants" : agentName(leadAgentFilter);
  exportLeadsExcel(filteredLeads(), label, btn);
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
      <select id="leadTempSelect" style="padding:9px 14px; border:1px solid var(--line); border-radius:999px;
        font-size:13px; font-family:inherit; background:#fff; color:var(--navy-900);">
        <option value="all">All status</option>
        <option value="hot">🔴 Hot</option>
        <option value="warm">🟡 Warm</option>
        <option value="cold">🔵 Cold</option>
        <option value="none">— Not assessed</option>
      </select>
      <select id="leadTxSelect" style="padding:9px 14px; border:1px solid var(--line); border-radius:999px;
        font-size:13px; font-family:inherit; background:#fff; color:var(--navy-900);">
        <option value="all">All transcripts</option>
        <option value="transcribed">Transcribed</option>
        <option value="untranscribed">Untranscribed</option>
        <option value="unanswered">Unanswered</option>
      </select>
      <input id="leadSearchInput" type="search" placeholder="Search name, email, phone, package…"
        style="padding:9px 14px; border:1px solid var(--line); border-radius:999px; font-size:13px; min-width:210px; font-family:inherit;">
      <button id="leadExportBtn" class="pill" type="button">↓ Export to Excel</button>`;
    titleRow.appendChild(controls);

    document.getElementById("leadTempSelect").value = leadTempFilter;
    document.getElementById("leadTempSelect").addEventListener("change", (e) => {
      leadTempFilter = e.target.value;
      leadPage = 1;
      renderLeadsTable();
    });

    document.getElementById("leadTxSelect").value = leadTranscriptFilter;
    document.getElementById("leadTxSelect").addEventListener("change", (e) => {
      leadTranscriptFilter = e.target.value;
      leadPage = 1;
      renderLeadsTable();
    });

    document.getElementById("leadSearchInput").addEventListener("input", (e) => {
      leadSearch = e.target.value;
      leadPage = 1;
      renderLeadsTable();
    });
    document.getElementById("leadExportBtn").addEventListener("click", (e) => exportTrackerExcel(e.target));
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

// A stable color per agent, so each consultant reads the same everywhere.
const AGENT_DOT_COLORS = ["#4a6fb5", "#2e8b57", "#6b5bc4", "#c9a227", "#b4623b", "#2f8a8a", "#a23b8f", "#5a6b2f"];
function agentDot(agentId) {
  if (!agentId) return "#c3cad6";
  let h = 0;
  for (let i = 0; i < agentId.length; i++) h = (h * 31 + agentId.charCodeAt(i)) & 0xffff;
  return AGENT_DOT_COLORS[h % AGENT_DOT_COLORS.length];
}
function agentShort(agentId) {
  const full = agentName(agentId);
  if (!full || full === "Unassigned") return "—";
  return full.split(" ")[0];
}
// True if the lead has any conversation transcript on record, across any of
// the three channels (Messenger / Viber / Phone). Falls back to the old single
// transcript field so older records still count.
function hasTranscript(l) {
  return !!((l.transcript_meta && l.transcript_meta.trim())
    || (l.transcript_viber && l.transcript_viber.trim())
    || (l.transcript_phone && l.transcript_phone.trim())
    || (l.transcript && l.transcript.trim()));
}
function statusPill(l) {
  const t = (l.lead_temperature || "").toLowerCase();
  let label = null, c = "#8a94a6";
  if (t.startsWith("hot")) { label = "Hot"; c = "#b42318"; }
  else if (t.startsWith("warm")) { label = "Warm"; c = "#c9a227"; }
  else if (t.startsWith("cold")) { label = "Cold"; c = "#4a6fb5"; }
  // No temperature set yet (e.g. an untouched imported lead) → show a plain
  // dash, not a fabricated status.
  if (!label) return '<span style="color:var(--ink-faint);">—</span>';
  return `<span style="display:inline-block; padding:3px 11px; border-radius:999px; font-size:11.5px;
    font-weight:700; background:${c}1a; color:${c};">${label}</span>`;
}
// A 0–10 score. Uses the AI's read of the conversation when present; otherwise
// computes from stage, temperature, and whether a next step is set.
// A 0–10 score. Uses the AI's read when present. Otherwise, only computes a
// score if the lead has actually been worked (has a temperature, follow-up, or
// strategy). A brand-new untouched lead shows a dash, not a fake number.
function leadScore(l) {
  if (l.ai_lead_score != null && !isNaN(Number(l.ai_lead_score))) {
    return Number(l.ai_lead_score).toFixed(1);
  }
  const worked = l.lead_temperature || l.next_followup || l.closing_strategy
    || (l.journey_stage && l.journey_stage !== "New Inquiry");
  if (!worked) return "—";
  let score = 0;
  const stageIdx = ["New Inquiry","Discovery & Qualification","Solution Presented",
    "Decision in Progress","Strategic Nurturing","Reservation / Payment Processing",
    "Successfully Booked"].indexOf(l.journey_stage);
  if (stageIdx >= 0) score += (stageIdx / 6) * 5;
  const t = (l.lead_temperature || "").toLowerCase();
  if (t.startsWith("hot")) score += 3;
  else if (t.startsWith("warm")) score += 2;
  else if (t.startsWith("cold")) score += 1;
  if (l.next_followup) score += 1;
  if (l.closing_strategy) score += 1;
  return Math.min(10, Math.round(score * 10) / 10).toFixed(1);
}

function renderLeadsTable() {
  rebuildDuplicateIndex();
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

  // Counts across the current view (before the transcript filter narrows it),
  // so the totals stay meaningful regardless of which transcript view is active.
  const statBase = (() => {
    const saved = leadTranscriptFilter;
    leadTranscriptFilter = "all";
    const set = filteredLeads();
    leadTranscriptFilter = saved;
    return set;
  })();
  const nTranscribed = statBase.filter(l => hasTranscript(l)).length;
  const nUntranscribed = statBase.length - nTranscribed;
  const nUnanswered = statBase.filter(l => !!l.awaiting_reply).length;
  const statCard = (label, val, color) => `
    <div style="flex:1; min-width:120px; background:#fff; border:1px solid var(--line); border-radius:10px; padding:10px 14px;">
      <div style="font-size:22px; font-weight:800; color:${color};">${val}</div>
      <div style="font-size:11.5px; letter-spacing:.04em; text-transform:uppercase; color:var(--ink-faint);">${label}</div>
    </div>`;
  const statsRow = `
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin:0 0 14px;">
      ${statCard("Transcribed", nTranscribed, "#2e8b57")}
      ${statCard("Untranscribed", nUntranscribed, "var(--ink-soft)")}
      ${statCard("Unanswered", nUnanswered, "#b42318")}
    </div>`;

  const pages = Math.max(1, Math.ceil(all.length / LEADS_PER_PAGE));
  if (leadPage > pages) leadPage = pages;
  const start = (leadPage - 1) * LEADS_PER_PAGE;
  const leads = all.slice(start, start + LEADS_PER_PAGE);

  const td = "padding:14px 12px; font-size:13.5px; border-bottom:1px solid rgba(0,0,0,.05); vertical-align:middle; color:var(--ink-soft);";

  // Count what needs checking, so 44 bad records among 276 can be found
  // rather than spotted by eye.
  const flagged = all.filter(l => leadProblems(l).length > 0).length;
  const flagNote = flagged
    ? `<div style="margin:0 0 12px; padding:10px 13px; background:#fdecea; border:1px solid ${FLAG_RED};
        border-radius:8px; font-size:12.5px; color:${FLAG_RED};">
        ⚠ <strong>${flagged}</strong> of these ${all.length} records need checking — marked in red.
        Open a client to see what's wrong.</div>`
    : "";

  wrap.innerHTML = `
    ${flagNote}
    ${statsRow}
    <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; min-width:860px;">
        <thead>
          <tr>
            ${sortHeader("Date of inquiry", "inquiry")}
            ${sortHeader("Client", "name")}
            ${sortHeader("Assigned to", "agent")}
            <th style="padding:10px 12px; text-align:left; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-soft); border-bottom:1px solid rgba(0,0,0,.08); white-space:nowrap;">Status</th>
            ${sortHeader("No. of pax", "pax", "center")}
            <th style="padding:10px 12px; text-align:left; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-soft); border-bottom:1px solid rgba(0,0,0,.08); white-space:nowrap;">Package</th>
            <th style="padding:10px 12px; text-align:center; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-soft); border-bottom:1px solid rgba(0,0,0,.08); white-space:nowrap;">Lead score</th>
            <th style="padding:10px 12px; text-align:left; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-soft); border-bottom:1px solid rgba(0,0,0,.08); white-space:nowrap;">Last update</th>
            <th style="padding:10px 12px; text-align:center; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-soft); border-bottom:1px solid rgba(0,0,0,.08); white-space:nowrap;">Transcript</th>
            <th style="padding:10px 12px; text-align:left; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-soft); border-bottom:1px solid rgba(0,0,0,.08); white-space:nowrap;"></th>
          </tr>
        </thead>
        <tbody>
          ${leads.map(l => `
            <tr>
              <td style="${td}">${fmtDate(l.inquiry_date || l.created_at)}</td>
              <td style="${td} font-weight:600; color:${isDuplicateLead(l) ? FLAG_RED : "var(--navy-900)"};">${l.client_full_name || "Unnamed client"}${isDuplicateLead(l) ? ' <span style="font-size:10.5px; font-weight:700;">⚠ dup</span>' : ""}</td>
              <td style="${td}">
                <span style="display:inline-flex; align-items:center; gap:7px;">
                  <span style="width:11px; height:11px; border-radius:3px; background:${agentDot(l.agent_id)}; flex-shrink:0;"></span>
                  ${agentShort(l.agent_id)}
                </span>
              </td>
              <td style="${td}">${statusPill(l)}</td>
              <td style="${td} text-align:center;">${Number(l.travelers) || 0}</td>
              <td style="${td}">${(l.package_destination || "—").split("(")[0].trim() || "—"}</td>
              <td style="${td} text-align:center; font-weight:700; color:var(--navy-900);">${leadScore(l)}/10</td>
              <td style="${td} max-width:180px;">
                <div style="font-size:12.5px; color:var(--navy-900); margin-bottom:2px;">${(l.updated_at || l.created_at) ? fmtDate(l.updated_at || l.created_at) : "—"}</div>
                <span class="lead-lastupdate" data-lead="${l.id}" title="See the full conversation and details"
                  style="cursor:pointer; color:var(--gold-600); font-weight:600; font-size:12px;
                  text-decoration:underline; text-underline-offset:2px;">See details</span>
              </td>
              <td style="${td} text-align:center;">${hasTranscript(l)
                ? '<span style="display:inline-block; padding:3px 12px; border-radius:999px; background:#eef7ee; color:#2e8b57; font-size:12px; font-weight:700;">Yes</span>'
                : '<span style="display:inline-block; padding:3px 12px; border-radius:999px; background:#f0f0f0; color:var(--ink-faint); font-size:12px; font-weight:700;">No</span>'}</td>
              <td style="${td}">
                <div style="display:flex; gap:6px;">
                  <button class="lead-open" data-lead="${l.id}" type="button"
                    style="padding:8px 14px; border:1px solid var(--line); border-radius:8px; background:#fff;
                    font-size:12.5px; font-weight:700; color:var(--navy-900); cursor:pointer; font-family:inherit; white-space:nowrap;">
                    Complete Profile</button>
                  ${currentProfile?.can_delete_leads ? `
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
        ${(() => {
          // Compact pager: always show page 1 and the last page, plus a window
          // of pages around the current one, with "…" gaps. Prevents dozens of
          // buttons overflowing/overlapping when there are many pages.
          const windowSize = 1; // pages on each side of the current page
          const set = new Set([1, pages, leadPage]);
          for (let i = 1; i <= windowSize; i++) { set.add(leadPage - i); set.add(leadPage + i); }
          const list = [...set].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
          const out = [];
          let prev = 0;
          for (const n of list) {
            if (n - prev > 1) out.push("gap");
            out.push(n);
            prev = n;
          }
          return out.map(n => n === "gap"
            ? `<span style="min-width:20px; text-align:center; color:var(--ink-faint); font-size:13px;">…</span>`
            : `<button class="lead-page" data-page="${n}" type="button"
                style="min-width:32px; height:32px; border:1px solid ${n === leadPage ? "var(--navy-900)" : "var(--line)"};
                border-radius:8px; background:${n === leadPage ? "var(--navy-900)" : "#fff"};
                color:${n === leadPage ? "#fff" : "var(--ink-soft)"}; font-weight:600; font-size:13px; cursor:pointer; font-family:inherit;">${n}</button>`
          ).join("");
        })()}
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
    btn.addEventListener("click", () => openClientProfile(btn.dataset.lead));
  });

  wrap.querySelectorAll(".lead-delete").forEach(btn => {
    btn.addEventListener("click", () => deleteLead(btn.dataset.lead));
  });

  // "See details" opens the profile, where the full conversation transcript
  // is shown in a scrollable panel.
  wrap.querySelectorAll(".lead-lastupdate").forEach(el => {
    el.addEventListener("click", () => openClientProfile(el.dataset.lead));
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

  // With hundreds of clients an unbounded list buries everything below it,
  // including the record you just opened. Show a workable slice and let the
  // filters do the narrowing.
  const LIMIT = 25;
  const shown = results.slice(0, LIMIT);
  const hidden = results.length - shown.length;

  box.innerHTML = `
    <div style="font-size:12px; color:var(--ink-faint); margin-bottom:8px;">
      ${results.length} client${results.length === 1 ? "" : "s"}${active ? " match these filters" : ""}${
        hidden > 0 ? ` · showing the first ${LIMIT} — search or filter to narrow` : ""}
    </div>
    ${shown.map(l => {
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
      // The client's card renders below the results list, so without this it
      // opens somewhere off-screen and looks like nothing happened.
      setTimeout(() => {
        document.getElementById("voucherCard")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 60);
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

function addPaymentRow(saved) {
  if (paymentRowCount >= MAX_PAYMENT_ROWS) return;
  paymentRowCount++;
  const i = paymentRowCount;
  const wrap = document.getElementById("paymentRows");
  if (!wrap) return;
  const row = document.createElement("div");
  row.className = "rank-row";
  row.style.alignItems = "flex-end";
  const methods = ["Bank transfer", "Credit card", "Cash", "GCash", "Travel Fund"];
  row.innerHTML = `
    <div class="rank-badge">${String(i).padStart(2, "0")}</div>
    <div class="form-field" style="flex:1;"><label>Payment date</label>
      <input type="date" class="pay-date" data-idx="${i}" value="${saved?.date || ""}"></div>
    <div class="form-field" style="flex:1;"><label>Amount</label>
      <input type="number" class="pay-amount" data-idx="${i}" value="${Number(saved?.amount) || 0}"></div>
    <div class="form-field" style="flex:1;">
      <label>Payment method</label>
      <select class="pay-method" data-idx="${i}">
        <option value="">Select</option>
        ${methods.map(m => `<option ${saved?.method === m ? "selected" : ""}>${m}</option>`).join("")}
      </select>
    </div>
    <div class="form-field" style="flex:1;">
      <label>Receipt / deposit slip</label>
      <input type="file" class="pay-receipt" data-idx="${i}" data-existing="${saved?.receipt_path || ""}">
      ${saved?.receipt_path
        ? `<a href="#" onclick="viewDocument('${saved.receipt_path}'); return false;"
             style="font-size:11px; color:var(--gold-600); font-weight:600;">View current receipt</a>`
        : ""}
    </div>`;
  wrap.appendChild(row);

  const btn = document.getElementById("addPaymentBtn");
  if (btn) btn.style.display = paymentRowCount >= MAX_PAYMENT_ROWS ? "none" : "inline-block";
}

function renderPaymentRows(payments) {
  const wrap = document.getElementById("paymentRows");
  if (!wrap) return;
  wrap.innerHTML = "";
  paymentRowCount = 0;
  const list = (payments || []).filter(Boolean);
  if (list.length === 0) {
    addPaymentRow(); // a new client starts with one blank row
  } else {
    list.forEach(p => addPaymentRow(p));
  }
}

document.getElementById("addPaymentBtn")?.addEventListener("click", () => addPaymentRow());
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
  const { data: inserted, error } = await supabaseClient
    .from("leads").insert(payload).select().single();

  if (error) {
    btn.textContent = "Error — try again";
    setTimeout(release, 1800);
    return;
  }

  // Add the new lead to the cache directly instead of re-fetching all 1000+
  // rows — that round trip is what made saving feel slow.
  if (inserted) {
    allLeadsCache.unshift(inserted);
    populateVoucherSelect(allLeadsCache);
    renderAll();
  }

  if (!syncToHubspot) {
    btn.textContent = "Saved ✓";
    setTimeout(release, 1500);
    return;
  }

  // The HubSpot sync runs in the background — the profile is already saved,
  // so there's no reason to make the person wait on an external service.
  btn.textContent = "Saved ✓ · syncing HubSpot…";
  supabaseClient.functions.invoke("hubspot-sync", { body: payload })
    .then(({ data, error: syncError }) => {
      btn.textContent = (syncError || data?.error) ? "Saved · HubSpot sync failed" : "Saved & synced ✓";
    })
    .catch(() => { btn.textContent = "Saved · HubSpot sync failed"; })
    .finally(() => setTimeout(release, 1500));
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
        <h4>${c.title} <span style="font-size:12px; font-weight:700; color:var(--gold-600);">/ ${c.max} pts</span></h4>
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
