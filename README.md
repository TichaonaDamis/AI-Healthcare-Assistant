# CareReach: an offline health assistant

CareReach is a mobile web app (PWA) for **community health workers (CHWs) in places with poor or no internet**. It does four jobs:

1. **Virtual assistant**: The CHW types symptoms in plain words, or taps them. The assistant asks the WHO IMCI questions (age, pregnancy, how long, danger signs, measurements) and sorts the patient into a group:
   - 🟥 **Refer urgently**
   - 🟨 **Refer / treat within 24 h**
   - 🟩 **Home care**

   It also lists possible conditions and what to do next. Health questions such as "how do I prevent malaria?" get answers from the approved library.
2. **Approved health education**: 42 topics covering infections, mother and child health, chronic disease, mental health and emergencies. The content is paraphrased from WHO and NHS public fact sheets. Each topic has prevention, care, danger signs, when to refer, and a source link. Topics can be read aloud for patients who can't read.
3. **Symptom records**: Patient register and visit history with symptoms, danger signs, vitals (temperature, breathing rate, SpO₂, blood pressure, pulse, MUAC) and the triage result.
4. **Referrals**: The app suggests the nearest facility that offers the right service. Each referral gets a slip code (e.g. `CR-7KQ2`), a slip you can copy or send as an SMS, a follow-up date, and status tracking (pending → arrived → completed / did not attend) with facility feedback.

All data is saved on the phone first. When there is signal, records are sent to a district server (any HTTPS endpoint that accepts a POST). Records can also be exported as JSON or CSV.

## Offline-first design

| Concern | How it's handled |
|---|---|
| App loads with no network | A service worker (`sw.js`) caches the app shell and fonts. |
| Data entry with no network | Everything is written to on-device storage first. |
| Sync | An outbox queue syncs automatically when the phone goes back online, or when the CHW taps **Sync now**. Failed syncs keep the data. |
| AI with no network | The triage engine and symptom extraction are rule-based and run fully on the device. No cloud model is needed, so the app works in a village with no signal. |
| Low-end phones | No framework, about 150 KB total, large tap targets, high-legibility font (Atkinson Hyperlegible), light and dark themes. |
| Languages | Free-text matching understands some Kiswahili and French symptom words (*homa, kikohozi, kuhara, fièvre, toux…*). Translated content packs can be imported. |

## Clinical logic (`app/engine.js`)

- **Danger signs** use the WHO IMCI/iCCM lists for young infants (<2 months), children 2 months–5 years, pregnant women, and older children/adults. Any one of them means urgent referral.
- **Red-flag symptoms** also mean urgent referral: convulsions, lethargy, stiff neck, chest pain, stroke signs, snake bite, suicidal thoughts, coughing blood, and others.
- **Vitals rules**:
  - Fast breathing cut-offs by age: 60 / 50 / 40 / 30 breaths per minute.
  - SpO₂ below 90% is urgent; below 94% means refer.
  - Blood pressure ≥180/110 is urgent; ≥140/90 means refer, and is urgent in pregnancy.
  - MUAC in children: red (<115 mm) is urgent; yellow (115–124 mm) means refer.
  - Fever (≥37.5 °C) in a young infant is urgent.
- **Time-based rules**: cough for 2 weeks or more → TB test; fever for 7 days or more; diarrhoea for 14 days or more; fever in a child under 5 or a pregnant woman → malaria RDT.
- **Condition ranking**: possible conditions are ranked by weighted symptom overlap. They are shown as "possible conditions (not a diagnosis)". A condition can only raise the urgency when more than one of its signs is present.

## Run it

```bash
python3 build.py                     # builds dist/
python3 -m http.server 8080 -d dist  # open http://localhost:8080 on a phone or desktop
node --test tests/*.test.js          # 12 engine tests
```

To use it in the field, host `dist/` on any static HTTPS host (GitHub Pages, Netlify, a district server). Open it once on each phone, then choose **Add to Home screen**. After that it works with no internet.

## Project layout

```
app/
  index.html            UI shell and styles
  kb.js                 Knowledge base: symptoms (with synonyms), danger signs, 42 conditions, example facilities
  engine.js             Triage engine (pure functions, unit-tested)
  app.js                Assistant chat flow, records, referrals, library, sync
  sw.js                 Service worker (offline cache)
  manifest.webmanifest  Install metadata
tests/engine.test.js
build.py                Wraps app/ into an installable dist/
```

## Content packs (approval workflow)

The built-in pack is marked **"awaiting local approval"**. A national or district health authority should review it. They can then issue a JSON pack under **Sync & setup → Content pack**, with reviewed, corrected or translated content and `meta.status: "approved"`. Pack entries are merged with the built-in library by topic `id`.

```json
{
  "meta": { "title": "Kenya MoH CHW pack", "version": "2.0", "status": "approved", "approvedBy": "County Health Dept", "approvedOn": "2026-11-01" },
  "conditions": [ { "id": "malaria", "care": ["Test with RDT.", "Treat with artemether-lumefantrine per national guideline."] } ]
}
```

## Before field use

- Replace the **example facilities and records** (Sync & setup → Remove example data).
- Have the content pack **reviewed against national guidelines**. Medicine doses deliberately say "per national guidelines". The only doses given are the WHO-standard ORS and zinc doses.
- Set up a sync server. Patient data is sensitive: use HTTPS, add authentication, and follow local data-protection law.
- CareReach is **decision support, not a diagnostic device**. It supports trained CHWs and does not replace clinical judgement.

## Ideas for next steps

- Optional online LLM layer for free-form questions when there is signal, limited to answers from the approved pack.
- Full Kiswahili / French / Hausa UI translations.
- DHIS2 Tracker or CommCare sync adapter.
- Encrypting on-device storage with a CHW PIN.
