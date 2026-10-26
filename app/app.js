/* CareReach app: UI, offline storage, assistant flow, referrals and sync. */
(function () {
  "use strict";

  /* ---------- Storage (localStorage with in-memory fallback) ---------- */
  const mem = {};
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem("cr." + key); if (v != null) return JSON.parse(v); } catch (e) { if (key in mem) return mem[key]; }
      return key in mem ? mem[key] : fallback;
    },
    set(key, value) {
      mem[key] = value;
      try { localStorage.setItem("cr." + key, JSON.stringify(value)); } catch (e) { /* private mode or quota: keep in memory */ }
    },
  };

  let KB = window.CareReachKB;
  const importedPack = store.get("kbPack", null);
  if (importedPack && importedPack.conditions) KB = mergePack(KB, importedPack);
  let E = window.CareReachEngine.create(KB);

  function mergePack(base, pack) {
    const byId = Object.fromEntries(base.conditions.map((c) => [c.id, c]));
    for (const c of pack.conditions || []) byId[c.id] = { ...byId[c.id], ...c };
    return {
      ...base,
      meta: { ...base.meta, ...(pack.meta || {}) },
      symptoms: { ...base.symptoms, ...(pack.symptoms || {}) },
      conditions: Object.values(byId),
      serviceFor: { ...base.serviceFor, ...(pack.serviceFor || {}) },
    };
  }

  const db = {
    patients: store.get("patients", null),
    encounters: store.get("encounters", null),
    referrals: store.get("referrals", null),
    facilities: store.get("facilities", null),
    outbox: store.get("outbox", []),
    settings: store.get("settings", { chwName: "", chwPhone: "", area: "", endpoint: "", lastSync: null }),
  };
  function save(key) { store.set(key, db[key]); }
  function saveAll() { ["patients", "encounters", "referrals", "facilities", "outbox", "settings"].forEach(save); }

  function queue(type, payload) {
    db.outbox.push({ id: uid(), type, payload, at: new Date().toISOString() });
    save("outbox");
    updateStatus();
  }

  /* ---------- Helpers ---------- */
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function refCode() { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < 4; i++) s += a[Math.floor(Math.random() * a.length)]; return "CR-" + s; }
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k === "value") el.value = v;
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const $ = (s, r = document) => r.querySelector(s);
  const fmtDate = (iso, time) => { const d = new Date(iso); return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) + (time ? " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : ""); };
  const daysFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const today = () => new Date().toISOString().slice(0, 10);
  function monthsSince(iso) { return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24 * 30.44); }
  function ageMonthsOf(p) { return p && p.dob ? monthsSince(p.dob) : null; }
  function ageText(months) {
    if (months == null) return "age unknown";
    if (months < 1) return Math.max(1, Math.round(months * 4.3)) + " wk";
    if (months < 24) return Math.floor(months) + " mo";
    return Math.floor(months / 12) + " y";
  }
  function dobFromMonths(m) { const d = new Date(); d.setDate(d.getDate() - Math.round(m * 30.44)); return d.toISOString().slice(0, 10); }
  const LEVEL_NAME = { urgent: "Refer urgently", clinic: "Refer / treat within 24 h", home: "Home care" };
  const LEVEL_SHORT = { urgent: "Urgent", clinic: "Clinic", home: "Home" };
  const tri = (level, text) => h("span", { class: "tri " + level }, text || LEVEL_SHORT[level]);
  const symLabel = (k) => (KB.symptoms[k] ? KB.symptoms[k].label : k);
  function toast(msg) {
    const t = h("div", { class: "toast", role: "status" }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 2600);
  }
  async function copyText(text, fallbackEl) {
    try { await navigator.clipboard.writeText(text); toast("Copied"); }
    catch (e) {
      if (fallbackEl) { const r = document.createRange(); r.selectNodeContents(fallbackEl); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      toast("Copy blocked. Text selected: copy it manually.");
    }
  }
  function download(name, text, type) {
    try {
      const url = URL.createObjectURL(new Blob([text], { type }));
      const a = h("a", { href: url, download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast("Download not available here. Use Copy instead."); }
  }
  const patientById = (id) => db.patients.find((p) => p.id === id);
  const facilityById = (id) => db.facilities.find((f) => f.id === id);

  /* ---------- Example data ---------- */
  function seedExamples() {
    const p1 = { id: "ex-p1", name: "Amani K.", sex: "M", dob: dobFromMonths(26), village: "Kisiwani", phone: "", pregnant: false, notes: "", createdAt: new Date(Date.now() - 864e5 * 4).toISOString(), example: true };
    const p2 = { id: "ex-p2", name: "Neema S.", sex: "F", dob: dobFromMonths(12 * 27), village: "Mlimani", phone: "", pregnant: true, notes: "About 32 weeks pregnant. Birth plan made.", createdAt: new Date(Date.now() - 864e5 * 9).toISOString(), example: true };
    const p3 = { id: "ex-p3", name: "Joseph M.", sex: "M", dob: dobFromMonths(12 * 64), village: "Kisiwani", phone: "", pregnant: false, notes: "Known high blood pressure.", createdAt: new Date(Date.now() - 864e5 * 20).toISOString(), example: true };
    db.patients = [p1, p2, p3];
    const r1 = E.assess({ symptoms: ["fever", "cough"], vitals: { temp: 38.9, rr: 46 }, dangers: [], durationDays: 2, ctx: { ageMonths: 26 } });
    const r2 = E.assess({ symptoms: ["severe_headache", "swelling_legs"], vitals: { sbp: 152, dbp: 100 }, dangers: ["pg_headache"], durationDays: 1, ctx: { ageMonths: 324, pregnant: true } });
    const r3 = E.assess({ symptoms: ["headache"], vitals: { sbp: 148, dbp: 92 }, dangers: [], durationDays: 3, ctx: { ageMonths: 768 } });
    const enc = (id, p, r, vitals, days) => ({ id, patientId: p.id, at: new Date(Date.now() - 864e5 * days).toISOString(), symptoms: r.symptoms, dangers: [], vitals, durationDays: 2, result: slimResult(r), notes: "", example: true });
    db.encounters = [
      enc("ex-e1", p1, r1, { temp: 38.9, rr: 46 }, 1),
      enc("ex-e2", p2, r2, { sbp: 152, dbp: 100 }, 0),
      enc("ex-e3", p3, r3, { sbp: 148, dbp: 92 }, 12),
    ];
    db.referrals = [
      { id: "ex-r1", code: "CR-7KQ2", patientId: p2.id, encounterId: "ex-e2", facilityId: "f3", level: "urgent", reason: "Severe headache and BP 152/100 in pregnancy (suspected pre-eclampsia)", status: "pending", createdAt: new Date().toISOString(), followUp: daysFromNow(1), example: true },
      { id: "ex-r2", code: "CR-M4TD", patientId: p3.id, encounterId: "ex-e3", facilityId: "f2", level: "clinic", reason: "Raised blood pressure 148/92 for confirmation and treatment", status: "completed", feedback: "Started on amlodipine. Review in 1 month.", createdAt: new Date(Date.now() - 864e5 * 12).toISOString(), followUp: daysFromNow(-10), example: true },
    ];
    db.facilities = KB.exampleFacilities.map((f) => ({ ...f }));
    saveAll();
  }
  function slimResult(r) {
    return { level: r.level, reasons: r.reasons, actions: r.actions, followUpDays: r.followUpDays, service: r.service,
      conditions: r.conditions.map((c) => ({ id: c.condition.id, name: c.condition.name, score: c.score })) };
  }

  /* ---------- Status bar ---------- */
  function updateStatus() {
    const on = navigator.onLine;
    const net = $("#netPill");
    net.className = "pill " + (on ? "on" : "off");
    net.lastElementChild.textContent = on ? "Online" : "Offline";
    const sp = $("#syncPill");
    const n = db.outbox.length;
    sp.textContent = n ? `${n} to sync` : "Synced";
    sp.onclick = () => go("more");
    const pending = db.referrals.filter((r) => r.status === "pending").length;
    const b = $("#refBadge");
    b.hidden = !pending; b.textContent = pending;
    $("#chwName").textContent = db.settings.chwName ? `${db.settings.chwName}${db.settings.area ? " · " + db.settings.area : ""}` : "Community health assistant";
  }
  addEventListener("online", () => { updateStatus(); if (db.settings.endpoint) syncNow(true); });
  addEventListener("offline", updateStatus);

  /* ---------- Router ---------- */
  const views = { assist: viewAssist, patients: viewPatients, referrals: viewReferrals, learn: viewLearn, more: viewMore };
  let current = "assist";
  function go(tab, arg) {
    current = tab;
    document.querySelectorAll("nav.tabs button").forEach((b) => b.setAttribute("aria-current", b.dataset.tab === tab ? "page" : "false"));
    const main = $("#main");
    main.replaceChildren((views[tab] || viewAssist)(arg));
    main.scrollTop = 0;
    if (tab === "assist") scrollChat();
  }
  document.querySelectorAll("nav.tabs button").forEach((b) => b.addEventListener("click", () => go(b.dataset.tab)));

  /* =====================================================================
     ASSISTANT
     ===================================================================== */
  const chat = { log: null, messages: [], A: null };

  function newAssessment(patient) {
    const m = patient ? ageMonthsOf(patient) : null;
    chat.A = {
      patientId: patient ? patient.id : null,
      ctx: { ageMonths: m, ageGroup: E.ageGroup(m), sex: patient ? patient.sex : null, pregnant: patient ? (patient.sex === "F" ? !!patient.pregnant : false) : null },
      symptoms: new Set(), durationDays: null, dangers: [], vitals: {}, moreAsked: false, dangersAsked: false, vitalsAsked: false, result: null, encounterId: null,
    };
  }

  function viewAssist() {
    const wrap = h("div", { class: "view" });
    const p = chat.A && chat.A.patientId ? patientById(chat.A.patientId) : null;
    const bar = h("div", { class: "patient-bar" },
      h("span", { class: "label" }, "Patient"),
      p ? h("strong", {}, `${p.name} · ${p.sex || "?"} · ${ageText(ageMonthsOf(p))}`) : h("span", { class: "muted" }, "None selected"),
      h("button", { class: "btn sm", type: "button", onclick: () => pickPatient((pt) => { startAssessment(pt); }) }, p ? "Change" : "Choose patient"),
      h("button", { class: "btn sm ghost", type: "button", onclick: () => { chat.messages = []; chat.A = null; go("assist"); } }, "Clear chat"),
    );
    chat.log = h("div", { class: "chat", "aria-live": "polite" });
    const input = h("input", { id: "chatInput", type: "text", placeholder: "Describe symptoms or ask a health question", autocomplete: "off", "aria-label": "Message" });
    const form = h("form", { onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (!v) return; input.value = ""; onUserText(v); } },
      input, h("button", { class: "btn primary", type: "submit" }, "Send"));
    wrap.append(bar, chat.log, h("div", { class: "composer" }, form));
    if (!chat.messages.length) welcome();
    else chat.messages.forEach((m) => chat.log.append(m));
    return wrap;
  }
  function scrollChat() { requestAnimationFrame(() => { const m = $("#main"); m.scrollTop = m.scrollHeight; }); }

  function botSay(...content) {
    const el = h("div", { class: "msg bot" }, h("div", { class: "who" }, "CareReach"), ...content);
    chat.messages.push(el); if (chat.log) chat.log.append(el); scrollChat();
    return el;
  }
  function userSay(text) {
    const el = h("div", { class: "msg user" }, h("div", { class: "bubble" }, text));
    chat.messages.push(el); if (chat.log) chat.log.append(el); scrollChat();
  }
  const bubble = (...c) => h("div", { class: "bubble" }, ...c);
  /* Quick replies that disappear after one is chosen. */
  function quick(options) {
    const box = h("div", { class: "quick" });
    for (const o of options) {
      box.append(h("button", { class: "chip" + (o.primary ? " primary" : ""), type: "button", onclick: () => { box.remove(); if (o.echo !== false) userSay(o.label); o.go(); } }, o.label));
    }
    return box;
  }

  function welcome() {
    botSay(
      bubble(h("p", {}, "Hello. I can help you assess a patient, find health information, and make referrals. Everything works without internet.")),
      bubble(h("p", { class: "small muted" }, "I support your judgement and follow WHO danger-sign rules. I do not diagnose. When in doubt, refer.")),
      quick([
        { label: "Assess a patient", primary: true, go: () => { pickPatient((p) => startAssessment(p), true); } },
        { label: "Health question", go: () => botSay(bubble("Type your question, for example: \"How do I prevent malaria?\" or \"What to do after a dog bite\".")) },
        { label: "Danger signs", go: showDangerSigns },
      ]),
    );
  }

  function showDangerSigns() {
    const block = (title, list) => h("div", {}, h("div", { class: "label" }, title), h("ul", {}, list.map((d) => h("li", {}, d.text))));
    botSay(bubble(
      h("p", {}, h("strong", {}, "Any of these means refer immediately:")),
      h("div", { style: "display:grid;gap:10px;margin-top:8px" },
        block("Baby under 2 months", KB.dangerSigns.newborn),
        block("Child 2 months to 5 years", KB.dangerSigns.child),
        block("Pregnant women", KB.dangerSigns.pregnancy),
        block("Older children and adults", KB.dangerSigns.general)),
    ));
  }

  function startAssessment(patient) {
    newAssessment(patient || null);
    if (current !== "assist") go("assist");
    else go("assist");
    botSay(bubble(patient
      ? `Starting an assessment for ${patient.name} (${patient.sex || "?"}, ${ageText(ageMonthsOf(patient))}${patient.pregnant ? ", pregnant" : ""}). What are the symptoms?`
      : "Starting an assessment. What are the symptoms? You can type them, for example \"fever and cough for 3 days, not eating\", or tap below."),
      symptomPicker(["fever", "cough", "diarrhoea", "vomiting", "headache", "rash", "abdominal_pain", "difficulty_breathing", "wound", "low_mood"], "Continue"));
  }

  /* Toggle chips for symptoms, plus a Continue button. */
  function symptomPicker(keys, cta) {
    const box = h("div", { class: "quick" });
    for (const k of keys) {
      const on = chat.A.symptoms.has(k);
      const b = h("button", { class: "chip", type: "button", "aria-pressed": on ? "true" : "false", onclick: () => {
        const now = b.getAttribute("aria-pressed") !== "true";
        b.setAttribute("aria-pressed", now ? "true" : "false");
        now ? chat.A.symptoms.add(k) : chat.A.symptoms.delete(k);
      } }, symLabel(k));
      box.append(b);
    }
    box.append(h("button", { class: "chip primary", type: "button", onclick: () => {
      box.remove();
      userSay(chat.A.symptoms.size ? [...chat.A.symptoms].map(symLabel).join(", ") : "No other symptoms");
      if (cta === "Continue") chat.A.started = true; else chat.A.moreAsked = true;
      next();
    } }, cta));
    return box;
  }

  function onUserText(text) {
    userSay(text);
    const low = text.toLowerCase().trim();
    if (["new", "restart", "reset", "start"].includes(low)) { pickPatient((p) => startAssessment(p), true); return; }
    if (/danger sign/.test(low)) { showDangerSigns(); return; }

    const { symptoms, hints } = E.extract(text);
    const isQuestion = /^(how|what|why|when|where|which|who|is|are|can|should|does|do|tell|explain)\b/.test(low) || low.endsWith("?");

    if (chat.A && !chat.A.result && (symptoms.size || hints.ageMonths != null || hints.durationDays != null || hints.pregnant)) {
      absorb(symptoms, hints);
      next();
      return;
    }
    if (!isQuestion && symptoms.size && (!chat.A || chat.A.result)) {
      const keepPatient = chat.A && chat.A.patientId ? patientById(chat.A.patientId) : null;
      newAssessment(keepPatient);
      absorb(symptoms, hints);
      chat.A.started = true;
      botSay(bubble(`I noted: ${[...symptoms].map(symLabel).join(", ")}. Let me ask a few questions.`));
      next();
      return;
    }
    answerQuestion(text);
  }

  function absorb(symptoms, hints) {
    const A = chat.A;
    symptoms.forEach((k) => A.symptoms.add(k));
    if (hints.ageMonths != null && A.ctx.ageMonths == null) { A.ctx.ageMonths = hints.ageMonths; A.ctx.ageGroup = E.ageGroup(hints.ageMonths); }
    if (hints.sex && !A.ctx.sex) A.ctx.sex = hints.sex;
    if (hints.pregnant) A.ctx.pregnant = true;
    if (hints.durationDays != null) A.durationDays = hints.durationDays;
    A.symptoms.delete("pregnancy");
    A.started = true;
  }

  function answerQuestion(text) {
    const hits = E.search(text).slice(0, 3);
    if (!hits.length) {
      botSay(bubble("I could not find that topic in the approved library. Try a disease name or a symptom, or browse the Learn tab."),
        quick([{ label: "Open the library", echo: false, go: () => go("learn") }, { label: "Assess a patient", go: () => pickPatient((p) => startAssessment(p), true) }]));
      return;
    }
    const c = hits[0];
    const q = text.toLowerCase();
    let section, items;
    if (/prevent|avoid|stop|protect/.test(q)) { section = "How to prevent it"; items = c.prevent; }
    else if (/danger|emergenc|serious|when.*(refer|clinic|hospital)|warning/.test(q)) { section = "Danger signs"; items = c.danger; }
    else if (/treat|care|do |what to do|manage|help/.test(q)) { section = "What to do"; items = c.care; }
    else { section = "Danger signs"; items = c.danger; }
    botSay(bubble(
      h("p", {}, h("strong", {}, c.name), " ", tri(c.level, LEVEL_SHORT[c.level])),
      h("p", { style: "margin-top:6px" }, c.about),
      h("div", { class: "label", style: "margin-top:10px" }, section),
      h("ul", {}, items.map((i) => h("li", {}, i))),
      h("p", { class: "small muted", style: "margin-top:8px" }, "Source: ", c.src.name),
    ), quick([
      { label: `Read more about ${c.name}`, echo: false, go: () => go("learn", c.id) },
      ...hits.slice(1).map((o) => ({ label: o.name, go: () => answerQuestion(o.name) })),
    ]));
  }

  function next() {
    const A = chat.A;
    if (!A) return;
    if (!A.symptoms.size && !A.started) return;
    if (A.ctx.ageGroup == null) return askAge();
    if (A.ctx.pregnant == null) {
      const m = A.ctx.ageMonths;
      if (A.ctx.sex !== "M" && m >= 144 && m < 600) return askPregnancy();
      A.ctx.pregnant = false;
    }
    if (A.durationDays == null) return askDuration();
    if (!A.moreAsked) return askMore();
    if (!A.dangersAsked) return askDangers();
    if (!A.vitalsAsked) return askVitals();
    return showResult();
  }

  function askAge() {
    const set = (m) => () => { chat.A.ctx.ageMonths = m; chat.A.ctx.ageGroup = E.ageGroup(m); next(); };
    botSay(bubble("How old is the patient?"), quick([
      { label: "Under 2 months", go: set(1) }, { label: "2–11 months", go: set(6) }, { label: "1–4 years", go: set(30) },
      { label: "5–14 years", go: set(120) }, { label: "15–59 years", go: set(360) }, { label: "60+ years", go: set(780) },
    ]));
  }
  function askPregnancy() {
    const set = (v, sex) => () => { chat.A.ctx.pregnant = v; if (sex) chat.A.ctx.sex = sex; next(); };
    botSay(bubble("Could the patient be pregnant, or has she given birth in the last 6 weeks?"), quick([
      { label: "Yes", go: set(true, "F") }, { label: "No", go: set(false) }, { label: "Patient is male", go: set(false, "M") },
    ]));
  }
  function askDuration() {
    const set = (d) => () => { chat.A.durationDays = d; next(); };
    botSay(bubble("How long has the patient been unwell?"), quick([
      { label: "Less than 3 days", go: set(1) }, { label: "3–6 days", go: set(4) }, { label: "1–2 weeks", go: set(10) }, { label: "More than 2 weeks", go: set(21) },
    ]));
  }
  function askMore() {
    const A = chat.A;
    const ranked = E.rankConditions(A.symptoms, A.ctx).slice(0, 4);
    const pool = [];
    for (const r of ranked) for (const [k, w] of Object.entries(r.condition.sx).sort((a, b) => b[1] - a[1])) {
      if (!A.symptoms.has(k) && !pool.includes(k) && k !== "pregnancy" && !KB.redFlags.includes(k)) pool.push(k);
    }
    const keys = pool.slice(0, 9);
    if (!keys.length) { A.moreAsked = true; return next(); }
    botSay(bubble("Does the patient have any of these as well? Tap all that apply."), symptomPicker(keys, "Done"));
  }
  function askDangers() {
    const A = chat.A;
    const list = E.dangerChecklist(A.ctx);
    const form = h("form", { class: "checklist" });
    for (const d of list) form.append(h("label", {}, h("input", { type: "checkbox", value: d.id, id: "dg-" + d.id }), h("span", {}, d.text)));
    const done = (none) => {
      A.dangers = none ? [] : [...form.querySelectorAll("input:checked")].map((i) => i.value);
      A.dangersAsked = true;
      actions.remove(); form.querySelectorAll("input").forEach((i) => (i.disabled = true));
      userSay(A.dangers.length ? `Danger signs: ${A.dangers.map((id) => list.find((d) => d.id === id).text).join("; ")}` : "No danger signs");
      next();
    };
    const actions = h("div", { class: "quick" },
      h("button", { class: "chip", type: "button", onclick: () => done(true) }, "None of these"),
      h("button", { class: "chip primary", type: "button", onclick: () => done(false) }, "Confirm"));
    const label = A.ctx.ageGroup === "newborn" ? "young infant" : A.ctx.ageGroup === "child" ? "child under 5" : A.ctx.pregnant ? "pregnant woman" : "patient";
    botSay(bubble(h("p", {}, h("strong", {}, "Check danger signs"), ` for a ${label}. Look, ask and feel for each one.`)), form, actions);
  }
  function askVitals() {
    const A = chat.A;
    const g = A.ctx.ageGroup;
    const fields = [["temp", "Temperature", "°C", "0.1"], ["rr", "Breaths / min", "count 60 s", "1"]];
    if (g === "child" || A.ctx.pregnant) fields.push(["muac", "MUAC", "mm", "1"]);
    if (g === "adult" || g === "older" || g === "youth" || A.ctx.pregnant) fields.push(["sbp", "BP systolic", "mmHg", "1"], ["dbp", "BP diastolic", "mmHg", "1"], ["hr", "Pulse", "/min", "1"]);
    fields.push(["spo2", "Oxygen sat.", "%", "1"]);
    const form = h("form", { class: "grid2", onsubmit: (e) => e.preventDefault() });
    for (const [k, l, unit, step] of fields) form.append(h("label", { class: "field" }, h("span", {}, `${l} `, h("span", { class: "muted small" }, unit)), h("input", { type: "number", inputmode: "decimal", step, id: "vt-" + k, name: k })));
    const finish = (skip) => {
      A.vitals = {};
      if (!skip) for (const i of form.querySelectorAll("input")) if (i.value !== "") A.vitals[i.name] = Number(i.value);
      A.vitalsAsked = true;
      actions.remove(); form.querySelectorAll("input").forEach((i) => (i.disabled = true));
      userSay(Object.keys(A.vitals).length ? vitalsText(A.vitals) : "No measurements");
      next();
    };
    const actions = h("div", { class: "quick" },
      h("button", { class: "chip", type: "button", onclick: () => finish(true) }, "Skip"),
      h("button", { class: "chip primary", type: "button", onclick: () => finish(false) }, "Add measurements"));
    botSay(bubble("Add any measurements you have. Leave blank what you did not measure."), h("div", { class: "card" }, form), actions);
  }
  function vitalsText(v) {
    const p = [];
    if (v.temp != null) p.push(`Temp ${v.temp} °C`);
    if (v.rr != null) p.push(`RR ${v.rr}/min`);
    if (v.hr != null) p.push(`Pulse ${v.hr}/min`);
    if (v.sbp != null || v.dbp != null) p.push(`BP ${v.sbp ?? "?"}/${v.dbp ?? "?"}`);
    if (v.spo2 != null) p.push(`SpO₂ ${v.spo2}%`);
    if (v.muac != null) p.push(`MUAC ${v.muac} mm`);
    return p.join(", ");
  }

  function showResult() {
    const A = chat.A;
    const r = E.assess({ symptoms: [...A.symptoms], dangers: A.dangers, vitals: A.vitals, durationDays: A.durationDays, ctx: A.ctx });
    A.result = r;
    const p = A.patientId ? patientById(A.patientId) : null;
    if (p) saveEncounter();
    botSay(resultCard(r), quick([
      ...(p ? [] : [{ label: "Save to a patient record", primary: true, echo: false, go: () => pickPatient((pt) => { A.patientId = pt.id; saveEncounter(); afterSave(); }, false, true) }]),
      ...(r.level !== "home" ? [{ label: "Make a referral", primary: !!p, echo: false, go: () => ensureSaved(() => openReferral(A.patientId, A.encounterId, r)) }] : []),
      ...(r.conditions[0] ? [{ label: `About ${r.conditions[0].condition.name}`, echo: false, go: () => go("learn", r.conditions[0].condition.id) }] : []),
      { label: "New assessment", echo: false, go: () => pickPatient((pt) => startAssessment(pt), true) },
    ]));
    if (p) botSay(bubble(`Saved to ${p.name}'s record. Follow up by ${fmtDate(daysFromNow(r.followUpDays))}.`));
  }
  function afterSave() {
    const p = patientById(chat.A.patientId);
    botSay(bubble(`Saved to ${p.name}'s record.`), chat.A.result.level !== "home"
      ? quick([{ label: "Make a referral", primary: true, echo: false, go: () => openReferral(p.id, chat.A.encounterId, chat.A.result) }]) : null);
  }
  function ensureSaved(fn) {
    if (chat.A.patientId && chat.A.encounterId) return fn();
    pickPatient((pt) => { chat.A.patientId = pt.id; saveEncounter(); fn(); }, false, true);
  }
  function saveEncounter() {
    const A = chat.A;
    if (A.encounterId) return;
    const e = { id: uid(), patientId: A.patientId, at: new Date().toISOString(), symptoms: A.result.symptoms, dangers: A.dangers, vitals: A.vitals, durationDays: A.durationDays, result: slimResult(A.result), notes: "", chw: db.settings.chwName };
    A.encounterId = e.id;
    db.encounters.push(e); save("encounters");
    const p = patientById(A.patientId);
    if (p && A.ctx.pregnant != null && p.sex === "F" && p.pregnant !== A.ctx.pregnant) { p.pregnant = A.ctx.pregnant; save("patients"); }
    queue("encounter", e);
  }

  function resultCard(r) {
    const dangerList = (KB.dangerSigns && r.conditions[0]) ? r.conditions[0].condition.danger : [];
    return h("div", { class: "result" },
      h("div", { class: "result-band " + r.level },
        h("div", { class: "label", style: "color:inherit" }, "Classification"),
        h("h3", {}, LEVEL_NAME[r.level])),
      h("div", { class: "result-body" },
        h("div", { style: "display:grid;gap:4px" }, h("div", { class: "label" }, "Why"), r.reasons.map((x) => h("div", { class: "reason" }, h("i", { class: x.level }), h("span", {}, x.text)))),
        r.conditions.length ? h("div", { class: "likely" }, h("div", { class: "label" }, "Possible conditions (not a diagnosis)"),
          r.conditions.map((c) => h("button", { type: "button", onclick: () => go("learn", c.condition.id) },
            h("strong", {}, c.condition.name), h("span", { class: "small muted" }, c.matched.map(symLabel).join(", ")),
            h("span", { class: "bar" }, h("span", { style: `width:${Math.round(Math.min(1, c.score) * 100)}%` }))))) : null,
        h("div", {}, h("div", { class: "label" }, "What to do now"), h("ul", {}, r.actions.map((a) => h("li", {}, a)))),
        dangerList.length ? h("div", {}, h("div", { class: "label" }, "Tell the family to come back at once if"), h("ul", {}, dangerList.slice(0, 4).map((a) => h("li", {}, a)))) : null,
      ));
  }

  /* ---------- Patient picker / registration ---------- */
  function pickPatient(cb, allowNone, mustChoose) {
    const dlg = $("#dlg");
    const list = h("div", { class: "list" });
    const search = h("input", { type: "search", id: "pickSearch", placeholder: "Search by name or village", oninput: () => fill(search.value) });
    function fill(q) {
      q = (q || "").toLowerCase();
      const ps = db.patients.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.village || "").toLowerCase().includes(q)).slice(0, 30);
      list.replaceChildren(...ps.map((p) => h("button", { class: "item", type: "button", onclick: () => { dlg.close(); cb(p); } },
        h("span", { class: "avatar" }, p.name[0]), h("div", {}, h("div", { class: "title" }, p.name), h("div", { class: "small muted" }, `${p.sex || "?"} · ${ageText(ageMonthsOf(p))} · ${p.village || "no village"}`)), p.example ? h("span", { class: "tag" }, "Example") : h("span"))));
      if (!ps.length) list.append(h("p", { class: "muted small" }, "No matching patients."));
    }
    fill("");
    const prefill = chat.A && chat.A.ctx ? chat.A.ctx : {};
    dlg.replaceChildren(h("div", { class: "dlg" },
      h("div", { class: "section-head" }, h("h2", {}, mustChoose ? "Save to which patient?" : "Choose patient"), h("button", { class: "btn sm ghost", type: "button", onclick: () => dlg.close() }, "Close")),
      h("div", { class: "row" },
        h("button", { class: "btn primary", type: "button", onclick: () => { dlg.close(); editPatient(null, cb, prefill); } }, "Register new patient"),
        allowNone ? h("button", { class: "btn", type: "button", onclick: () => { dlg.close(); cb(null); } }, "Continue without a record") : null),
      search, list));
    if (!dlg.open) dlg.showModal();
  }

  function editPatient(p, cb, prefill) {
    const dlg = $("#dlg");
    const isNew = !p;
    p = p || { id: uid(), name: "", sex: prefill && prefill.sex || "", dob: prefill && prefill.ageMonths != null ? dobFromMonths(prefill.ageMonths) : "", village: "", phone: "", pregnant: !!(prefill && prefill.pregnant), notes: "", createdAt: new Date().toISOString() };
    const m = ageMonthsOf(p);
    const f = h("form", { onsubmit: (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const yrs = Number(fd.get("ageY") || 0), mos = Number(fd.get("ageM") || 0);
      const name = String(fd.get("name") || "").trim();
      if (!name) { f.querySelector("#pName").focus(); return; }
      Object.assign(p, { name, sex: fd.get("sex"), village: fd.get("village").trim(), phone: fd.get("phone").trim(), notes: fd.get("notes").trim(), pregnant: fd.get("sex") === "F" && fd.get("pregnant") === "on", updatedAt: new Date().toISOString() });
      if (fd.get("ageY") !== "" || fd.get("ageM") !== "") p.dob = dobFromMonths(yrs * 12 + mos);
      if (isNew) db.patients.unshift(p);
      save("patients"); queue("patient", p);
      dlg.close(); toast(isNew ? "Patient registered" : "Patient updated");
      cb && cb(p);
    } },
      h("div", { class: "section-head" }, h("h2", {}, isNew ? "Register patient" : "Edit patient"), h("button", { class: "btn sm ghost", type: "button", onclick: () => dlg.close() }, "Cancel")),
      h("label", { class: "field" }, h("span", {}, "Name"), h("input", { type: "text", name: "name", id: "pName", value: p.name, required: true, autocomplete: "off" })),
      h("div", { class: "grid2" },
        h("label", { class: "field" }, h("span", {}, "Sex"), h("select", { name: "sex", id: "pSex" }, ["", "F", "M"].map((s) => h("option", { value: s, selected: p.sex === s }, s === "F" ? "Female" : s === "M" ? "Male" : "Select")))),
        h("label", { class: "field" }, h("span", {}, "Age: years"), h("input", { type: "number", name: "ageY", id: "pAgeY", min: "0", max: "120", value: m != null ? Math.floor(m / 12) : "" })),
        h("label", { class: "field" }, h("span", {}, "and months"), h("input", { type: "number", name: "ageM", id: "pAgeM", min: "0", max: "11", value: m != null ? Math.floor(m % 12) : "" }))),
      h("label", { class: "row" }, h("input", { type: "checkbox", name: "pregnant", id: "pPreg", checked: !!p.pregnant }), "Currently pregnant"),
      h("div", { class: "grid2" },
        h("label", { class: "field" }, h("span", {}, "Village / household"), h("input", { type: "text", name: "village", id: "pVillage", value: p.village })),
        h("label", { class: "field" }, h("span", {}, "Phone (optional)"), h("input", { type: "text", name: "phone", id: "pPhone", inputmode: "tel", value: p.phone }))),
      h("label", { class: "field" }, h("span", {}, "Notes"), h("textarea", { name: "notes", id: "pNotes" }, p.notes)),
      h("button", { class: "btn primary", type: "submit" }, "Save patient"));
    dlg.replaceChildren(f);
    if (!dlg.open) dlg.showModal();
  }

  /* =====================================================================
     PATIENTS
     ===================================================================== */
  function lastEncounter(pid) { return db.encounters.filter((e) => e.patientId === pid).sort((a, b) => b.at.localeCompare(a.at))[0]; }
  function followUpDue(pid) {
    const e = lastEncounter(pid);
    if (!e) return null;
    const d = new Date(e.at); d.setDate(d.getDate() + (e.result.followUpDays || 3));
    return d.toISOString().slice(0, 10);
  }

  function viewPatients(id) {
    if (id) return viewPatient(id);
    const wrap = h("div", { class: "view" });
    const weekAgo = Date.now() - 7 * 864e5;
    const due = db.patients.filter((p) => { const f = followUpDue(p.id); return f && f <= today() && !db.referrals.some((r) => r.patientId === p.id && r.status === "completed" && r.createdAt >= lastEncounter(p.id).at); });
    wrap.append(
      h("div", { class: "section-head" }, h("h2", {}, "Patients"), h("button", { class: "btn primary", type: "button", onclick: () => editPatient(null, (p) => go("patients", p.id)) }, "Register patient")),
      h("div", { class: "stats" },
        stat(db.patients.length, "Registered"),
        stat(db.encounters.filter((e) => new Date(e.at) > weekAgo).length, "Assessed this week"),
        stat(db.referrals.filter((r) => r.status === "pending").length, "Referrals pending"),
        stat(due.length, "Follow-ups due")),
    );
    if (db.patients.some((p) => p.example)) wrap.append(h("div", { class: "banner warn" }, h("strong", {}, "Example records are shown."), h("span", {}, "They show how the app works. Remove them in Sync & setup before field use.")));
    const search = h("input", { type: "search", id: "patSearch", placeholder: "Search by name or village", oninput: () => fill() });
    const list = h("div", { class: "list" });
    function fill() {
      const q = search.value.toLowerCase();
      const ps = db.patients.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.village || "").toLowerCase().includes(q));
      list.replaceChildren(...ps.map(patientRow));
      if (!ps.length) list.append(h("div", { class: "empty" }, h("p", {}, q ? "No patients match." : "No patients yet. Register one to start keeping records.")));
    }
    fill();
    wrap.append(search, list);
    return wrap;
  }
  const stat = (n, l) => h("div", { class: "stat" }, h("b", {}, n), h("span", { class: "small muted" }, l));
  function patientRow(p) {
    const e = lastEncounter(p.id);
    const pend = db.referrals.find((r) => r.patientId === p.id && r.status === "pending");
    return h("button", { class: "item", type: "button", onclick: () => go("patients", p.id) },
      h("span", { class: "avatar" }, p.name[0]),
      h("div", {},
        h("div", { class: "title" }, p.name, " ", p.example ? h("span", { class: "tag" }, "Example") : null),
        h("div", { class: "small muted" }, `${p.sex || "?"} · ${ageText(ageMonthsOf(p))}${p.pregnant ? " · pregnant" : ""} · ${p.village || "no village"}`),
        e ? h("div", { class: "small muted" }, `Last seen ${fmtDate(e.at)}`) : null),
      h("div", { style: "display:grid;gap:4px;justify-items:end" }, e ? tri(e.result.level) : null, pend ? h("span", { class: "tag" }, "Referral pending") : null));
  }

  function viewPatient(id) {
    const p = patientById(id);
    if (!p) return viewPatients();
    const wrap = h("div", { class: "view" });
    const encs = db.encounters.filter((e) => e.patientId === id).sort((a, b) => b.at.localeCompare(a.at));
    const refs = db.referrals.filter((r) => r.patientId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    wrap.append(
      h("div", {}, h("button", { class: "btn sm ghost", type: "button", onclick: () => go("patients") }, "← All patients")),
      h("div", { class: "card" },
        h("div", { class: "section-head" }, h("h2", {}, p.name, " ", p.example ? h("span", { class: "tag" }, "Example") : null),
          h("div", { class: "row" },
            h("button", { class: "btn sm", type: "button", onclick: () => editPatient(p, () => go("patients", id)) }, "Edit"),
            h("button", { class: "btn sm primary", type: "button", onclick: () => startAssessment(p) }, "New assessment"))),
        h("dl", { class: "kv" },
          h("dt", {}, "Sex / age"), h("dd", {}, `${p.sex === "F" ? "Female" : p.sex === "M" ? "Male" : "Not recorded"} · ${ageText(ageMonthsOf(p))}`),
          h("dt", {}, "Village"), h("dd", {}, p.village || "—"),
          p.phone ? [h("dt", {}, "Phone"), h("dd", { class: "mono" }, p.phone)] : null,
          p.pregnant ? [h("dt", {}, "Pregnancy"), h("dd", {}, "Currently pregnant")] : null,
          h("dt", {}, "Registered"), h("dd", {}, fmtDate(p.createdAt)),
          p.notes ? [h("dt", {}, "Notes"), h("dd", {}, p.notes)] : null)),
    );
    if (refs.length) wrap.append(h("h3", {}, "Referrals"), h("div", { class: "list" }, refs.map(referralRow)));
    wrap.append(h("h3", {}, "Visits"));
    if (!encs.length) wrap.append(h("div", { class: "empty" }, h("p", {}, "No visits recorded yet."), h("button", { class: "btn primary", type: "button", onclick: () => startAssessment(p) }, "Start an assessment")));
    else wrap.append(h("div", { class: "timeline" }, encs.map((e) => h("div", { class: "tl " + e.result.level },
      h("div", { class: "row" }, tri(e.result.level, LEVEL_NAME[e.result.level]), h("span", { class: "small muted" }, fmtDate(e.at, true))),
      h("div", {}, h("strong", {}, "Symptoms: "), e.symptoms.length ? e.symptoms.map(symLabel).join(", ") : "none recorded"),
      Object.keys(e.vitals || {}).length ? h("div", { class: "vitals" }, vitalTiles(e.vitals)) : null,
      e.result.conditions.length ? h("div", { class: "small" }, h("span", { class: "muted" }, "Possible: "), e.result.conditions.map((c) => c.name).join(", ")) : null,
      h("ul", { class: "small" }, e.result.reasons.map((r) => h("li", {}, r.text))),
      e.result.level !== "home" && !db.referrals.some((r) => r.encounterId === e.id)
        ? h("div", {}, h("button", { class: "btn sm", type: "button", onclick: () => openReferral(p.id, e.id, e.result) }, "Make a referral")) : null,
    ))));
    return wrap;
  }
  function vitalTiles(v) {
    const t = [];
    const tile = (l, val) => h("div", { class: "vital" }, h("span", { class: "small muted" }, l), h("b", {}, val));
    if (v.temp != null) t.push(tile("Temp °C", v.temp));
    if (v.rr != null) t.push(tile("Breaths/min", v.rr));
    if (v.hr != null) t.push(tile("Pulse", v.hr));
    if (v.sbp != null || v.dbp != null) t.push(tile("BP mmHg", `${v.sbp ?? "?"}/${v.dbp ?? "?"}`));
    if (v.spo2 != null) t.push(tile("SpO₂ %", v.spo2));
    if (v.muac != null) t.push(tile("MUAC mm", v.muac));
    return t;
  }

  /* =====================================================================
     REFERRALS
     ===================================================================== */
  function openReferral(patientId, encounterId, result) {
    const p = patientById(patientId);
    const enc = db.encounters.find((e) => e.id === encounterId);
    const levelR = result.level;
    const forRank = { level: levelR, service: result.service || (result.conditions && result.conditions[0] && KB.serviceFor[(result.conditions[0].condition || result.conditions[0]).id]) };
    const facs = E.suggestFacilities(forRank, db.facilities);
    const dlg = $("#dlg");
    const reasons = (result.reasons || []).filter((r) => r.level !== "home").map((r) => r.text);
    const f = h("form", { onsubmit: (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const r = { id: uid(), code: refCode(), patientId, encounterId, facilityId: fd.get("facility"), level: fd.get("level"), reason: fd.get("reason").trim(), notes: fd.get("notes").trim(),
        transport: fd.get("transport"), status: "pending", createdAt: new Date().toISOString(), followUp: fd.get("followUp"), chw: db.settings.chwName };
      db.referrals.push(r); save("referrals"); queue("referral", r);
      dlg.close(); toast("Referral created: " + r.code); updateStatus();
      go("referrals", r.id);
    } },
      h("div", { class: "section-head" }, h("h2", {}, "Refer ", p.name), h("button", { class: "btn sm ghost", type: "button", onclick: () => dlg.close() }, "Cancel")),
      h("label", { class: "field" }, h("span", {}, "Refer to"), h("select", { name: "facility", id: "rFacility" }, facs.map((x, i) => h("option", { value: x.id, selected: i === 0 }, `${x.name} · ${x.type} · ${x.distanceKm} km${i === 0 ? " (suggested)" : ""}`)))),
      h("label", { class: "field" }, h("span", {}, "Urgency"), h("select", { name: "level", id: "rLevel" }, ["urgent", "clinic"].map((l) => h("option", { value: l, selected: l === levelR || (levelR === "home" && l === "clinic") }, LEVEL_NAME[l])))),
      h("label", { class: "field" }, h("span", {}, "Reason for referral"), h("textarea", { name: "reason", id: "rReason" }, reasons.join("; ") || (enc ? enc.symptoms.map(symLabel).join(", ") : ""))),
      h("label", { class: "field" }, h("span", {}, "Treatment given before referral"), h("textarea", { name: "notes", id: "rNotes", placeholder: "e.g. ORS given, first dose of antimalarial, kept warm" })),
      h("div", { class: "grid2" },
        h("label", { class: "field" }, h("span", {}, "Transport"), h("select", { name: "transport", id: "rTransport" }, ["Family arranging", "Community transport", "Ambulance called", "Walking"].map((t) => h("option", {}, t)))),
        h("label", { class: "field" }, h("span", {}, "Follow up on"), h("input", { type: "date", name: "followUp", id: "rFollow", value: daysFromNow(levelR === "urgent" ? 1 : 2) }))),
      h("button", { class: "btn primary", type: "submit" }, "Create referral"));
    dlg.replaceChildren(f);
    if (!dlg.open) dlg.showModal();
  }

  const STATUS = { pending: "Pending", arrived: "Arrived at facility", completed: "Completed", missed: "Did not attend" };
  function referralRow(r) {
    const p = patientById(r.patientId), f = facilityById(r.facilityId);
    const overdue = r.status === "pending" && r.followUp && r.followUp < today();
    return h("button", { class: "item", type: "button", onclick: () => go("referrals", r.id) },
      tri(r.level),
      h("div", {},
        h("div", { class: "title" }, p ? p.name : "Unknown patient", " → ", f ? f.name : "facility"),
        h("div", { class: "small muted", style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, r.reason),
        h("div", { class: "small muted" }, h("span", { class: "code" }, r.code), " · ", fmtDate(r.createdAt))),
      h("div", { style: "display:grid;gap:4px;justify-items:end" }, h("span", { class: "tag" }, STATUS[r.status]), overdue ? h("span", { class: "tri urgent" }, "Follow-up overdue") : null));
  }

  let refFilter = "pending";
  function viewReferrals(id) {
    if (id) return viewReferral(id);
    const wrap = h("div", { class: "view" });
    const filters = { pending: "Pending", arrived: "Arrived", completed: "Completed", all: "All" };
    const list = db.referrals.filter((r) => refFilter === "all" || r.status === refFilter || (refFilter === "completed" && r.status === "missed")).sort((a, b) => (a.level === b.level ? b.createdAt.localeCompare(a.createdAt) : a.level === "urgent" ? -1 : 1));
    wrap.append(
      h("div", { class: "section-head" }, h("h2", {}, "Referrals"), h("span", { class: "small muted" }, "Track each patient until the facility confirms care.")),
      h("div", { class: "quick" }, Object.entries(filters).map(([k, l]) => h("button", { class: "chip", type: "button", "aria-pressed": refFilter === k ? "true" : "false", onclick: () => { refFilter = k; go("referrals"); } }, `${l} (${k === "all" ? db.referrals.length : db.referrals.filter((r) => r.status === k || (k === "completed" && r.status === "missed")).length})`))),
      list.length ? h("div", { class: "list" }, list.map(referralRow)) : h("div", { class: "empty" }, h("p", {}, "No referrals here."), h("p", { class: "small" }, "Referrals are created from an assessment result or a patient's visit history.")));
    return wrap;
  }

  function slipText(r) {
    const p = patientById(r.patientId), f = facilityById(r.facilityId), e = db.encounters.find((x) => x.id === r.encounterId);
    const lines = [
      "REFERRAL SLIP · CareReach",
      `Code: ${r.code}    Date: ${fmtDate(r.createdAt, true)}`,
      `Urgency: ${LEVEL_NAME[r.level].toUpperCase()}`,
      "",
      `Patient: ${p ? p.name : "?"}, ${p ? (p.sex || "?") : "?"}, ${p ? ageText(ageMonthsOf(p)) : "?"}${p && p.pregnant ? ", pregnant" : ""}`,
      `Village: ${p && p.village ? p.village : "-"}${p && p.phone ? "   Phone: " + p.phone : ""}`,
      `Referred to: ${f ? f.name + " (" + f.type + ")" : "-"}`,
      "",
      `Reason: ${r.reason || "-"}`,
    ];
    if (e) {
      lines.push(`Symptoms: ${e.symptoms.map(symLabel).join(", ") || "-"}`);
      if (Object.keys(e.vitals || {}).length) lines.push(`Measurements: ${vitalsText(e.vitals)}`);
      if (e.result.conditions.length) lines.push(`Possible (not a diagnosis): ${e.result.conditions.map((c) => c.name).join(", ")}`);
    }
    if (r.notes) lines.push(`Given before referral: ${r.notes}`);
    lines.push(`Transport: ${r.transport || "-"}`, "", `Referred by: ${r.chw || db.settings.chwName || "Community health worker"}${db.settings.chwPhone ? ", " + db.settings.chwPhone : ""}`,
      "Facility: please write findings and treatment on the back and return with the patient.");
    return lines.join("\n");
  }
  function smsText(r) {
    const p = patientById(r.patientId), f = facilityById(r.facilityId);
    return `REF ${r.code} ${LEVEL_SHORT[r.level].toUpperCase()}: ${p ? p.name : "?"} ${p ? ageText(ageMonthsOf(p)) : ""} ${p ? p.sex || "" : ""} to ${f ? f.name : "?"}. ${r.reason}`.slice(0, 300);
  }

  function viewReferral(id) {
    const r = db.referrals.find((x) => x.id === id);
    if (!r) return viewReferrals();
    const p = patientById(r.patientId), f = facilityById(r.facilityId);
    const wrap = h("div", { class: "view" });
    const pre = h("pre", {}, slipText(r));
    const setStatus = (s) => { r.status = s; r.updatedAt = new Date().toISOString(); save("referrals"); queue("referral", r); updateStatus(); go("referrals", id); toast("Status: " + STATUS[s]); };
    const fb = h("textarea", { id: "rFeedback", placeholder: "Findings and treatment from the facility's return slip" }, r.feedback || "");
    wrap.append(
      h("div", {}, h("button", { class: "btn sm ghost", type: "button", onclick: () => go("referrals") }, "← All referrals")),
      h("div", { class: "section-head" }, h("h2", {}, "Referral ", h("span", { class: "code" }, r.code)), h("div", { class: "row" }, tri(r.level, LEVEL_NAME[r.level]), h("span", { class: "tag" }, STATUS[r.status]), r.example ? h("span", { class: "tag" }, "Example") : null)),
      h("div", { class: "card" },
        h("dl", { class: "kv" },
          h("dt", {}, "Patient"), h("dd", {}, p ? h("a", { href: "#", style: "color:var(--accent)", onclick: (e) => { e.preventDefault(); go("patients", p.id); } }, p.name) : "—"),
          h("dt", {}, "Facility"), h("dd", {}, f ? `${f.name} · ${f.distanceKm} km` : "—"),
          f && f.phone ? [h("dt", {}, "Facility phone"), h("dd", { class: "mono" }, f.phone)] : null,
          h("dt", {}, "Follow up"), h("dd", {}, r.followUp ? fmtDate(r.followUp) : "—")),
        h("div", { class: "label" }, "Update status"),
        h("div", { class: "quick" }, Object.entries(STATUS).map(([k, l]) => h("button", { class: "chip", type: "button", "aria-pressed": r.status === k ? "true" : "false", onclick: () => setStatus(k) }, l))),
        h("label", { class: "field" }, h("span", {}, "Facility feedback"), fb),
        h("div", {}, h("button", { class: "btn sm", type: "button", onclick: () => { r.feedback = fb.value.trim(); save("referrals"); queue("referral", r); toast("Feedback saved"); } }, "Save feedback"))),
      h("h3", {}, "Referral slip"),
      h("p", { class: "small muted" }, "Copy this into the referral book or a message to the facility. The patient should carry the slip code."),
      h("div", { class: "slip" }, pre),
      h("div", { class: "row" },
        h("button", { class: "btn primary", type: "button", onclick: () => copyText(slipText(r), pre) }, "Copy slip"),
        h("button", { class: "btn", type: "button", onclick: () => copyText(smsText(r)) }, "Copy as SMS")),
    );
    return wrap;
  }

  /* =====================================================================
     LEARN (approved health education library)
     ===================================================================== */
  let learnCat = "All";
  function viewLearn(id) {
    if (id) return viewArticle(id);
    const wrap = h("div", { class: "view" });
    const cats = ["All", ...new Set(KB.conditions.map((c) => c.cat))];
    const search = h("input", { type: "search", id: "libSearch", placeholder: "Search a disease, symptom or question", oninput: () => fill() });
    const grid = h("div", { class: "lib" });
    function fill() {
      const q = search.value.trim();
      let items = q ? E.search(q) : KB.conditions.slice().sort((a, b) => a.name.localeCompare(b.name));
      if (learnCat !== "All") items = items.filter((c) => c.cat === learnCat);
      grid.replaceChildren(...items.map((c) => h("button", { type: "button", onclick: () => go("learn", c.id) },
        h("div", { class: "row", style: "justify-content:space-between" }, h("span", { class: "label" }, c.cat), tri(c.level)),
        h("span", { class: "t" }, c.name), h("p", {}, c.about))));
      if (!items.length) grid.append(h("p", { class: "muted" }, "Nothing found. Try another word."));
    }
    fill();
    const m = KB.meta;
    wrap.append(
      h("div", { class: "section-head" }, h("h2", {}, "Health library"), h("span", { class: "small muted" }, `${KB.conditions.length} topics · works offline`)),
      h("div", { class: "banner" + (m.status === "approved" ? "" : " warn") },
        h("strong", {}, m.status === "approved" ? `Approved content: ${m.title} v${m.version}` : `${m.title} v${m.version}: awaiting local approval`),
        h("span", {}, m.status === "approved" ? `Approved by ${m.approvedBy}${m.approvedOn ? " on " + m.approvedOn : ""}.` : "Paraphrased from WHO and NHS public fact sheets. Your health authority should review it and issue an approved pack (Sync & setup → Content pack).")),
      search,
      h("div", { class: "cats" }, cats.map((c) => h("button", { class: "chip", type: "button", "aria-pressed": learnCat === c ? "true" : "false", onclick: () => { learnCat = c; go("learn"); } }, c))),
      grid);
    return wrap;
  }

  function viewArticle(id) {
    const c = KB.conditions.find((x) => x.id === id);
    if (!c) return viewLearn();
    const wrap = h("div", { class: "view" });
    const text = `${c.name}. ${c.about} How to prevent it: ${c.prevent.join(" ")} What to do: ${c.care.join(" ")} Danger signs: ${c.danger.join(". ")}. ${c.refer}`;
    const canSpeak = "speechSynthesis" in window;
    let speaking = false;
    const speakBtn = canSpeak ? h("button", { class: "btn", type: "button", onclick: () => {
      try {
        if (speaking) { speechSynthesis.cancel(); speaking = false; speakBtn.textContent = "Read aloud"; return; }
        const u = new SpeechSynthesisUtterance(text); u.rate = 0.95;
        u.onend = () => { speaking = false; speakBtn.textContent = "Read aloud"; };
        speechSynthesis.speak(u); speaking = true; speakBtn.textContent = "Stop reading";
      } catch (e) { toast("Read aloud is not available on this device."); }
    } }, "Read aloud") : null;
    const sec = (title, items) => h("section", {}, h("h3", {}, title), h("ul", {}, items.map((i) => h("li", {}, i))));
    wrap.append(
      h("div", {}, h("button", { class: "btn sm ghost", type: "button", onclick: () => go("learn") }, "← Library")),
      h("article", { class: "article" },
        h("div", { style: "display:grid;gap:6px" }, h("span", { class: "label" }, c.cat), h("h2", {}, c.name), h("div", { class: "row" }, tri(c.level, LEVEL_NAME[c.level]))),
        h("p", {}, c.about),
        sec("How to prevent it", c.prevent),
        sec("What to do", c.care),
        sec("Danger signs: refer immediately", c.danger),
        h("section", {}, h("h3", {}, "When to refer"), h("p", {}, c.refer)),
        h("div", { class: "row" }, speakBtn, h("button", { class: "btn", type: "button", onclick: () => copyText(text) }, "Copy for sharing"),
          h("button", { class: "btn primary", type: "button", onclick: () => pickPatient((p) => startAssessment(p), true) }, "Assess a patient")),
        h("p", { class: "src muted" }, "Source: ", h("a", { href: c.src.url, target: "_blank", rel: "noopener" }, c.src.name), ". Paraphrased for community use; follow your national guidelines.")));
    return wrap;
  }

  /* =====================================================================
     SYNC & SETUP
     ===================================================================== */
  async function syncNow(silent) {
    const url = db.settings.endpoint;
    if (!url) { if (!silent) toast("Add a sync server address first."); return; }
    if (!navigator.onLine) { if (!silent) toast("Offline. Records will sync when you reconnect."); return; }
    if (!db.outbox.length) { if (!silent) toast("Nothing to sync."); return; }
    const batch = db.outbox.slice();
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: deviceId(), chw: db.settings.chwName, items: batch }) });
      if (!res.ok) throw new Error("Server answered " + res.status);
      const sent = new Set(batch.map((b) => b.id));
      db.outbox = db.outbox.filter((b) => !sent.has(b.id));
      db.settings.lastSync = new Date().toISOString();
      save("outbox"); save("settings"); updateStatus();
      toast(`Synced ${batch.length} records`);
      if (current === "more") go("more");
    } catch (e) {
      if (!silent) toast("Sync failed: " + e.message + ". Records are kept on this device.");
    }
  }
  function deviceId() { let d = store.get("device", null); if (!d) { d = "dev-" + uid(); store.set("device", d); } return d; }

  function exportJSON() { return JSON.stringify({ exportedAt: new Date().toISOString(), device: deviceId(), chw: db.settings, patients: db.patients, encounters: db.encounters, referrals: db.referrals, facilities: db.facilities }, null, 2); }
  function exportCSV() {
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["date", "patient", "sex", "age", "village", "level", "symptoms", "possible_conditions", "referral_code", "referral_status"]];
    for (const e of db.encounters) {
      const p = patientById(e.patientId) || {};
      const r = db.referrals.find((x) => x.encounterId === e.id) || {};
      rows.push([e.at, p.name, p.sex, ageText(ageMonthsOf(p)), p.village, e.result.level, e.symptoms.map(symLabel).join("; "), e.result.conditions.map((c) => c.name).join("; "), r.code, r.status]);
    }
    return rows.map((r) => r.map(esc).join(",")).join("\n");
  }

  function viewMore() {
    const wrap = h("div", { class: "view" });
    const s = db.settings;
    const prof = h("form", { class: "card", onsubmit: (e) => {
      e.preventDefault(); const fd = new FormData(prof);
      s.chwName = fd.get("chwName").trim(); s.chwPhone = fd.get("chwPhone").trim(); s.area = fd.get("area").trim(); s.endpoint = fd.get("endpoint").trim();
      save("settings"); updateStatus(); toast("Settings saved");
    } },
      h("h3", {}, "Your details"),
      h("div", { class: "grid2" },
        h("label", { class: "field" }, h("span", {}, "Your name"), h("input", { type: "text", name: "chwName", id: "sName", value: s.chwName })),
        h("label", { class: "field" }, h("span", {}, "Phone"), h("input", { type: "text", name: "chwPhone", id: "sPhone", value: s.chwPhone, inputmode: "tel" })),
        h("label", { class: "field" }, h("span", {}, "Area / catchment"), h("input", { type: "text", name: "area", id: "sArea", value: s.area }))),
      h("label", { class: "field" }, h("span", {}, "Sync server address (optional)"), h("input", { type: "url", name: "endpoint", id: "sEndpoint", value: s.endpoint, placeholder: "https://your-district-server.example/api/carereach" })),
      h("p", { class: "small muted" }, "Records are sent here as JSON when the phone has signal. Works with any server that accepts a POST, such as a DHIS2 or ODK bridge."),
      h("div", {}, h("button", { class: "btn primary", type: "submit" }, "Save settings")));

    const jsonPre = h("pre", { class: "small", style: "max-height:160px;overflow:auto;background:var(--sunk);padding:8px;border-radius:8px;margin:0" });
    const syncCard = h("div", { class: "card" },
      h("div", { class: "section-head" }, h("h3", {}, "Sync"), h("span", { class: "small muted" }, s.lastSync ? "Last sync " + fmtDate(s.lastSync, true) : "Never synced")),
      h("p", {}, h("strong", { class: "mono" }, db.outbox.length), " records waiting. Everything is saved on this device first, so nothing is lost without signal."),
      h("div", { class: "row" },
        h("button", { class: "btn primary", type: "button", onclick: () => syncNow(false) }, "Sync now"),
        h("button", { class: "btn", type: "button", onclick: () => download(`carereach-${today()}.json`, exportJSON(), "application/json") }, "Export JSON"),
        h("button", { class: "btn", type: "button", onclick: () => download(`carereach-visits-${today()}.csv`, exportCSV(), "text/csv") }, "Export CSV"),
        h("button", { class: "btn", type: "button", onclick: () => { jsonPre.textContent = exportJSON(); copyText(exportJSON(), jsonPre); } }, "Copy all data")),
      jsonPre);

    const facList = h("div", { class: "list" }, db.facilities.map((f) => h("div", { class: "item", style: "cursor:default" },
      h("span", { class: "avatar" }, f.type[0]),
      h("div", {}, h("div", { class: "title" }, f.name, " ", f.example ? h("span", { class: "tag" }, "Example") : null),
        h("div", { class: "small muted" }, `${f.type} · ${f.distanceKm} km${f.phone ? " · " + f.phone : ""}`),
        h("div", { class: "small muted" }, f.services.join(", "))),
      h("div", { class: "row" }, h("button", { class: "btn sm", type: "button", onclick: () => editFacility(f) }, "Edit")))));
    const facCard = h("div", { class: "card" },
      h("div", { class: "section-head" }, h("h3", {}, "Referral facilities"), h("button", { class: "btn sm primary", type: "button", onclick: () => editFacility(null) }, "Add facility")),
      h("p", { class: "small muted" }, "Referrals suggest the closest facility that offers the right service. Replace the examples with your real facilities."),
      facList);

    const fileIn = h("input", { type: "file", accept: "application/json,.json", id: "packFile", onchange: async () => {
      const file = fileIn.files[0]; if (!file) return;
      try {
        const pack = JSON.parse(await file.text());
        if (!pack.meta || !Array.isArray(pack.conditions)) throw new Error("A pack needs 'meta' and 'conditions'.");
        store.set("kbPack", pack);
        KB = mergePack(window.CareReachKB, pack); E = window.CareReachEngine.create(KB);
        toast(`Loaded ${pack.meta.title || "content pack"}`); go("more");
      } catch (e) { toast("Could not load pack: " + e.message); }
    } });
    const m = KB.meta;
    const packCard = h("div", { class: "card" },
      h("h3", {}, "Content pack"),
      h("dl", { class: "kv" }, h("dt", {}, "Pack"), h("dd", {}, `${m.title} v${m.version}`), h("dt", {}, "Status"), h("dd", {}, m.status === "approved" ? tri("home", "Approved") : tri("clinic", "Awaiting approval")),
        h("dt", {}, "Topics"), h("dd", {}, KB.conditions.length), m.approvedBy ? [h("dt", {}, "Approved by"), h("dd", {}, m.approvedBy)] : null),
      h("p", { class: "small muted" }, "Health authorities can issue a JSON pack with reviewed or translated content. It is merged with the built-in library by topic id."),
      h("label", { class: "field" }, h("span", {}, "Import approved pack"), fileIn),
      store.get("kbPack", null) ? h("div", {}, h("button", { class: "btn sm danger", type: "button", onclick: () => { store.set("kbPack", null); KB = window.CareReachKB; E = window.CareReachEngine.create(KB); go("more"); toast("Using built-in pack"); } }, "Remove imported pack")) : null);

    const confirmBox = h("div", { class: "row", hidden: true },
      h("span", { class: "small" }, "Remove all example patients, visits, referrals and facilities?"),
      h("button", { class: "btn sm danger", type: "button", onclick: () => {
        db.patients = db.patients.filter((p) => !p.example); db.encounters = db.encounters.filter((e) => !e.example);
        db.referrals = db.referrals.filter((r) => !r.example); db.facilities = db.facilities.filter((f) => !f.example);
        saveAll(); updateStatus(); toast("Example data removed"); go("more");
      } }, "Yes, remove"),
      h("button", { class: "btn sm", type: "button", onclick: () => (confirmBox.hidden = true) }, "Keep"));
    const dataCard = h("div", { class: "card" },
      h("h3", {}, "Example data"),
      h("p", { class: "small muted" }, "The app starts with example records so you can see how it works."),
      h("div", {}, h("button", { class: "btn sm danger", type: "button", onclick: () => (confirmBox.hidden = false) }, "Remove example data")), confirmBox);

    const about = h("div", { class: "card" },
      h("h3", {}, "About CareReach"),
      h("p", { class: "small" }, "CareReach is decision support for trained community health workers. It follows WHO IMCI and iCCM danger-sign rules and paraphrases public WHO and NHS health information. It does not replace clinical judgement, national guidelines, or a qualified health professional. When unsure, refer."),
      h("p", { class: "small muted" }, "Data is stored on this device. Install it from the browser menu (Add to Home screen) to use it without internet."));

    wrap.append(h("h2", {}, "Sync & setup"), syncCard, prof, facCard, packCard, dataCard, about);
    return wrap;
  }

  function editFacility(f) {
    const dlg = $("#dlg");
    const isNew = !f;
    f = f || { id: uid(), name: "", type: "Health centre", services: [], distanceKm: 0, phone: "" };
    const allServices = [...new Set([...Object.values(KB.serviceFor), ...db.facilities.flatMap((x) => x.services)])].sort();
    const form = h("form", { onsubmit: (e) => {
      e.preventDefault(); const fd = new FormData(form);
      Object.assign(f, { name: fd.get("name").trim(), type: fd.get("type"), distanceKm: Number(fd.get("distanceKm") || 0), phone: fd.get("phone").trim(), services: fd.getAll("services"), example: false });
      if (!f.name) return;
      if (isNew) db.facilities.push(f);
      save("facilities"); dlg.close(); go("more"); toast("Facility saved");
    } },
      h("div", { class: "section-head" }, h("h2", {}, isNew ? "Add facility" : "Edit facility"), h("button", { class: "btn sm ghost", type: "button", onclick: () => dlg.close() }, "Cancel")),
      h("label", { class: "field" }, h("span", {}, "Name"), h("input", { type: "text", name: "name", id: "fName", value: f.name, required: true })),
      h("div", { class: "grid2" },
        h("label", { class: "field" }, h("span", {}, "Type"), h("select", { name: "type", id: "fType" }, ["Health post", "Health centre", "Clinic", "Hospital"].map((t) => h("option", { selected: f.type === t }, t)))),
        h("label", { class: "field" }, h("span", {}, "Distance (km)"), h("input", { type: "number", name: "distanceKm", id: "fDist", value: f.distanceKm, min: "0" })),
        h("label", { class: "field" }, h("span", {}, "Phone"), h("input", { type: "text", name: "phone", id: "fPhone", value: f.phone }))),
      h("div", { class: "field" }, h("span", {}, "Services"), h("div", { class: "checklist", style: "grid-template-columns:repeat(auto-fill,minmax(180px,1fr))" },
        allServices.map((sv) => h("label", {}, h("input", { type: "checkbox", name: "services", value: sv, checked: f.services.includes(sv) }), h("span", {}, sv))))),
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Save facility"),
        !isNew ? h("button", { class: "btn danger", type: "button", onclick: () => { db.facilities = db.facilities.filter((x) => x.id !== f.id); save("facilities"); dlg.close(); go("more"); } }, "Delete") : null));
    dlg.replaceChildren(form);
    if (!dlg.open) dlg.showModal();
  }

  /* ---------- Offline support ---------- */
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    try { navigator.serviceWorker.register("sw.js").catch(() => {}); } catch (e) { /* not available in this context */ }
  }

  /* ---------- Boot ---------- */
  if (!db.patients) seedExamples();
  if (!db.facilities) db.facilities = KB.exampleFacilities.map((f) => ({ ...f }));
  updateStatus();
  const start = (location.hash || "").slice(1);
  go(views[start] ? start : "assist");
})();
