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
  await Promise.all([loadLeads(), loadRanking(), renderUrgentAlerts(), loadApprovals()]);
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

  // Consultant dropdowns — populate from real employees (scorecard + client profile)
  const optionsHtml = profiles.map(p => `<option value="${p.id}">${p.full_name}</option>`).join("");
  const sel = document.getElementById("consultantSelect");
  if (sel) { sel.innerHTML = optionsHtml; if (currentProfile) sel.value = currentProfile.id; }
  const cpSel = document.getElementById("cp_consultant");
  if (cpSel) { cpSel.innerHTML = optionsHtml; if (currentProfile) cpSel.value = currentProfile.id; }

  renderAgentPerformance(profiles);
}

// ---------- Agent Performance Overview (Team Dashboard) ----------
function renderAgentPerformance(profiles) {
  const grid = document.getElementById("agentPerfGrid");
  if (!grid) return;
  grid.innerHTML = "";
  profiles.forEach(p => {
    const card = document.createElement("div");
    card.className = "agent-perf-card";
    card.innerHTML = `
      <div class="agent-perf-head">
        <h4>${p.full_name}</h4>
        <span>0 active opportunities</span>
      </div>
      <div class="agent-perf-metrics">
        <div><div class="num">0</div><div class="lbl">leads</div></div>
        <div><div class="num">0</div><div class="lbl">pax</div></div>
        <div><div class="num">₱0</div><div class="lbl">NSC</div></div>
        <div><div class="num">0</div><div class="lbl">score</div></div>
        <div style="grid-column: span 2;"><div class="num">₱0</div><div class="lbl">commission</div></div>
      </div>`;
    grid.appendChild(card);
  });
}

// ---------- Urgent Admin Attention: real overdue follow-ups ----------
async function renderUrgentAlerts() {
  const list = document.getElementById("urgentAlertsList");
  if (!list) return;
  const { data: overdue, error } = await supabaseClient
    .from("leads")
    .select("client_full_name, next_followup, agent_id, profiles:agent_id (full_name)")
    .lt("next_followup", new Date().toISOString())
    .not("next_followup", "is", null)
    .order("next_followup", { ascending: true });

  if (error || !overdue || overdue.length === 0) {
    list.innerHTML = "<li>No urgent alerts.</li>";
    return;
  }
  list.innerHTML = "";
  overdue.forEach(l => {
    const li = document.createElement("li");
    li.className = "alert-item";
    const agentName = l.profiles?.full_name ? l.profiles.full_name.split(" ")[0] : "Unassigned";
    li.innerHTML = `
      <div class="name">${(l.client_full_name || "Unnamed client")}</div>
      <div class="note">${agentName}: follow up</div>
      <div class="overdue">Overdue since ${new Date(l.next_followup).toLocaleString()}</div>`;
    list.appendChild(li);
  });
}

// ---------- Leads Tracker (real data) ----------
let allLeadsCache = [];

async function loadLeads() {
  if (!currentProfile) return;
  const { data: leads, error } = await supabaseClient
    .from("leads")
    .select("*")
    .order("created_at", { ascending: false });

  allLeadsCache = leads || [];

  const box = document.querySelector("#view-leads .card:last-child");
  const countLabel = box.querySelector("span");
  const empty = box.querySelector(".registry-empty");

  if (error || !leads || leads.length === 0) {
    countLabel.textContent = "0 records";
    empty.textContent = "No leads found for this date range.";
  } else {
    countLabel.textContent = leads.length + " record" + (leads.length === 1 ? "" : "s");
    empty.textContent = leads.map(l => `${l.package_destination || "Untitled lead"} — ${l.journey_stage}`).join(" · ");
  }

  populateVoucherSelect(allLeadsCache);
}

// ---------- Digital Voucher ----------
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

// ---------- Client's Documents: upload + library ----------
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

  const paid = (l.payments || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
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

// ---------- Client Profile: payment installment rows (add up to 15, one at a time) ----------
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

// Save the full Client Profile form as a new lead
async function buildClientProfilePayload() {
  const v = id => document.getElementById(id)?.value || null;
  const bookingFile = document.getElementById("cp_booking_file")?.files?.[0];
  const booking_confirmation_path = bookingFile ? await uploadDocument(bookingFile) : null;
  const payments = await collectPayments();

  return {
    agent_id: currentProfile.id,
    client_full_name: v("cp_fullname"),
    client_email: v("cp_email"),
    client_mobile: v("cp_mobile"),
    inquiry_date: v("cp_inquiry_date"),
    inquiry_time: v("cp_inquiry_time"),
    assigned_consultant: v("cp_consultant"),
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
  btn.textContent = "Uploading files…";
  const payload = await buildClientProfilePayload();
  btn.textContent = "Saving…";
  const { error } = await supabaseClient.from("leads").insert(payload);

  if (error) {
    btn.textContent = "Error — try again";
    setTimeout(() => (btn.textContent = label), 1800);
    return;
  }

  await loadLeads();

  if (!syncToHubspot) {
    btn.textContent = "Saved ✓";
    setTimeout(() => (btn.textContent = label), 1500);
    return;
  }

  btn.textContent = "Syncing to HubSpot…";
  const { data: syncResult, error: syncError } = await supabaseClient.functions.invoke("hubspot-sync", {
    body: payload,
  });
  btn.textContent = syncError || syncResult?.error ? "Saved, but HubSpot sync failed" : "Saved & synced ✓";
  setTimeout(() => (btn.textContent = label), 2200);
}

document.getElementById("cp_save_draft")?.addEventListener("click", (e) => saveClientProfile(e.target, "Save draft", false));
document.getElementById("cp_save_sync")?.addEventListener("click", (e) => saveClientProfile(e.target, "Save Client Profile & Sync to HubSpot", true));

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

// ---------- Team Dashboard period filter pills ----------
document.querySelectorAll("#teamPeriodPills .pill").forEach(p => {
  p.addEventListener("click", () => {
    document.querySelectorAll("#teamPeriodPills .pill").forEach(x => x.classList.remove("active"));
    p.classList.add("active");
  });
});

// ---------- Compliance Record tab pills ----------
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
  if (!error) setTimeout(() => (btn.textContent = "Submit Daily Scorecard"), 1500);
});

// ---------- Approvals: type toggle ----------
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
