# EU compliance protocols

How Citrus meets EU and German law without slowing the app or getting in the way of a lecture. This is an engineering design, not legal advice: the university's data-protection officer (DPO) and counsel must confirm it before real student data is used (see `LOOSE_ENDS.md`, *Before going public*).

Laws in scope: the GDPR, the German BDSG and Bavarian BayDSG (OTH Amberg-Weiden is a Bavarian public university), the ePrivacy rules for devices (§ 25 TDDDG), and the EU AI Act (Regulation 2024/1689). Check the AI Act's current application dates before launch: parts of it were proposed to be delayed.

## Design rule

Every protocol must cost nothing on the hot path (joining a lecture, sending an answer, the live screen). Controls run at one of three moments only:

| Moment | Examples | Cost to users |
|---|---|---|
| **Once** (setup, a notice, a decision) | records of processing, DPIA, privacy notice, sub-processor list | none |
| **Off the hot path** (nightly clean-up, when a lecturer opens a report, an export request) | retention deletes, decryption, audit of report opens | none to students; microseconds to lecturers |
| **At write time, in one statement** | keep a minimal row, store a consent flag | negligible |

## P1. Lawful basis and purposes (GDPR Art. 5, 6, 13)

- A public university teaches under a **public task** (Art. 6(1)(e) with BayDSG / BayHIG), not under "legitimate interest", which public bodies cannot use for their tasks. Live feedback is part of teaching, so it needs no consent.
- Consent (Art. 6(1)(a)) is used only for what is optional and not part of the teaching task: showing a student's name to the lecturer (`share_name`, already opt-in), keeping a lecturer's transcript, keeping audio, and personalised AI help.
- Each feature has one written purpose. The privacy notice lists them, and the lecture join screen shows a one-line version ("Your answers are anonymous to the lecturer. Citrus helps you review the parts you found hard."). It is text on a page that is already shown, so it adds no request.
- **Purpose limit:** lecture signals are used to improve teaching and the student's own review. They are never used to grade, rank or sanction a student. The code enforces this by never joining signals to grades or attendance penalties.

## P2. Data minimisation and student privacy (Art. 5(1)(c), 25)

This is the protocol we are building now.
- Students receive only their own results and their own weak parts. No class average, class bar, counts of students lost, or other students' answers.
- Student routes read their own rows through narrow queries and never load lecturer content.
- Lecturer reports on a few students could identify them. Class figures are shown only from a minimum number of answers (`MIN_SIGNALS` exists), and flags stay anonymous unless the student chose to show their name.
- Guest accounts hold a throwaway address, no real name and expire after 30 idle days.
- **No performance cost:** it removes fields and queries.

## P3. Encryption and access control (Art. 25, 32)

- **In transit:** TLS everywhere (Vercel and Turso already require it). Keep HSTS on.
- **At rest, lecturer-only content** (lecture transcripts, key points, trouble notes, audio): AES-256-GCM with a per-lecture key derived from the master key, decrypted only in a lecturer-only module that student routes cannot import (a test enforces it). Decryption happens when a lecturer opens a report or runs AI notes, not on the live path.
- **Not encrypted at field level:** live signals, flags and attendance. They are read constantly, hold nothing sensitive on their own, and encrypting them would slow every lecture for no real gain. The database is already encrypted at rest by the host.
- **Keys:** `CAMPUS_MASTER_KEY` stays a secret, never in the repository, with a documented rotation (re-wrap the per-lecture keys, not the data).
- **Access:** server-side permission checks (already the rule). Opening a lecturer report writes one audit row (who, which lecture, when). Student reads are not logged per request, because that would be a write on the hot path.

## P4. Retention and deletion (Art. 5(1)(e), 17)

Keep everything for the shortest period that serves its purpose. The nightly maintenance job does this and needs no live cost.

| Data | Proposed period | Notes |
|---|---|---|
| Live signals and flags | the term plus a configurable grace period (default 12 months) | they feed "My progress"; then they are anonymised (user link removed) rather than deleted, so teaching statistics survive |
| Lecturer transcript | until the lecturer deletes it, at most the institution's period (default 12 months) | kept only when the lecturer opted in |
| Lecture audio | the institution's `recordingRetentionDays` (exists) | consent notice before recording; a retention value of 0 means "keep nothing" |
| Guest accounts | 30 idle days (exists), their data anonymised afterwards | |
| Audit log | 180 days (exists) | |
| Notifications, device events | 30 to 180 days (exists) | |
| A deleted account | removed immediately; shared records are anonymised | `POST /api/me/delete` exists |

## P5. Data-subject rights (Art. 12 to 22)

