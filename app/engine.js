/*
 * CareReach triage engine. Pure functions, no DOM, runs fully offline.
 * Rules follow WHO IMCI / iCCM conventions:
 *   urgent (pink)  = refer immediately
 *   clinic (yellow)= refer, test or treat within 24 hours
 *   home (green)   = home care and follow-up
 */
(function (root) {
  const LEVELS = ["home", "clinic", "urgent"];
  const rank = (l) => LEVELS.indexOf(l);
  const maxLevel = (a, b) => (rank(a) >= rank(b) ? a : b);

  const IMPLIES = {
    cough_2wk: ["cough"], watery_diarrhoea: ["diarrhoea"], severe_headache: ["headache"],
    vomits_everything: ["vomiting"], itching_night: ["itching"], chest_indrawing: ["difficulty_breathing"],
  };

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function buildMatcher(kb) {
    const pairs = [];
    for (const [key, s] of Object.entries(kb.symptoms)) {
      for (const syn of s.syn) pairs.push([syn.toLowerCase(), key]);
      pairs.push([s.label.toLowerCase(), key]);
    }
    // Longest phrases first so "vaginal bleeding" wins over "bleeding".
    pairs.sort((a, b) => b[0].length - a[0].length);
    return pairs.map(([syn, key]) => ({ key, re: new RegExp("(^|[^\\p{L}])" + escapeRe(syn) + "(?=$|[^\\p{L}])", "giu") }));
  }

  function create(kb) {
    const matcher = buildMatcher(kb);
    const condById = Object.fromEntries(kb.conditions.map((c) => [c.id, c]));

    function withImplied(set) {
      for (const k of [...set]) for (const i of IMPLIES[k] || []) set.add(i);
      return set;
    }

    /* Free text -> symptom keys, plus any age, sex, pregnancy and duration hints. */
    function extract(text) {
      let t = " " + String(text || "").toLowerCase().replace(/[’']/g, "'") + " ";
      const found = new Set();
      const hints = {};

      const dur = t.match(/(?:for|since|past|last)\s+(\d+|a|one|two|three|four)\s*(day|days|week|weeks|wk|wks|month|months)/);
      if (dur) {
        const n = { a: 1, one: 1, two: 2, three: 3, four: 4 }[dur[1]] || parseInt(dur[1], 10);
        const unit = dur[2].startsWith("d") ? 1 : dur[2].startsWith("w") ? 7 : 30;
        hints.durationDays = n * unit;
      }
      const age = t.match(/(\d+)\s*(?:-|\s)?\s*(year|yr|month|mo|week|wk|day)s?\s*(?:-|\s)?\s*old|aged?\s*(\d+)/);
      if (age) {
        const n = parseInt(age[1] || age[3], 10);
        const unit = age[2] || "year";
        hints.ageMonths = unit.startsWith("y") ? n * 12 : unit.startsWith("m") ? n : unit.startsWith("w") ? n / 4.3 : n / 30;
      } else if (/\b(newborn|neonate)\b/.test(t)) hints.ageMonths = 0.5;
      else if (/\b(baby|infant)\b/.test(t)) hints.ageMonths = 6;
      if (/\b(woman|girl|female|mother|she|her)\b/.test(t)) hints.sex = "F";
      else if (/\b(man|boy|male|father|he|his)\b/.test(t)) hints.sex = "M";

      for (const m of matcher) {
        if (m.re.test(t)) {
          found.add(m.key);
          m.re.lastIndex = 0;
          t = t.replace(m.re, "$1 ");
        }
        m.re.lastIndex = 0;
      }
      if (found.has("pregnancy")) { hints.pregnant = true; hints.sex = "F"; }
      return { symptoms: withImplied(found), hints };
    }

    function ageGroup(months) {
      if (months == null || isNaN(months)) return null;
      if (months < 2) return "newborn";
      if (months < 60) return "child";
      if (months < 180) return "youth";
      if (months < 720) return "adult";
      return "older";
    }

    /* Danger-sign checklist for this patient. */
    function dangerChecklist(ctx) {
      const g = ctx.ageGroup;
      let list = g === "newborn" ? kb.dangerSigns.newborn : g === "child" ? kb.dangerSigns.child : kb.dangerSigns.general;
      if (ctx.pregnant) list = kb.dangerSigns.pregnancy.concat(list.filter((d) => !["ad_bleeding", "ad_convulsions"].includes(d.id)));
      return list;
    }

    /* Rank possible conditions. Returns [{ condition, score, matched }]. */
    function rankConditions(symptomSet, ctx) {
      const s = symptomSet instanceof Set ? symptomSet : new Set(symptomSet);
      const out = [];
      for (const c of kb.conditions) {
        if (c.ages && ctx.ageGroup && !c.ages.includes(ctx.ageGroup)) continue;
        if (c.pregnantOnly && !ctx.pregnant) continue;
        let got = 0, total = 0, keyHit = false;
        const matched = [];
        for (const [k, w] of Object.entries(c.sx)) {
          if (k === "pregnancy") continue;
          total += w;
          if (s.has(k)) { got += w; matched.push(k); if (w >= 3) keyHit = true; }
        }
        if (!matched.length) continue;
        const coverage = got / total;
        // Share of the patient's symptoms this condition explains.
        const relevant = [...s].filter((k) => k !== "pregnancy");
        const explained = relevant.length ? matched.length / relevant.length : 0;
        let score = 0.55 * coverage + 0.35 * explained + (keyHit ? 0.1 : 0);
        if (!keyHit) score *= 0.6;
        out.push({ condition: c, score: Math.round(score * 100) / 100, matched, coverage });
      }
      return out.sort((a, b) => b.score - a.score);
    }

    function fastBreathingCutoff(months) {
      if (months == null) return 30;
      if (months < 2) return 60;
      if (months < 12) return 50;
      if (months < 60) return 40;
      if (months < 144) return 30;
      return 30;
    }

    /* Vital-sign rules. Returns { flags: [{level, text}], addSymptoms: [] } */
    function checkVitals(v, ctx) {
      const flags = [], add = [];
      if (!v) return { flags, addSymptoms: add };
      const num = (x) => (x === "" || x == null ? null : Number(x));
      const temp = num(v.temp), rr = num(v.rr), spo2 = num(v.spo2), sbp = num(v.sbp), dbp = num(v.dbp), muac = num(v.muac), hr = num(v.hr);
      const g = ctx.ageGroup;

      if (temp != null) {
        if (g === "newborn" && temp >= 37.5) flags.push({ level: "urgent", text: `Fever in a young infant (${temp} °C)` });
        else if (temp >= 39.5) flags.push({ level: "clinic", text: `High fever (${temp} °C)` });
        if (temp >= 37.5) add.push("fever");
        if (temp < 35.5) { flags.push({ level: "urgent", text: `Low body temperature (${temp} °C)` }); add.push("low_temperature"); }
      }
      if (rr != null) {
        const cut = fastBreathingCutoff(ctx.ageMonths);
        if (rr >= cut) {
          add.push("fast_breathing");
          const adult = ctx.ageMonths == null || ctx.ageMonths >= 144;
          flags.push({ level: g === "newborn" || adult ? "urgent" : "clinic", text: `Fast breathing: ${rr}/min (cut-off ${cut} for this age)` });
        }
      }
      if (spo2 != null) {
        if (spo2 < 90) flags.push({ level: "urgent", text: `Oxygen saturation ${spo2}% (below 90%)` });
        else if (spo2 < 94) flags.push({ level: "clinic", text: `Oxygen saturation ${spo2}% (below 94%)` });
      }
      if (sbp != null || dbp != null) {
        const s = sbp || 0, d = dbp || 0;
        const bp = `${sbp ?? "?"}/${dbp ?? "?"} mmHg`;
        if (s >= 180 || d >= 110) flags.push({ level: "urgent", text: `Severe high blood pressure ${bp}` });
        else if (s >= 140 || d >= 90) flags.push({ level: ctx.pregnant ? "urgent" : "clinic", text: ctx.pregnant ? `High blood pressure in pregnancy ${bp}` : `Raised blood pressure ${bp}` });
        else if (sbp != null && sbp < 90 && g !== "newborn" && g !== "child") flags.push({ level: "urgent", text: `Low blood pressure ${bp}` });
      }
      if (muac != null && (g === "child" || ctx.pregnant)) {
        if (g === "child") {
          if (muac < 115) { flags.push({ level: "urgent", text: `MUAC ${muac} mm: red, severe acute malnutrition` }); add.push("thin_wasted"); }
          else if (muac < 125) { flags.push({ level: "clinic", text: `MUAC ${muac} mm: yellow, moderate acute malnutrition` }); add.push("thin_wasted"); }
        } else if (muac < 230) flags.push({ level: "clinic", text: `MUAC ${muac} mm: undernourished in pregnancy` });
      }
      if (hr != null && (g === "adult" || g === "older") && (hr > 120 || hr < 50)) {
        flags.push({ level: "clinic", text: `Heart rate ${hr}/min` });
      }
      return { flags, addSymptoms: add };
    }

    /* Full assessment. */
    function assess(input) {
      const ctx = { ...input.ctx };
      ctx.ageGroup = ctx.ageGroup || ageGroup(ctx.ageMonths);
      const s = withImplied(new Set(input.symptoms || []));
      const reasons = [];
      let level = "home";

      const vit = checkVitals(input.vitals, ctx);
      vit.addSymptoms.forEach((k) => s.add(k));
      if (input.durationDays >= 14 && s.has("cough")) s.add("cough_2wk");

      // 1. Danger signs from the checklist.
      const checklist = dangerChecklist(ctx);
      for (const id of input.dangers || []) {
        const d = checklist.find((x) => x.id === id) || Object.values(kb.dangerSigns).flat().find((x) => x.id === id);
        if (d) { reasons.push({ level: "urgent", text: "Danger sign: " + d.text }); level = "urgent"; }
      }
      // 2. Red-flag symptoms.
      for (const k of s) {
        if (kb.redFlags.includes(k)) { reasons.push({ level: "urgent", text: "Red flag: " + kb.symptoms[k].label }); level = "urgent"; }
      }
      // 3. Vitals.
      for (const f of vit.flags) { reasons.push(f); level = maxLevel(level, f.level); }
      // 4. Group-specific rules.
      if (ctx.ageGroup === "newborn" && (s.has("fever") || s.has("unable_to_drink") || s.has("fast_breathing"))) {
        reasons.push({ level: "urgent", text: "Any fever, feeding problem or fast breathing in a baby under 2 months" }); level = "urgent";
      }
      if (ctx.pregnant && ["vaginal_bleeding", "severe_headache", "blurred_vision", "swollen_face_hands", "reduced_fetal_movement", "waters_broken", "fever"].some((k) => s.has(k))) {
        reasons.push({ level: "urgent", text: "Danger sign in pregnancy" }); level = "urgent";
      }
      if (s.has("fever") && (ctx.ageGroup === "child" || ctx.pregnant)) {
        reasons.push({ level: "clinic", text: "Fever in a child under 5 or pregnant woman: test for malaria" }); level = maxLevel(level, "clinic");
      }
      if (s.has("fever") && input.durationDays >= 7) {
        reasons.push({ level: "clinic", text: "Fever for 7 days or more" }); level = maxLevel(level, "clinic");
      }
      if (s.has("cough_2wk")) { reasons.push({ level: "clinic", text: "Cough for 2 weeks or more: TB test" }); level = maxLevel(level, "clinic"); }
      if (s.has("bloody_stool")) { reasons.push({ level: "clinic", text: "Blood in stool" }); level = maxLevel(level, "clinic"); }
      if (s.has("diarrhoea") && input.durationDays >= 14) { reasons.push({ level: "clinic", text: "Diarrhoea for 14 days or more" }); level = maxLevel(level, "clinic"); }

      // 5. Likely conditions.
      const ranked = rankConditions(s, ctx).filter((r) => r.score >= 0.3).slice(0, 3);
      const top = ranked[0];
      if (top && top.score >= 0.45 && (top.matched.length >= 2 || top.coverage >= 0.35) && rank(top.condition.level) > rank(level)) {
        reasons.push({ level: top.condition.level, text: `Signs fit ${top.condition.name}` });
        level = top.condition.level;
      }
      if (!reasons.length) reasons.push({ level: "home", text: "No danger signs found" });

      // 6. Actions.
      const actions = [];
      if (level === "urgent") {
        actions.push("Refer immediately. Arrange transport now.");
        actions.push("Write a referral note and send it with the patient.");
        if (s.has("diarrhoea") || s.has("vomiting") || s.has("dehydration")) actions.push("Give ORS sips on the way if the patient can drink.");
        if (ctx.ageGroup === "newborn") actions.push("Keep the baby warm skin-to-skin and breastfeed on the way if able.");
      }
      if (s.has("fever") && level !== "urgent") actions.push("Do a malaria RDT if available and treat per national guidelines.");
      if (s.has("diarrhoea") && level !== "urgent") actions.push("Give ORS after each loose stool and zinc for 10–14 days.");
      // Home-treatment advice only applies when the patient is not being referred urgently.
      if (top && level !== "urgent") for (const c of top.condition.care.slice(0, 2)) if (!actions.includes(c)) actions.push(c);
      if (level === "clinic") actions.push("Refer to a health facility within 24 hours.");
      actions.push(level === "home" ? "Follow up in 3 days, or sooner if danger signs appear." : "Follow up after the facility visit.");

      const followUpDays = level === "urgent" ? 1 : level === "clinic" ? 2 : 3;
      const service = top ? kb.serviceFor[top.condition.id] : null;
      return { level, reasons, conditions: ranked, actions, followUpDays, service, symptoms: [...s], ctx };
    }

    /* Rank facilities for a result: urgent -> hospital first, otherwise matching service and distance. */
    function suggestFacilities(result, facilities) {
      return [...facilities].map((f) => {
        let score = 0;
        if (result.service && f.services.includes(result.service)) score += 5;
        if (result.level === "urgent" && (f.type === "Hospital" || f.services.includes("Emergency"))) score += 4;
        if (result.level !== "urgent" && f.type !== "Hospital") score += 1;
        score -= (f.distanceKm || 0) / 50;
        return { f, score };
      }).sort((a, b) => b.score - a.score).map((x) => x.f);
    }

    /* Search the education library. */
    function search(query) {
      const q = String(query || "").toLowerCase().trim();
      if (!q) return [];
      const { symptoms } = extract(q);
      const words = q.split(/[^\p{L}\d]+/u).filter((w) => w.length > 2 && !STOP.has(w));
      return kb.conditions.map((c) => {
        let score = 0;
        const name = c.name.toLowerCase();
        if (name.includes(q) || q.includes(name.split(" (")[0])) score += 10;
        for (const w of words) {
          if (name.includes(w)) score += 4;
          if (c.cat.toLowerCase().includes(w)) score += 2;
          if (c.about.toLowerCase().includes(w)) score += 1;
          if (c.prevent.join(" ").toLowerCase().includes(w)) score += 0.5;
        }
        for (const k of symptoms) if (c.sx[k]) score += c.sx[k];
        return { c, score };
      }).filter((x) => x.score >= 2).sort((a, b) => b.score - a.score).map((x) => x.c);
    }
    const STOP = new Set(["the", "and", "how", "what", "can", "does", "for", "with", "who", "why", "when", "about", "prevent", "avoid", "stop", "treat", "treatment", "signs", "symptoms", "cause", "causes", "get", "you", "are", "there", "this", "that", "from", "have", "has", "child", "children", "people"]);

    return { LEVELS, extract, ageGroup, dangerChecklist, rankConditions, checkVitals, assess, suggestFacilities, search, condById };
  }

  root.CareReachEngine = { create };
})(typeof window !== "undefined" ? window : globalThis);
