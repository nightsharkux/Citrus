# Citrus: Data Service and Privacy Agreement

**Version 0.1 (draft for review) · English · a German version is to follow and, for use in Germany, should be the binding text**

> **How to use this draft.** Text in [square brackets] is a placeholder or a point to confirm. Before real students, lecturers or administrators use Citrus, the university's data-protection officer and legal counsel must review this document, fill the brackets, and decide who the controller is (see *Drafting notes*). It describes what Citrus does today, as built; if the software changes, this document changes with it. It is not legal advice.

---

## Drafting notes (remove before publishing)

1. **Controller.** For lectures, courses and student accounts the controller is normally the university [e.g. *Ostbayerische Technische Hochschule Amberg-Weiden*, written approval to use that name is still needed]. If a person other than the university runs the service during a pilot, a data-processing agreement under Art. 28 GDPR between the university and the operator is also needed. This document assumes: **controller = [University]**, **operator and processor = [M. Mangena / operating entity]**.
2. **Legal bases for a Bavarian public university** are to be confirmed against the Bavarian Data Protection Act (BayDSG) and the Bavarian Higher Education Act (BayHIG). They are written here as *public task, Art. 6(1)(e) GDPR with [Art. 4 BayDSG]*.
3. **Staff.** Lecturers are employees. Their use of classroom tools may need agreement with the staff council (*Personalrat*) and a legal basis under [Art. 88 GDPR, § 26 BDSG / Art. 103 BayDSG].
4. **Impressum**, the DPO's contact details, the list of processors with their contracts, the data-protection impact assessment (DPIA) and the records of processing (Art. 30) are separate documents, referred to below.
5. **Retention periods** are the software's defaults. The university sets the real ones in Admin → Institution → Data retention.

---

# Part A: for everyone

## 1. What this agreement is

This agreement explains how Citrus (the "Service") handles personal data and on what terms you may use it. By creating an account, signing in, or joining a lecture as a guest, you confirm that you have read it. Parts B, C and D add what applies to **students**, **lecturers** and **administrators**. If you hold more than one role, each part applies to you in that role.

Citrus is [a student project / a pilot service] run by [operator] for [University]. It is provided as is, without a guarantee that it is always available.

## 2. Who is responsible

| | |
|---|---|
| **Controller** | [University name, address], represented by [name/office] |
| **Data-protection officer** | [name], [email], [address] |
| **Operator (processor)** | [M. Mangena / entity], [email], [address] |
| **Supervisory authority** | [Der Bayerische Landesbeauftragte für den Datenschutz (BayLfD), Wagmüllerstraße 18, 80538 München: confirm which authority is competent] |

## 3. The data Citrus handles, why, and on what basis

| Data | Purpose | Legal basis |
|---|---|---|
| **Account:** name, university email, password (stored only as a salted hash), role, last sign-in; or your university single sign-on identifier | to give you an account and keep it secure | public task, Art. 6(1)(e) [with Art. 4 BayDSG] |
| **Courses:** your enrolments, your timetable and the settings you choose | to run teaching and show you your own schedule | public task |
| **How you follow in a lecture:** "following / unsure / lost", the minute, and your own flags (a kind, an optional note you write) | to let the lecturer adjust the teaching and to help you review the parts you found hard | public task |
| **Attendance in a lecture** (that you joined; whether you chose to show your name) | to count who is in the room; showing your name is **optional** | public task; showing your name: **consent**, Art. 6(1)(a) |
| **What the lecturer says**, from speech recognition, if the lecturer chooses to keep a transcript; optional audio kept by the Android app | to write lecture notes and reviews for the lecturer, and to help students with the parts they struggled with | public task; the lecturer's own choice to keep it |
| **Your conversations with the assistant**, the notes and files you attach, and what it remembers about your preferences | to answer you and to help you study | public task; for what you attach: consent by attaching |
| **Voice:** your microphone audio, only while you use a voice feature you started | speech recognition and spoken answers | consent, Art. 6(1)(a): the browser asks for microphone permission |
| **Check-ins** (NFC card or code), room and device events | attendance and room status where the university uses them | public task |
| **Security and operation:** sign-in sessions, a security log of important changes, technical error logs | to keep the Service secure and working | public task / legitimate operation of the controller's systems [confirm basis] |
| **Guests:** a throwaway account made when you join a lecture by its QR code, with the name you choose (optional) | to let you take part without registering | consent |

Citrus does **not** use advertising or analytics trackers, does not sell data, and does not infer emotions, attention or personality from your face or voice.

## 4. Who sees what

