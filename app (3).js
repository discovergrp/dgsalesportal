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
  await Promise.all([loadProfiles(), loadLeads(), loadScorecards(), loadApprovals()]);
  renderAll();
}

function enterWorkspace(name, role) {
  document.getElementById("sidebarName").textContent = name;
  const ROLE_LABELS = { admin: "Team Lead", sales_admin: "Admin Assistant of Sales", agent: "Sales Agent" };
  document.querySelector(".role-pill").textContent = ROLE_LABELS[role] || "Sales Agent";
  document.getElementById("agentSub").textContent = "Individual performance for " + name;
  document.getElementById("scorecardSub").textContent = "Daily scorecard for " + name;
  document.getElementById("leadsOwner").textContent = name + "'s Leads Tracker";

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
    .select("id, full_name, role")
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
  renderAgentStats();
  renderRanking();
  renderAgentPerformance();
  renderTeamFunnel();
  renderAgentFunnel();
  renderLeadsTable();
  renderUrgentAlerts();
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

function renderAgentStats() {
  if (!currentProfile) return;
  const today = new Date().toISOString().slice(0, 10);
  const dayRange = { start: new Date(today + "T00:00:00"), end: new Date(today + "T23:59:59") };
  const pax = paxOnDay(currentProfile.id, today);

  setStat("view-agent", "Net sales (today)", currency(netSalesInRange(currentProfile.id, dayRange)));
  setStat("view-agent", "Pax closed", pax);
  setStat("view-agent", "Daily bonus", currency(pax * bonusPerHead(pax)));
  setStat("view-agent", "Commission", currency(commissionOn(monthlyNetSales(currentProfile.id))));
}

function renderAgentFunnel() {
  const mine = currentProfile ? allLeadsCache.filter(l => l.agent_id === currentProfile.id) : [];
  drawFunnel("funnelGridAgent", mine);
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
                <button class="lead-open" data-lead="${l.id}" type="button"
                  style="padding:8px 14px; border:1px solid var(--line); border-radius:8px; background:#fff;
                  font-size:12.5px; font-weight:700; color:var(--navy-900); cursor:pointer; font-family:inherit; white-space:nowrap;">
                  Complete Profile</button>
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
}

// ---------- Client's Documents ----------
function populateVoucherSelect(leads) {
  const sel = document.getElementById("voucherClientSelect");
  if (!sel) return;
  const withNames = leads.filter(l => l.client_full_name);
  sel.innerHTML = '<option value="">Choose a saved client profile…</option>' +
    withNames.map(l => `<option value="${l.id}">${l.client_full_name} — ${l.package_destination || "No package set"}</option>`).join("");
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

  const [leaves, clientReqs] = await Promise.all([
    supabaseClient.from("leave_requests").select("*").eq("agent_id", currentProfile.id).order("created_at", { ascending: false }),
    supabaseClient.from("client_approval_requests").select("*").eq("agent_id", currentProfile.id).order("created_at", { ascending: false }),
  ]);

  const items = [
    ...(leaves.data || []).map(r => ({
      kind: "Leave", title: r.leave_type, sub: `${r.start_date || "?"} → ${r.end_date || "?"}`, status: r.status || "Pending", created: r.created_at,
    })),
    ...(clientReqs.data || []).map(r => ({
      kind: "Client Request", title: r.client_full_name || "Unnamed client", sub: `${r.package_name || "—"} · ${r.original_travel_date || "?"} → ${r.new_travel_date || "?"}`, status: r.status || "Pending", created: r.created_at,
    })),
  ].sort((a, b) => new Date(b.created) - new Date(a.created));

  if (items.length === 0) {
    list.innerHTML = '<div class="registry-empty">No approval requests submitted yet.</div>';
    return;
  }

  list.innerHTML = items.map(it => `
    <div class="rank-row">
      <div class="rank-badge" style="background:${it.kind === "Leave" ? "var(--navy-900)" : "var(--gold-600)"}; color:#fff;">${it.kind === "Leave" ? "L" : "C"}</div>
      <div>
        <div class="rank-name">${it.title}</div>
        <div class="rank-sub">${it.kind} · ${it.sub}</div>
      </div>
      <div class="rank-metrics">
        <div><div class="m-label">Status</div><div class="m-value">${it.status}</div></div>
      </div>
    </div>`).join("");
}

(function setDates() {
  const opts = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
  const label = new Date().toLocaleDateString("en-US", opts);
  document.querySelectorAll(".date-pill").forEach(el => el.textContent = label);
})();
