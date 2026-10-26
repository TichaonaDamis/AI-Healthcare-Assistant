// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert");
require("../app/kb.js");
require("../app/engine.js");

const E = globalThis.CareReachEngine.create(globalThis.CareReachKB);

test("extracts symptoms, preferring longer phrases", () => {
  const { symptoms, hints } = E.extract("3 year old boy with fever and cough for 3 weeks, heavy bleeding");
  assert.ok(symptoms.has("fever"));
  assert.ok(symptoms.has("cough_2wk"));
  assert.ok(symptoms.has("cough"), "cough_2wk implies cough");
  assert.ok(symptoms.has("severe_bleeding"));
  assert.ok(!symptoms.has("bleeding"), "generic bleeding should be consumed by the longer phrase");
  assert.strictEqual(hints.ageMonths, 36);
  assert.strictEqual(hints.sex, "M");
});

test("understands Kiswahili and French terms", () => {
  assert.ok(E.extract("mtoto ana homa na kuhara").symptoms.has("fever"));
  assert.ok(E.extract("mtoto ana homa na kuhara").symptoms.has("diarrhoea"));
  assert.ok(E.extract("fièvre et toux").symptoms.has("cough"));
});

test("danger sign forces urgent referral", () => {
  const r = E.assess({ symptoms: ["fever", "cough"], dangers: ["ch_drink"], ctx: { ageMonths: 18 } });
  assert.strictEqual(r.level, "urgent");
});

test("child with fever only -> clinic (malaria test)", () => {
  const r = E.assess({ symptoms: ["fever", "chills", "headache"], ctx: { ageMonths: 30 } });
  assert.strictEqual(r.level, "clinic");
  assert.strictEqual(r.conditions[0].condition.id, "malaria");
});

test("adult with a cold -> home care", () => {
  const r = E.assess({ symptoms: ["runny_nose", "sore_throat"], ctx: { ageMonths: 300 } });
  assert.strictEqual(r.level, "home");
  assert.strictEqual(r.conditions[0].condition.id, "cold");
});

test("fast breathing cut-offs follow IMCI by age", () => {
  assert.strictEqual(E.assess({ symptoms: ["cough"], vitals: { rr: 45 }, ctx: { ageMonths: 24 } }).level, "clinic");
  assert.strictEqual(E.assess({ symptoms: ["cough"], vitals: { rr: 45 }, ctx: { ageMonths: 8 } }).level, "home");
  assert.strictEqual(E.assess({ symptoms: ["cough"], vitals: { rr: 62 }, ctx: { ageMonths: 1 } }).level, "urgent");
});

test("MUAC red is urgent, yellow is clinic", () => {
  assert.strictEqual(E.assess({ symptoms: [], vitals: { muac: 110 }, ctx: { ageMonths: 20 } }).level, "urgent");
  assert.strictEqual(E.assess({ symptoms: [], vitals: { muac: 120 }, ctx: { ageMonths: 20 } }).level, "clinic");
});

test("high BP in pregnancy is urgent, outside pregnancy is clinic", () => {
  assert.strictEqual(E.assess({ symptoms: [], vitals: { sbp: 145, dbp: 95 }, ctx: { ageMonths: 300, pregnant: true } }).level, "urgent");
  assert.strictEqual(E.assess({ symptoms: [], vitals: { sbp: 145, dbp: 95 }, ctx: { ageMonths: 300 } }).level, "clinic");
});

test("long cough points to TB", () => {
  const r = E.assess({ symptoms: ["cough", "night_sweats", "weight_loss"], durationDays: 21, ctx: { ageMonths: 420 } });
  assert.strictEqual(r.conditions[0].condition.id, "tb");
  assert.strictEqual(r.level, "clinic");
});

test("pregnancy-only conditions are hidden for non-pregnant patients", () => {
  const r = E.rankConditions(new Set(["vaginal_bleeding"]), { ageGroup: "adult", pregnant: false });
  assert.ok(!r.some((x) => x.condition.id === "pregnancy_danger"));
});

test("library search finds conditions by question", () => {
  assert.strictEqual(E.search("how do I prevent malaria")[0].id, "malaria");
  assert.strictEqual(E.search("what to do after a dog bite")[0].id, "rabies");
});

test("urgent cases suggest a hospital first", () => {
  const r = E.assess({ symptoms: ["snake_bite"], ctx: { ageMonths: 300 } });
  const f = E.suggestFacilities(r, globalThis.CareReachKB.exampleFacilities);
  assert.strictEqual(f[0].type, "Hospital");
});