- **Students' answers are anonymous to the lecturer**, shown only as totals, unless the student chooses to show their name for that lecture. Flags are shown without names.
- **A student sees only their own results**, never how the class did, and never a summary of the lecture. After a lecture, Citrus helps a student only with the parts they themselves found hard.
- **A lecturer sees** the class totals, the anonymous flags, the lecture record and, for students who chose it, those students' names and answers.
- **Administrators** manage the institution's settings and accounts. [In the current software an administrator can also open the lecturer's view of any course in their institution, including its lecture records. Private assistant conversations are not shown to administrators. The university should decide whether to restrict the first, and this text must then match.]
- **What a lecturer says** is stored **encrypted**, with a separate key for each lecture, and opens only for the lecturer who teaches it or as input to an AI request.

## 5. Artificial intelligence

- The assistant, lecture notes, flag explanations, study notes and spoken voices are produced by AI models. They can be wrong. **Check anything important** before relying on it. Voices are labelled as AI-generated.
- Citrus gives the models only the text a feature needs. Lecture records and the notes written from them carry no names or account numbers of students. [Confirm what the personal assistant's context contains, for example a first name, and state it here; confirm with each provider that data is not stored beyond the request and not used for training.]
- AI output is **advice only**. It is never used to grade, rank, admit, discipline or otherwise decide anything about a student.
- You can switch AI features off in your settings, and the institution can switch any of them off for everyone.

## 6. Who else handles the data (processors) and transfers abroad

Citrus uses the following services. Each is bound by a contract that allows it to process the data only for us [contracts to be concluded and confirmed].

| Service | What it does | Location |
|---|---|---|
| [Vercel Inc.] | hosts the application and serves files | [region: Dublin, Ireland; confirm] |
| [Turso / ChiselStrike] | the database | [region: confirm] |
| [Vercel Blob] | stores uploaded files and kept audio | [region: confirm] |
| [Vercel AI Gateway and the model providers it routes to, e.g. OpenAI, Google, Microsoft, Perplexity, ElevenLabs: list the ones actually enabled] | AI answers, notes, search, speech | [confirm, may be outside the EU] |
| [Deepgram, Wispr Flow] (only if enabled) | speech recognition | [confirm] |
| Your browser's own speech recognition (Chrome or Edge send audio to Google or Microsoft) | speech recognition when no other service is set | outside the Service's control |
| [University single sign-on; Moodle] (if connected) | sign-in; course data | the university |

Where data leaves the European Economic Area, it is covered by an adequacy decision (for the United States, the EU-US Data Privacy Framework, for certified providers) or by standard contractual clauses, [to be confirmed for each provider].

## 7. How long data is kept

| Data | Kept |
|---|---|
| Account and course data | while your account exists; removed when you delete it |
| Your answers in a lecture | while your account exists; after you delete it they remain only as anonymous class data |
| Lecture transcripts, trouble-moment excerpts, kept audio, and the notes and explanations on flags | [365] days after they were written, unless the institution sets another period (or 0 to keep) |
| Meeting recordings | until their owner deletes them, or the institution's period |
| Guest accounts | removed or retired after [30] idle days |
| Security log | [180] days |
| Notifications and device events | [30 to 180] days |
| Sign-in sessions | until they expire or you end them |

## 8. How the data is protected

Connections are encrypted (TLS). Passwords are stored only as salted hashes. What lecturers say is stored encrypted with a key per lecture. Access is checked on the server for every request and limited by role and course. Important changes are written to a security log. The Service stores no advertising or analytics identifiers. Backups are [described in the records of processing].

If a breach puts personal data at risk, the controller will notify the supervisory authority within 72 hours where required, and affected people without undue delay where the risk is high.

## 9. Your rights

You can, at any time and free of charge:

- **access** your data and **take it with you**: Settings → Privacy → *Download my data* (a JSON file);
- **have it erased**: Settings → Privacy → *Delete my account*;
- **correct** what is wrong (your profile in Settings; for anything else write to the contact above);
- **restrict** or **object** to processing based on the public task, on grounds relating to your situation (Art. 18, 21 GDPR);
- **withdraw consent** (for example by hiding your name in a lecture, by not using voice, or by deleting what you attached) without affecting what happened before;
- **complain** to the supervisory authority named in section 2.

We answer within one month. The self-service functions above work at once.

## 10. Cookies and similar storage

Citrus stores a sign-in cookie and a few preferences (language, theme, voice choices) on your device. These are strictly necessary for the service you asked for, so no consent banner is needed. Citrus sets no tracking or advertising cookies.

## 11. Acceptable use

You will not: access another person's data or account; try to identify people who are anonymous; probe or disrupt the Service; upload unlawful material, malware, or other people's personal data without a right to; use the Service to harass, to cheat in assessments, or to record people without the notice required by law.

## 12. Responsibility, changes, law

The Service is provided without warranty of availability or fitness for a particular purpose. [Liability: limited to intent and gross negligence, and to the extent the law allows; to be settled by counsel.] We may change this agreement when the Service or the law changes; we will show the new version and its date in the app, and for material changes ask you to confirm it. German law applies [subject to mandatory rules]; the place of jurisdiction is [confirm].

---

# Part B: students (and guests)

1. **Your answers are yours.** "Following / unsure / lost" and your flags are tied to your account only so you can see your own results. The lecturer sees totals and anonymous flags. You choose, lecture by lecture, whether to show your name; you can change it later.
2. **You see only your own results.** Citrus does not show you how the class did, and does not give you a summary of the lecture. It helps you with the parts **you** found hard, using your own answers and flags.
3. **Flags are not graded.** What you flag, and the notes you write, are never used to grade, rank or discipline you. Write about the lecture, not about people. Do not put sensitive personal data (health, beliefs, and the like) into a note.
4. **The assistant and AI notes** can be wrong. You remain responsible for your learning and for any work you submit.
5. **Voice.** Voice features use your microphone only after you allow it and only while you use them. Turning the microphone off at any time stops them.
6. **Guests.** A guest account is temporary and holds only what you do in that lecture. It is removed or retired after [30] idle days. A guest can ask for it to be deleted at any time.
7. **Leaving.** You can download your data and delete your account at any time (section 9 of Part A). Your answers then remain only as anonymous class data.

# Part C: lecturers

1. **Your role.** You use Citrus in your teaching under the university's authority. The university remains responsible for the data; you are responsible for using it correctly.
2. **Tell your students.** At the start of the course, tell students that Citrus is used, what it collects (Part A, section 3) and that their answers are anonymous to you unless they choose otherwise.
3. **Anonymity.** Do not try to identify students from anonymous totals or flags, for example by running a lecture with so few answers that one person stands out. Where a student has chosen to show their name, use what they shared only to help them, for example a word after class, never to grade or sanction.
4. **No assessment use.** Do not use Citrus's feedback, notes or AI output to grade, rank, admit or discipline a student, or to monitor an exam. [This keeps Citrus outside the high-risk uses in Annex III of the EU AI Act.]
5. **Your own voice and recordings.** Listening in a lecture captures your speech and may capture students who speak. A transcript is kept only if you choose to keep it. Audio is kept only if you use the Android app's recording and tell the room. Do not record or keep audio without the notice and, where required, the consent the law demands. You can delete a chapter, the audio, or the whole record at any time. Transcripts and kept audio are removed after the institution's period.
6. **What you upload.** Notes and files you add are shown to your students as the university permits. Do not upload anything you have no right to share, and no other people's personal data.
7. **AI output.** Review lecture notes, reviews and explanations before you share or rely on them. They are suggestions.
8. **Staff data.** Your use is logged as described in section 8. [Staff-council agreement / staff data legal basis to be inserted.] You have the rights in section 9 for your own data.
9. **Incidents.** Tell [the DPO / operator] without delay if you suspect a breach, for example a lecture file sent to the wrong person.

# Part D: administrators

1. **Your role.** You manage the institution's accounts and settings on behalf of the controller. Use your powers only for that purpose and only as far as your task requires.
2. **Access.** Give roles and course assignments on the principle of least privilege. Approve lecturers only after verifying who they are. Remove accounts and access promptly when someone leaves.
3. **Settings you own.** You set the institution's retention periods, sign-in rules (university login, open registration) and which AI features are on. Keep retention as short as the purpose allows (Part A, section 7), and record any change and its reason.
4. **Confidentiality.** You can reach account and technical data. Do not look at a person's data without a task-related reason, do not copy it elsewhere, and keep the confidentiality duty after you stop being an administrator. Your actions in the Service are logged.
5. **Requests from people.** Pass any request about access, erasure, objection or complaint to the data-protection officer at once. Most of them the person can do themselves in Settings → Privacy.
6. **Processors and contracts.** Keep the list of processors, their contracts and their locations current (section 6), and tell the DPO before enabling a new AI provider or speech service.
7. **Incidents.** Report a suspected breach to the DPO immediately and in any case within [24] hours, so that the 72-hour notification period to the authority can be met. Help to contain and document it.
8. **Backups and keys.** The master encryption key and the database backups are part of the protection of the data. Store them as the operator's security instructions say, never in the code repository, and test a restore at least once a year.
9. **Records.** Help keep the records of processing, the DPIA and this agreement up to date when the Service changes.

---

# Part E: acceptance

| Role | How acceptance is recorded |
|---|---|
| **Students** | a short notice at registration and on joining a lecture, linking to this agreement; optional items (showing your name, voice) are separate choices |
| **Guests** | the notice shown when joining by QR code |
| **Lecturers** | confirmation at first sign-in as a lecturer, [and the staff-council agreement where required] |
| **Administrators** | confirmation at first sign-in as an administrator, and the data-processing agreement between the university and the operator |

*Version 0.1 · [date] · [University] and [operator]*
