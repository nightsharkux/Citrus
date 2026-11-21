'use strict';
/**
 * Nutzungsbedingungen und Datenschutz, deutsche Fassung (die maßgebliche). Jede Rolle bekommt ihre eigene Fassung:
 * Studierende, Gäste, Dozierende, Administration. Vier Abschnitte, wie man sie von Websites kennt:
 * Nutzungsbedingungen, Datenschutzerklärung, Cookie-Richtlinie, Aufbewahrung und Löschung.
 *
 * Die Anrede ist "Sie" (Rechtstext); die Benutzeroberfläche selbst spricht mit "du". Die englische Fassung
 * (policy-en.js) hat dieselben Abschnitte und dieselbe Versionsnummer.
 */

const ROLE = {
  student: { label: 'Studierende', who: 'Studierende, die Citrus mit einem Konto nutzen' },
  guest: { label: 'Gäste', who: 'Gäste, die über den QR-Code oder Code einer Vorlesung ohne Konto teilnehmen' },
  lecturer: { label: 'Dozierende', who: 'Dozierende, die Citrus in ihrer Lehre einsetzen' },
  admin: { label: 'Administration', who: 'Administratorinnen und Administratoren, die die Konten und Einstellungen einer Einrichtung verwalten' },
};

const kept = (n) => (Number(n) > 0 ? `${Number(n)} Tage nach ihrer Entstehung (Einstellung der Einrichtung)` : 'bis sie gelöscht werden (Einstellung der Einrichtung)');