- **Access and portability:** `GET /api/me/export` exists. Keep it complete as features are added: a test lists every table that holds a user id and fails if one is missing from the export.
- **Erasure:** `POST /api/me/delete` exists. The same test checks every user-linked table is deleted or anonymised.
- **Rectification:** profile edits already exist; flags and signals are not editable (they are a moment-in-time record).
- **Objection and restriction (Art. 21, 18):** a "stop using my answers for my review" switch and an "opt out of AI help" switch in Settings → Privacy. Both are plain flags read when building a personal record, so they add no cost.
- **Response time:** one month. The export and delete are self-service, so no manual queue is needed.

## P6. AI processing and transfers outside the EU (Art. 28, 44 to 49)

Lecture text goes to AI models through the AI Gateway, so the gateway and the model providers behind it are processors or sub-processors.
- **Minimise:** send only the text the feature needs. Never send names, emails or user ids to a model (already the case for anonymous records; keep it a tested rule).
- **Contracts:** a data-processing agreement (Art. 28) with the hosting provider, the database provider and the gateway. A written list of sub-processors on the privacy page, kept up to date.
- **Transfers:** prefer EU regions (the site already runs in Dublin, `dub1`). For anything that leaves the EU, rely on the EU-US Data Privacy Framework or standard contractual clauses, and confirm with the provider in writing. This is a contract check, not code.
- **No training on university data:** confirm zero data retention and no training with the gateway and each model provider, and record the answer.
- **Admin control:** Admin → AI can switch features off per institution, which already exists, so the DPO can disable any provider they do not accept.

## P7. The AI Act (Regulation 2024/1689)

- **Prohibited practice (Art. 5(1)(f)):** inferring emotions of people in education is banned. Citrus must never estimate confusion or attention from a face or a voice. "Following / unsure / lost" is what the student chooses themselves. This stays a hard rule in code review.
- **High risk (Annex III, education):** systems that evaluate learning outcomes, steer learning, assess a student's level or monitor tests are high risk. Citrus stays outside by keeping its outputs advisory: study suggestions for the student, anonymous teaching feedback for the lecturer, nothing used to grade or place anyone. The planned *mastery modelling* feature would likely be high risk, so it stays "planned" until a conformity process is agreed.
- **Named student results:** shown to a lecturer only when the student opts in, and labelled advisory.
- **Transparency (Art. 50):** the assistant says it is an AI; spoken voices are labelled as synthetic (a small "AI voice" tag in Settings and on the voice control); AI-written notes carry an "AI-generated" label. All are static text.
- **AI literacy (Art. 4):** a short page for lecturers and students on what Citrus does, where it can be wrong and how to switch it off.

## P8. Devices, cookies and the microphone (§ 25 TDDDG, ePrivacy)

- The session cookie and saved preferences are strictly necessary for the service the user asked for, so **no cookie banner** is needed. Keep it that way: no analytics, advertising or third-party scripts and trackers.
- The microphone is used only after the person grants the browser's own permission, only for the voice feature they started, and a visible indicator shows when it is on.
- Lecture transcription listens to the lecturer. Students speaking in the room may be picked up, so the lecturer is shown a notice, and ambient speech is processed live and not kept unless the lecturer opts in.
- Staff data: lecturer use of classroom tools may need agreement with the staff council (Personalrat). This is for the university to arrange.

## P9. Governance (Art. 24, 30, 35, 37)

One-off documents, no runtime impact. The university's DPO owns them.
1. **Records of processing (Art. 30):** a table of the data above, its purpose, basis, recipients and period. Most of this document can fill it.
2. **DPIA (Art. 35):** very likely required (new technology, systematic monitoring of students at scale). It should cover P2 to P8 and the risk of identifying students in small classes.
3. **Privacy notice and Impressum:** in German and English, linked from the footer and the join screen.
4. **DPO and a contact address** shown in the app.

## P10. Breaches and incidents (Art. 33, 34)

- A written runbook: detect, contain, assess, notify the supervisory authority within 72 hours if there is a risk to people, tell affected people if the risk is high.
- Support: the audit log, deployment logs and per-lecture keys let us show what was and was not readable. Encrypted lecturer content that was not decrypted is a strong point in an assessment.
- A yearly test restore of the database backup (see `LOOSE_ENDS.md`).

## What we deliberately do not do

These would slow or annoy users without making the app safer:
- No cookie consent banner (nothing needs one).
- No consent pop-up before each lecture (the public task covers it; the opt-ins are separate).
- No per-request logging of student reads, and no encryption of high-traffic tables.
- No blocking checks on the live path. Everything above runs off it.
- No end-to-end encryption that would stop the server reading text for AI features.

## Build order

1. P2 and P3 (in progress): remove class data from student views, split student and lecturer loaders, encrypt lecturer content.
2. P5: the export and delete coverage test, and the two opt-out switches.
3. P4: retention periods in the maintenance job, configurable per institution.
4. P7 and P8: AI and voice labels, the join-screen notice, the literacy page.
5. P6, P9, P10: contracts, sub-processor list, privacy notice, records of processing, DPIA and the breach runbook, with the DPO.