function build({ role, institution, legal, lectureTextRetentionDays, hosting, VERSION, UPDATED }) {
  const is = (...roles) => roles.includes(role);
  const controller = legal.controller || institution;
  const dpo = legal.dpo || 'die oder der Datenschutzbeauftragte Ihrer Einrichtung, deren oder dessen Kontaktdaten Ihre Einrichtung veröffentlicht';
  const contact = legal.contact || 'die oder der Datenschutzbeauftragte';
  const authority = legal.authority || 'die für Ihre Einrichtung zuständige Datenschutzaufsichtsbehörde';
  const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
  const list = (items) => items.filter(Boolean).map((t) => `- ${t}`).join('\n');
  const numbered = (items) => items.filter(Boolean).map((t, i) => `${i + 1}. ${t}`).join('\n');

  // ---------------------------------------------------------------- Das Wichtigste in Kürze
  const summary = {
    student: [
      'Ihre Antworten in der Vorlesung sind für die Lehrperson anonym, solange Sie nicht selbst Ihren Namen zeigen.',
      'Sie sehen nur Ihre eigenen Ergebnisse, nie die der Gruppe und nie eine Zusammenfassung der Vorlesung.',
      'Citrus nutzt KI. Sie kann Fehler machen und wird nie verwendet, um Sie zu benoten oder zu bewerten.',
      'Es gibt keine Werbung und keine Tracker, nur unbedingt erforderliche Cookies.',
      'Sie können Ihre Daten jederzeit herunterladen oder Ihr Konto löschen.',
    ],
    guest: [
      'Sie nehmen ohne Konto teil. Ihr Gast-Zugang wird nach 30 Tagen ohne Nutzung stillgelegt.',
      'Gespeichert werden nur Ihr Name (freiwillig), Ihre Antworten und Markierungen in dieser Vorlesung.',
      'Die Lehrperson sieht Ihre Antworten nur als Summen, es sei denn, Sie zeigen Ihren Namen.',
      'Citrus setzt ein einziges, unbedingt erforderliches Cookie für Ihre Sitzung, keine Werbung, keine Tracker.',
      'Sie können jederzeit die Löschung Ihres Gast-Zugangs verlangen.',
    ],
    lecturer: [
      'Sie nutzen Citrus im Auftrag Ihrer Einrichtung und informieren Ihre Studierenden darüber.',
      'Antworten und Markierungen sehen Sie anonym; Namen nur, wenn Studierende sie bewusst zeigen.',
      'Das, was Sie sagen, wird nur mit Ihrer Entscheidung gespeichert, verschlüsselt und nach der Frist der Einrichtung gelöscht.',
      'KI-Ergebnisse dürfen nicht zum Benoten, Bewerten oder Überwachen von Prüfungen verwendet werden.',
      'Es gibt keine Werbung und keine Tracker, nur unbedingt erforderliche Cookies.',
    ],
    admin: [
      'Sie handeln im Auftrag der Einrichtung und nutzen Ihre Befugnisse nur für Ihre Aufgabe.',
      'Ihre Handlungen im Dienst werden protokolliert (180 Tage).',
      'Sie legen Aufbewahrungsfristen und rechtliche Angaben fest und melden Vorfälle innerhalb von 24 Stunden.',
      'Jede bedeutsame Änderung dieser Bedingungen bedeutet eine neue Version, der alle erneut zustimmen müssen.',
      'Es gibt keine Werbung und keine Tracker, nur unbedingt erforderliche Cookies.',
    ],
  }[role];

  // ---------------------------------------------------------------- 1. Nutzungsbedingungen
  const access = {
    student: 'Sie nutzen Citrus mit einem Konto, das auf Ihre Hochschul-E-Mail-Adresse oder Ihre Hochschulanmeldung eingerichtet ist. Halten Sie Ihr Passwort geheim und geben Sie Ihr Konto nicht weiter. Sie können Ihr Konto jederzeit selbst löschen.',
    guest: 'Sie nehmen ohne Konto teil. Beim Beitritt entsteht ein vorübergehender Gast-Zugang, der für diese Vorlesung gedacht ist. Geben Sie den Code oder QR-Code nicht außerhalb des Hörsaals weiter.',
    lecturer: 'Dozierendenzugang bestätigt die Administration Ihrer Einrichtung. Sie nutzen Citrus in Ihrer Lehre im Auftrag Ihrer Einrichtung; sie bleibt für die Daten verantwortlich, Sie sind dafür verantwortlich, sie richtig zu verwenden. Halten Sie Ihr Passwort geheim.',
    admin: 'Administrationszugang gibt Ihnen weitreichende Befugnisse. Sie verwalten Konten und Einstellungen der Einrichtung im Auftrag des Verantwortlichen. Halten Sie Ihr Passwort geheim, verwenden Sie, wo möglich, die Hochschulanmeldung und geben Sie Ihr Konto nie weiter.',
  }[role];

  const duties = {
    student: [
      '**Ihre Antworten gehören Ihnen.** „Ich folge“, „unsicher“ oder „abgehängt“ und Ihre Markierungen sind nur deshalb mit Ihrem Konto verbunden, damit Sie Ihre eigenen Ergebnisse sehen können. Sie entscheiden Vorlesung für Vorlesung, ob Sie Ihren Namen zeigen.',
      '**Markierungen werden nicht benotet.** Was Sie markieren und welche Notizen Sie schreiben, wird nie verwendet, um Sie zu benoten, zu ranken oder zu disziplinieren. Schreiben Sie über die Vorlesung, nicht über Personen, und geben Sie keine sensiblen personenbezogenen Daten (Gesundheit, Weltanschauung und Ähnliches) in eine Notiz ein.',
      '**Der Assistent und KI-Notizen können falsch sein.** Sie bleiben für Ihr Lernen und für alle Arbeiten verantwortlich, die Sie abgeben.',
      '**Sprache.** Sprachfunktionen verwenden Ihr Mikrofon nur, nachdem Sie es erlaubt haben, und nur, solange Sie sie nutzen.',
    ],
    guest: [
      '**Ihre Antworten gehören Ihnen.** Ihre Antworten und Markierungen sind für die Lehrperson Summen und anonyme Markierungen. Sie entscheiden, ob Sie Ihren Namen zeigen.',
      '**Markierungen werden nicht benotet.** Schreiben Sie über die Vorlesung, nicht über Personen, und geben Sie keine sensiblen personenbezogenen Daten in eine Notiz ein.',
      '**KI-Antworten können falsch sein.** Prüfen Sie Wichtiges nach.',
      '**Sprache.** Sprachfunktionen verwenden Ihr Mikrofon nur, nachdem Sie es erlaubt haben, und nur, solange Sie sie nutzen.',
    ],
    lecturer: [
      '**Informieren Sie Ihre Studierenden.** Sagen Sie zu Beginn des Kurses, dass Citrus eingesetzt wird, was es erhebt und dass ihre Antworten Ihnen gegenüber anonym sind, wenn sie sich nicht anders entscheiden.',
      '**Wahren Sie die Anonymität.** Versuchen Sie nicht, Studierende aus anonymen Summen oder Markierungen zu identifizieren, zum Beispiel indem Sie eine Vorlesung mit so wenigen Antworten halten, dass eine Person heraussticht. Wenn Studierende ihren Namen gezeigt haben, nutzen Sie das nur, um zu helfen, etwa mit einem Wort nach der Vorlesung, nie um zu benoten oder zu sanktionieren.',
      '**Keine Nutzung für Prüfungen.** Verwenden Sie Feedback, Notizen oder KI-Ergebnisse von Citrus nicht, um Studierende zu benoten, zu ranken, zuzulassen oder zu disziplinieren oder um eine Prüfung zu überwachen. So bleibt Citrus außerhalb der Hochrisiko-Anwendungen nach Anhang III der EU-KI-Verordnung.',
      '**Ihre eigene Stimme und Aufnahmen.** Das Mithören in einer Vorlesung erfasst Ihre Sprache und kann sprechende Studierende erfassen. Eine Mitschrift wird nur gespeichert, wenn Sie das wählen; Audio nur, wenn Sie die Aufnahme der Android-App nutzen und den Raum informieren. Nehmen Sie nichts auf ohne die vom Recht verlangte Information und, wo erforderlich, Einwilligung. Sie können jederzeit ein Kapitel, das Audio oder das ganze Protokoll löschen.',
      '**Was Sie hochladen.** Laden Sie nichts hoch, wozu Sie kein Recht zum Teilen haben, und keine personenbezogenen Daten anderer. Notizen und Dateien werden Ihren Studierenden so angezeigt, wie Ihre Einrichtung es erlaubt.',
      '**KI-Ergebnisse prüfen.** Prüfen Sie Vorlesungsnotizen, Auswertungen und Erklärungen, bevor Sie sie weitergeben oder sich darauf verlassen. Sie sind Vorschläge.',
      '**Vorfälle melden.** Informieren Sie ' + contact + ' unverzüglich, wenn Sie eine Verletzung vermuten, zum Beispiel eine an die falsche Person gesendete Vorlesungsdatei. Wo das Recht es verlangt, wird der Einsatz von Werkzeugen im Unterricht durch Beschäftigte mit der Personalvertretung abgestimmt.',
    ],
    admin: [
      '**Geringste Berechtigung.** Vergeben Sie Rollen und Kurszuordnungen nach dem Grundsatz der geringsten Berechtigung. Bestätigen Sie Dozierende erst, nachdem Sie ihre Identität geprüft haben, und entfernen Sie Konten und Zugriffe zügig, wenn jemand ausscheidet.',
      '**Einstellungen in Ihrer Verantwortung.** Sie legen Aufbewahrungsfristen, Anmelderegeln (Hochschulanmeldung, offene Registrierung), die eingeschalteten KI-Funktionen und die in diesen Bedingungen angezeigten rechtlichen Angaben fest (Admin → Hochschule). Halten Sie die Aufbewahrung so kurz, wie der Zweck es erlaubt, und dokumentieren Sie jede Änderung mit ihrem Grund.',
      '**Vertraulichkeit.** Sie können Konto- und technische Daten erreichen. Sehen Sie sich Daten einer Person nicht ohne aufgabenbezogenen Grund an, kopieren Sie sie nicht anderswohin und wahren Sie die Vertraulichkeit auch nach Ihrer Zeit als Administratorin oder Administrator.',
      '**Anfragen von Personen.** Leiten Sie jede Anfrage zu Auskunft, Löschung, Widerspruch oder Beschwerde sofort an ' + contact + ' weiter. Die meisten können die Personen selbst unter Einstellungen → Deine Daten erledigen.',
      '**Auftragsverarbeiter und Verträge.** Halten Sie die Liste der Auftragsverarbeiter, ihrer Verträge und Standorte aktuell und informieren Sie die oder den Datenschutzbeauftragte(n), bevor Sie einen neuen KI-Anbieter oder Sprachdienst einschalten.',
      '**Vorfälle.** Melden Sie eine vermutete Verletzung sofort an ' + contact + ', in jedem Fall innerhalb von 24 Stunden, damit die Meldefrist von 72 Stunden an die Aufsichtsbehörde eingehalten werden kann.',
      '**Sicherungen und Schlüssel.** Der Hauptschlüssel der Verschlüsselung und die Datenbanksicherungen gehören zum Schutz der Daten. Bewahren Sie sie so auf, wie die Sicherheitsanweisungen des Betreibers es vorsehen, nie im Code-Repository, und testen Sie mindestens einmal im Jahr eine Wiederherstellung.',
      '**Verzeichnisse.** Helfen Sie, das Verzeichnis der Verarbeitungstätigkeiten, die Datenschutz-Folgenabschätzung und diese Bedingungen aktuell zu halten.',
    ],
  }[role];

  const terms = `### 1. Geltungsbereich und Zustimmung

Diese Nutzungsbedingungen gelten für ${ROLE[role].who}. **Sie müssen ihnen und der Datenschutzerklärung zustimmen, um Citrus zu nutzen**: durch das Setzen des Häkchens bei der Registrierung oder beim Beitritt und bei der ersten Anmeldung nach einer Änderung. Wir speichern, welcher Version Sie wann zugestimmt haben. Nutzungsbedingungen, Datenschutzerklärung, Cookie-Richtlinie und Aufbewahrung gehören zusammen. Maßgeblich ist die deutsche Fassung; die englische dient dem besseren Verständnis.

### 2. Der Dienst

Citrus ist ein von Studierenden entwickelter Dienst, der für ${controller} betrieben wird. Er wird so bereitgestellt, wie er ist, ohne Zusicherung, dass er jederzeit verfügbar ist.

### 3. Ihr Zugang

${access}

### 4. Was in Ihrer Rolle gilt

${numbered(duties)}

### 5. Zulässige Nutzung

Sie werden nicht auf Daten oder Konten anderer Personen zugreifen; nicht versuchen, anonyme Personen zu identifizieren; den Dienst nicht ausspähen oder stören; keine rechtswidrigen Inhalte, Schadsoftware oder personenbezogenen Daten anderer ohne Berechtigung hochladen; und den Dienst nicht nutzen, um zu belästigen, bei Prüfungen zu täuschen oder Personen ohne die gesetzlich erforderliche Information aufzuzeichnen.

### 6. Künstliche Intelligenz

Der Assistent, Vorlesungsnotizen, Erklärungen, Lernnotizen und gesprochene Stimmen werden von KI-Modellen erzeugt, die falsch liegen können. **Prüfen Sie Wichtiges nach**, bevor Sie sich darauf verlassen. Stimmen sind als KI-erzeugt gekennzeichnet. KI-Ergebnisse sind nur Hilfestellung und werden niemals verwendet, um Studierende zu benoten, zu ranken, zuzulassen, zu disziplinieren oder sonst etwas über sie zu entscheiden.${is('student', 'lecturer', 'guest') ? ' Sie können KI-Funktionen in Ihren Einstellungen ausschalten.' : ' Sie können KI-Funktionen für die Einrichtung ausschalten.'}

### 7. Verfügbarkeit, Haftung und anwendbares Recht

Der Dienst wird ohne Gewähr für Verfügbarkeit oder Eignung für einen bestimmten Zweck bereitgestellt. Die Haftung ist, soweit gesetzlich zulässig, auf Vorsatz und grobe Fahrlässigkeit sowie auf die Verletzung von Pflichten beschränkt, die für die Nutzung des Dienstes wesentlich sind; eine gesetzlich nicht beschränkbare Haftung bleibt unberührt. Es gilt deutsches Recht, vorbehaltlich zwingender Vorschriften zu Ihrem Schutz; Gerichtsstand ist der Sitz des Verantwortlichen.

### 8. Änderungen

Dies ist Version ${VERSION}, Stand ${UPDATED}. Ändern sich der Dienst oder das Recht in einer für Sie bedeutsamen Weise, ändert sich die Version, und Sie werden bei der nächsten Nutzung gebeten, sie erneut zu lesen und ihr zuzustimmen. Bis dahin können Sie sie lesen, Ihre Daten herunterladen oder Ihr Konto löschen, den übrigen Dienst aber nicht nutzen. Kleine Korrekturen, die keine Rechte ändern, ändern die Version nicht.`;

  // ---------------------------------------------------------------- 2. Datenschutzerklärung
  const data = [
    [['student', 'lecturer', 'admin'], '**Konto:** Name, Hochschul-E-Mail-Adresse, Passwort (nur als gesalzener Hash gespeichert), Rolle, letzte Anmeldung; oder Ihre Kennung der Hochschulanmeldung (Single Sign-on)', 'um Ihnen ein Konto bereitzustellen und es zu schützen', 'öffentliche Aufgabe, Art. 6 Abs. 1 lit. e DSGVO i. V. m. dem anwendbaren Landesrecht'],
    [['guest'], '**Gast-Zugang:** ein Wegwerf-Konto ohne E-Mail-Adresse und Passwort, mit dem Namen, den Sie wählen (freiwillig)', 'damit Sie teilnehmen können, ohne sich zu registrieren', 'Einwilligung, Art. 6 Abs. 1 lit. a DSGVO'],
    [['student', 'lecturer', 'admin'], role === 'lecturer' ? '**Kurse:** Ihre Kurse, Vorlesungen, Themen und Zuordnungen' : role === 'admin' ? '**Kurse und Zuordnungen:** Kurse, Dozierende, Einschreibungen' : '**Kurse:** Ihre Einschreibungen, Ihr Stundenplan und die Einstellungen, die Sie wählen', 'um die Lehre durchzuführen und Stundenpläne zu zeigen', 'öffentliche Aufgabe'],
    [['student', 'guest'], '**Wie Sie in einer Vorlesung folgen:** „Ich folge“, „unsicher“ oder „abgehängt“, die Minute und Ihre eigenen Markierungen (eine Art und eine freiwillige Notiz von Ihnen)', 'damit die Lehrperson die Lehre anpassen kann und Sie die Stellen wiederholen können, die Ihnen schwerfielen', is('guest') ? 'Einwilligung' : 'öffentliche Aufgabe'],
    [['student', 'guest'], '**Teilnahme an einer Vorlesung:** dass Sie beigetreten sind und ob Sie Ihren Namen zeigen wollten', 'um zu zählen, wer im Raum ist; das Zeigen Ihres Namens ist freiwillig', 'öffentliche Aufgabe; Zeigen des Namens: Einwilligung, Art. 6 Abs. 1 lit. a DSGVO'],
    [['lecturer'], '**Was Sie in der Vorlesung sagen**, aus der Spracherkennung, wenn Sie das Speichern einer Mitschrift wählen; auf Wunsch von der Android-App gespeicherte Aufnahmen', 'um Notizen und Auswertungen für Sie zu erstellen und Studierende bei den Stellen zu unterstützen, die ihnen schwerfielen', 'öffentliche Aufgabe; Ihre eigene Entscheidung, es zu speichern'],
    [['lecturer'], '**Kursmaterial und Notizen**, die Sie hochladen', 'um sie Ihren Studierenden anzuzeigen und für Ihre Vorlesungen zu nutzen', 'öffentliche Aufgabe'],
    [['student', 'guest', 'lecturer', 'admin'], '**Ihre Gespräche mit dem Assistenten**, die Dateien, die Sie anhängen, und was er sich zu Ihren Vorlieben merkt', 'um Ihnen zu antworten und Sie zu unterstützen', 'öffentliche Aufgabe; für Angehängtes: Einwilligung durch das Anhängen'],
    [['student', 'guest', 'lecturer', 'admin'], '**Sprache:** Ihr Mikrofon-Audio, nur solange Sie eine von Ihnen gestartete Sprachfunktion nutzen', 'Spracherkennung und gesprochene Antworten', 'Einwilligung, Art. 6 Abs. 1 lit. a DSGVO; Ihr Browser fragt nach der Mikrofonberechtigung'],
    [['student', 'lecturer', 'admin'], '**Anwesenheitskontrolle** (NFC-Karte oder Code), Raum- und Geräteereignisse', 'Anwesenheit und Raumstatus, wo die Einrichtung dies einsetzt', 'öffentliche Aufgabe'],
    [['admin'], '**Protokoll der Administration:** Ihre wichtigen Änderungen an Konten und Einstellungen', 'Nachvollziehbarkeit und Sicherheit', 'öffentliche Aufgabe'],
    [['student', 'guest', 'lecturer', 'admin'], '**Sicherheit und Betrieb:** Anmeldesitzungen, ein Protokoll wichtiger Änderungen, technische Fehlerprotokolle', 'um den Dienst sicher und funktionsfähig zu halten', 'öffentliche Aufgabe'],
    [['student', 'guest', 'lecturer', 'admin'], '**Ihre Zustimmung:** die Version und das Datum', 'um nachzuweisen, dass Sie informiert wurden', 'rechtliche Verpflichtung, Art. 6 Abs. 1 lit. c DSGVO'],
  ].filter(([roles]) => roles.includes(role)).map(([, a, b, c]) => [a, b, c]);

  const sees = {
    student: [
      '**Ihre Antworten sind für die Lehrperson anonym.** Sie werden als Summen angezeigt, es sei denn, Sie entscheiden sich, für diese Vorlesung den Namen zu zeigen. Markierungen werden ohne Namen angezeigt.',
      '**Sie sehen nur Ihre eigenen Ergebnisse**, nie, wie die Gruppe abgeschnitten hat, und nie eine Zusammenfassung der Vorlesung. Nach einer Vorlesung unterstützt Citrus Sie nur bei den Stellen, die Ihnen selbst schwerfielen.',
      '**Die Lehrperson sieht** Summen, anonyme Markierungen und, nur wenn Sie es wählen, Ihren Namen mit Ihren Antworten.',
      '**Die Administration** verwaltet Konten und Einstellungen und kann in der aktuellen Software die Ansicht der Lehrperson jedes Kurses der Einrichtung öffnen. Private Gespräche mit dem Assistenten werden ihr nicht angezeigt.',
    ],
    guest: [
      '**Ihre Antworten sind für die Lehrperson anonym**, sie sieht Summen und Markierungen ohne Namen, es sei denn, Sie zeigen Ihren Namen.',
      '**Sie sehen nur Ihre eigenen Ergebnisse**, nie, wie die Gruppe abgeschnitten hat.',
      '**Die Administration** kann in der aktuellen Software die Ansicht der Lehrperson jedes Kurses der Einrichtung öffnen.',
    ],
    lecturer: [
      '**Sie sehen** die Summen der Gruppe, die anonymen Markierungen, das Vorlesungsprotokoll und, bei Studierenden, die sich dafür entschieden haben, deren Namen und Antworten.',
      '**Studierende bleiben anonym**, wenn sie ihren Namen nicht zeigen; sie sehen nie, wie die Gruppe abgeschnitten hat.',
      '**Was Sie sagen**, wird verschlüsselt gespeichert, mit einem eigenen Schlüssel für jede Vorlesung. Es lässt sich nur für Sie als Lehrperson dieser Vorlesung öffnen oder als Eingabe für eine KI-Anfrage.',
      '**Die Administration** kann in der aktuellen Software Ihre Vorlesungsprotokolle über die Ansicht der Lehrperson öffnen. Private Gespräche mit dem Assistenten sieht sie nicht.',
    ],
    admin: [
      '**Sie sehen** Konto- und Einrichtungsdaten und können die Ansicht der Lehrperson jedes Kurses der Einrichtung öffnen, einschließlich der Vorlesungsprotokolle. Private Gespräche mit dem Assistenten werden Ihnen nicht angezeigt.',
      '**Was Dozierende sagen**, ist verschlüsselt gespeichert, mit einem Schlüssel pro Vorlesung.',
      '**Ihre Handlungen** werden im Sicherheitsprotokoll festgehalten.',
    ],
  }[role];

  const privacy = `### 1. Verantwortlicher und Kontakt

${table(['Rolle', 'Wer'], [
    ['Verantwortlicher', controller],
    ['Datenschutzbeauftragte(r)', dpo],
    ['Betreiber (Auftragsverarbeiter)', `der Betreiber dieser Citrus-Installation, der sie für ${controller} betreibt und die Daten nur nach dessen Weisung verarbeiten darf`],
    ['Fragen und Anliegen', contact],
    ['Aufsichtsbehörde', authority],
  ])}

### 2. Welche Daten wir verarbeiten, wozu und auf welcher Grundlage

${table(['Daten', 'Zweck', 'Rechtsgrundlage'], data)}

Citrus verwendet **keine** Werbe- oder Analyse-Tracker, verkauft keine Daten und schließt weder aus Ihrem Gesicht noch aus Ihrer Stimme auf Emotionen, Aufmerksamkeit oder Persönlichkeit.

### 3. Wer Ihre Daten sieht

${list(sees)}

### 4. Empfänger und Standorte

Citrus läuft in der Europäischen Union. Jeder der folgenden Dienste verarbeitet Daten nur für uns und aufgrund eines Vertrags, der ihn dazu verpflichtet.

${table(['Dienst', 'Was er tut', 'Wo'], [
    ['Vercel Inc.', 'betreibt die Anwendung und liefert ihre Dateien aus', hosting.app],
    ['Turso', 'die Datenbank', hosting.database],
    ['Vercel Blob', 'speichert hochgeladene Dateien und von der Android-App gespeicherte Aufnahmen', hosting.files],
    ['Vercel AI Gateway und die Modellanbieter, die darüber erreicht werden (zum Beispiel OpenAI, Google, Microsoft, Perplexity und ElevenLabs, je nach Funktion)', 'KI-Antworten, Notizen, Websuche und Sprache', 'Verarbeitung durch den Anbieter; möglicherweise außerhalb des Europäischen Wirtschaftsraums'],
    ['Deepgram oder Wispr Flow, nur wenn die Einrichtung sie einschaltet', 'Spracherkennung', 'Verarbeitung durch den Anbieter; möglicherweise außerhalb des Europäischen Wirtschaftsraums'],
    ['Die Spracherkennung Ihres Browsers (Chrome und Edge senden Audio an Google oder Microsoft)', 'Spracherkennung, wenn kein anderer Dienst eingestellt ist', 'außerhalb des Einflusses des Dienstes'],
    ['Das Single Sign-on der Einrichtung und Moodle, falls angebunden', 'Anmeldung und Kursdaten', 'die Einrichtung'],
  ])}

### 5. Künstliche Intelligenz und Übermittlung in Drittländer

Citrus gibt den KI-Modellen nur den Text, den eine Funktion braucht. Vorlesungsprotokolle und die daraus erstellten Notizen enthalten keine Namen oder Kontonummern von Studierenden. Der persönliche Assistent erhält Ihren Vornamen, Ihre Rolle und Ihre eigenen Kurs- und Stundenplanangaben, damit er Ihnen antworten kann${is('lecturer') ? '; in Ihren eigenen Vorlesungswerkzeugen kennt er auch Ihren Namen' : ''}.

Wo Daten den Europäischen Wirtschaftsraum verlassen, sind sie durch einen Angemessenheitsbeschluss (für die Vereinigten Staaten das EU-US Data Privacy Framework, für zertifizierte Anbieter) oder durch die Standardvertragsklauseln der Europäischen Kommission geschützt. Ein Anbieter wird nur eingesetzt, wenn eine dieser Garantien besteht. Die Anbieter sind verpflichtet, die Daten nicht länger zu speichern, als die Anfrage es erfordert, und sie nicht zum Training ihrer Modelle zu verwenden.

### 6. Ihre Rechte

Sie können jederzeit und kostenlos:

${list([
    '**Auskunft erhalten und Ihre Daten mitnehmen:** Einstellungen → Deine Daten → *Herunterladen*',
    '**die Löschung verlangen:** Einstellungen → Deine Daten → *Mein Konto löschen*' + (is('guest') ? ' oder per Nachricht an ' + contact : ''),
    '**Unrichtiges berichtigen** (Ihr Profil in den Einstellungen; für alles andere schreiben Sie an ' + contact + ')',
    '**der Verarbeitung widersprechen oder sie einschränken lassen**, soweit sie auf der öffentlichen Aufgabe beruht, aus Gründen, die sich aus Ihrer besonderen Situation ergeben (Art. 18 und 21 DSGVO)',
    '**Ihre Einwilligung widerrufen**, ohne dass dies die bisherige Verarbeitung berührt' + (is('student', 'guest') ? ', zum Beispiel indem Sie Ihren Namen in einer Vorlesung verbergen oder keine Sprachfunktion nutzen' : ''),
    '**sich bei der Aufsichtsbehörde beschweren:** ' + authority,
  ])}

Wir antworten innerhalb eines Monats. Die Selbstbedienungsfunktionen wirken sofort und bleiben auch verfügbar, wenn Sie der aktuellen Version noch nicht zugestimmt haben.

### 7. Sicherheit

Verbindungen sind verschlüsselt (TLS). Passwörter werden nur als gesalzene Hashes gespeichert. Was Dozierende sagen, wird mit einem Schlüssel pro Vorlesung verschlüsselt gespeichert. Der Zugriff wird bei jeder Anfrage auf dem Server geprüft und nach Rolle und Kurs begrenzt. Wichtige Änderungen werden in einem Sicherheitsprotokoll festgehalten. Die Datenbank wird von ihrem Anbieter gesichert, und der Verschlüsselungsschlüssel wird getrennt von der Datenbank aufbewahrt. Wenn eine Verletzung des Schutzes personenbezogener Daten ein Risiko mit sich bringt, meldet der Verantwortliche dies, wo erforderlich, innerhalb von 72 Stunden der Aufsichtsbehörde und benachrichtigt die Betroffenen unverzüglich, wenn das Risiko hoch ist.`;

  // ---------------------------------------------------------------- 3. Cookie-Richtlinie
  const cookies = `### 1. Was das ist

Cookies sind kleine Dateien, die eine Website in Ihrem Browser ablegt. Ähnlich arbeiten der lokale Speicher und der Sitzungsspeicher Ihres Browsers. Citrus nutzt sie nur, damit der Dienst funktioniert, den Sie aufgerufen haben.

### 2. Was Citrus auf Ihrem Gerät speichert

${table(['Name', 'Zweck', 'Dauer', 'Art'], [
    ['campus_session', 'hält Sie angemeldet (Anmeldesitzung; HttpOnly, nur über HTTPS gesendet)', '30 Tage ab Ihrer letzten Nutzung, danach gelöscht', 'Cookie, unbedingt erforderlich'],
    ['campus-lang', 'merkt sich Ihre Sprache', 'bis Sie es löschen', 'lokaler Speicher, erforderlich'],
    ['campus-theme', 'merkt sich hell, dunkel oder System', 'bis Sie es löschen', 'lokaler Speicher, erforderlich'],
    ['campus-voice', 'merkt sich Ihre Stimm- und Lautstärkeeinstellungen', 'bis Sie es löschen', 'lokaler Speicher, erforderlich'],
    ['campus-web, campus-intro-dismissed, citrus.island, citrus.sign', 'merken sich Einstellungen der Websuche, geschlossene Hinweise, die Lage der Werkzeugleiste und Ihr Schild', 'bis Sie es löschen', 'lokaler Speicher, erforderlich'],
    ['Zwischenstände der Seiten (zum Beispiel Mikrofon bei einer Besprechung)', 'halten einen Zustand, solange der Tab offen ist', 'bis Sie den Tab schließen', 'Sitzungsspeicher, erforderlich'],
    ['App-Dateien (Offline-Speicher)', 'lädt die App schneller und hält sie offline bereit; private Daten aus der Anwendung werden nicht zwischengespeichert', 'wird bei neuen Versionen ersetzt', 'Service Worker, erforderlich'],
  ])}

### 3. Keine Tracker, keine Werbung, keine Dritten

Citrus setzt keine Analyse-, Tracking- oder Werbe-Cookies und bindet keine Dienste Dritter ein, die eigene Cookies setzen. Da alles oben Genannte für den von Ihnen gewünschten Dienst unbedingt erforderlich ist (§ 25 Abs. 2 TDDDG), ist keine Einwilligung und deshalb kein Cookie-Banner nötig.

### 4. Ihre Kontrolle

Sie können Cookies und gespeicherte Daten jederzeit in Ihrem Browser löschen; dann werden Sie abgemeldet und Ihre Einstellungen auf diesem Gerät gehen verloren. Links zu anderen Websites (zum Beispiel eine Karte) öffnen Seiten Dritter mit eigenen Regeln.`;

  // ---------------------------------------------------------------- 4. Aufbewahrung und Löschung
  const rows = [
    [['student', 'lecturer', 'admin'], 'Konto- und Kursdaten', 'solange Ihr Konto besteht; bei Löschung des Kontos entfernt'],
    [['guest'], 'Gast-Zugang', 'nach 30 Tagen ohne Nutzung stillgelegt; auf Wunsch jederzeit gelöscht'],
    [['student', 'guest'], 'Ihre Antworten in einer Vorlesung', is('guest') ? 'nach Stilllegung des Gast-Zugangs nur noch als anonyme Gruppendaten' : 'solange Ihr Konto besteht; nach dessen Löschung bleiben sie nur als anonyme Gruppendaten'],
    [['student', 'guest'], 'Notizen und Erklärungen zu Ihren Markierungen', kept(lectureTextRetentionDays)],
    [['lecturer'], 'Vorlesungsmitschriften, Auszüge aus schwierigen Momenten und gespeicherte Aufnahmen', kept(lectureTextRetentionDays)],
    [['lecturer'], 'Besprechungsaufnahmen', 'bis Sie sie löschen, oder nach der Frist der Einrichtung'],
    [['lecturer'], 'Kursmaterial und Notizen, die Sie hochladen', 'bis Sie sie oder den Kurs löschen'],
    [['student', 'lecturer', 'admin'], 'Gespräche mit dem Assistenten', 'bis Sie sie löschen, spätestens mit Ihrem Konto'],
    [['student', 'lecturer', 'admin'], 'Benachrichtigungen', '60 Tage nach dem Lesen, höchstens 180 Tage'],
    [['admin'], 'Protokoll der Administration und Sicherheitsprotokoll', '180 Tage'],
    [['admin'], 'Geräteereignisse', '30 Tage'],
    [['admin'], 'Gast-Konten der Einrichtung', 'nach 30 Tagen ohne Nutzung stillgelegt'],
    [['student', 'guest', 'lecturer', 'admin'], 'Anmeldesitzungen', 'bis sie ablaufen (30 Tage ohne Nutzung) oder Sie sie beenden'],
    [['student', 'guest', 'lecturer', 'admin'], 'Ihre Zustimmungen (Version und Datum)', 'solange Ihr Konto besteht'],
  ].filter(([roles]) => roles.includes(role)).map(([, a, b]) => [a, b]);

  const retention = `### 1. Fristen

${table(['Daten', 'Aufbewahrung'], rows)}

### 2. Löschung und Anonymisierung

Nach Ablauf einer Frist werden die Daten automatisch gelöscht; die Löschung läuft stündlich im Hintergrund. Löschen Sie Ihr Konto${is('guest') ? ' (oder lassen Sie es löschen)' : ''}, werden Ihre persönlichen Daten entfernt. Was Gruppen betrifft (zum Beispiel wie viele eine Vorlesung als schwierig empfanden), bleibt nur ohne Bezug zu Ihnen erhalten. Beiträge, die Sie geteilt haben, bleiben mit der Angabe „Gelöschte Person“.

### 3. Frühere Löschung

Sie können Daten jederzeit früher löschen oder löschen lassen: Einstellungen → Deine Daten, oder per Nachricht an ${contact}. Sicherungskopien des Datenbankanbieters können Daten noch für die Dauer von dessen Sicherungszyklus enthalten.${is('admin', 'lecturer') ? ' Die Fristen für Vorlesungsinhalte stellt die Administration der Einrichtung ein (Admin → Hochschule → Datenaufbewahrung).' : ''}`;

  return {
    roleLabel: ROLE[role].label,
    summary,
    sections: [
      { id: 'terms', title: 'Nutzungsbedingungen', markdown: terms },
      { id: 'privacy', title: 'Datenschutzerklärung', markdown: privacy },
      { id: 'cookies', title: 'Cookie-Richtlinie', markdown: cookies },
      { id: 'retention', title: 'Aufbewahrung und Löschung', markdown: retention },
    ],
  };
}

module.exports = { build };
