'use strict';
/**
 * Die deutsche Fassung der Datendienst- und Datenschutzvereinbarung. Sie ist die maßgebliche Fassung; die englische
 * (agreement.js) dient dem Verständnis. Beide haben dieselbe Gliederung und dieselbe Versionsnummer: Wer zustimmt,
 * stimmt der Vereinbarung zu, nicht einer Sprache.
 *
 * Die Anrede ist "Sie" (Rechtstext); die Benutzeroberfläche selbst spricht mit "du".
 */

/** Wie lange Vorlesungsinhalte gespeichert werden, wie die Einrichtung es eingestellt hat (0 = bis jemand sie löscht). */
const kept = (n) => (Number(n) > 0 ? `${Number(n)} Tage nach ihrer Entstehung (Einstellung der Einrichtung)` : 'bis sie gelöscht werden (Einstellung der Einrichtung)');

function germanFor({ role, parts, institution, legal, lectureTextRetentionDays, HOSTING, VERSION, UPDATED }) {
  const controller = legal.controller || institution;
  const dpo = legal.dpo || 'die oder der Datenschutzbeauftragte Ihrer Einrichtung, deren oder dessen Kontaktdaten Ihre Einrichtung veröffentlicht';
  const contact = legal.contact || 'die oder der Datenschutzbeauftragte';
  const authority = legal.authority || 'die für Ihre Einrichtung zuständige Datenschutzaufsichtsbehörde';
  const hosting = {
    app: 'Vercel, Dublin (Irland)',
    database: 'Turso, auf Amazon Web Services in der Region eu-west-1 (Irland)',
    files: 'Vercel Blob, Dublin (Irland)',
  };
  void HOSTING;

  const common = `## Teil A: für alle

### 1. Worum es in dieser Vereinbarung geht

Diese Vereinbarung erklärt, wie Citrus (der „Dienst“) personenbezogene Daten verarbeitet und zu welchen Bedingungen Sie ihn nutzen dürfen. **Sie müssen ihr zustimmen, um Citrus zu nutzen**: durch das Setzen des Häkchens bei der Registrierung, beim Beitritt zu einer Vorlesung als Gast und bei der ersten Anmeldung nach einer Änderung. Wir speichern, welcher Version Sie wann zugestimmt haben. Die Teile B, C und D ergänzen, was für **Studierende und Gäste**, **Dozierende** und **Administratorinnen und Administratoren** gilt. Wenn Sie mehrere Rollen haben, gilt jeder Teil in der jeweiligen Rolle.

Citrus ist ein von Studierenden entwickelter Dienst, der für ${controller} betrieben wird. Er wird so bereitgestellt, wie er ist, ohne Zusicherung, dass er jederzeit verfügbar ist.

**Maßgeblich ist die deutsche Fassung.** Die englische Fassung dient nur dem besseren Verständnis.

### 2. Wer verantwortlich ist

| Rolle | Wer |
| --- | --- |
| Verantwortlicher | ${controller} |
| Datenschutzbeauftragte(r) | ${dpo} |
| Betreiber (Auftragsverarbeiter) | der Betreiber dieser Citrus-Installation, der sie für ${controller} betreibt und die Daten nur nach dessen Weisung verarbeiten darf |
| Fragen und Anliegen | ${contact} |
| Aufsichtsbehörde | ${authority} |

### 3. Welche Daten Citrus verarbeitet, wozu und auf welcher Grundlage

| Daten | Zweck | Rechtsgrundlage |
| --- | --- | --- |
| **Konto:** Name, Hochschul-E-Mail-Adresse, Passwort (nur als gesalzener Hash gespeichert), Rolle, letzte Anmeldung; oder Ihre Kennung der Hochschulanmeldung (Single Sign-on) | um Ihnen ein Konto bereitzustellen und es zu schützen | öffentliche Aufgabe, Art. 6 Abs. 1 lit. e DSGVO i. V. m. dem anwendbaren Landesrecht |
| **Kurse:** Ihre Einschreibungen, Ihr Stundenplan und die Einstellungen, die Sie wählen | um die Lehre durchzuführen und Ihnen Ihren eigenen Stundenplan zu zeigen | öffentliche Aufgabe |
| **Wie Sie in einer Vorlesung folgen:** „Ich folge“, „unsicher“ oder „abgehängt“, die Minute und Ihre eigenen Markierungen (eine Art und eine freiwillige Notiz von Ihnen) | damit die Lehrperson die Lehre anpassen kann und Sie die Stellen wiederholen können, die Ihnen schwerfielen | öffentliche Aufgabe |
| **Teilnahme an einer Vorlesung:** dass Sie beigetreten sind und ob Sie Ihren Namen zeigen wollten | um zu zählen, wer im Raum ist; das Zeigen Ihres Namens ist freiwillig | öffentliche Aufgabe; Zeigen des Namens: Einwilligung, Art. 6 Abs. 1 lit. a DSGVO |
| **Was die Lehrperson sagt**, aus der Spracherkennung, wenn die Lehrperson sich für das Speichern einer Mitschrift entscheidet; auf Wunsch von der Android-App gespeicherte Aufnahmen | um Notizen und Auswertungen für die Lehrperson zu erstellen und Studierende bei den Stellen zu unterstützen, die ihnen schwerfielen | öffentliche Aufgabe; die eigene Entscheidung der Lehrperson, es zu speichern |
| **Ihre Gespräche mit dem Assistenten**, die Dateien, die Sie anhängen, und was er sich zu Ihren Vorlieben merkt | um Ihnen zu antworten und Sie beim Lernen zu unterstützen | öffentliche Aufgabe; für Angehängtes: Einwilligung durch das Anhängen |
| **Sprache:** Ihr Mikrofon-Audio, nur solange Sie eine von Ihnen gestartete Sprachfunktion nutzen | Spracherkennung und gesprochene Antworten | Einwilligung, Art. 6 Abs. 1 lit. a DSGVO; Ihr Browser fragt nach der Mikrofonberechtigung |
| **Anwesenheitskontrolle** (NFC-Karte oder Code), Raum- und Geräteereignisse | Anwesenheit und Raumstatus, wo die Einrichtung dies einsetzt | öffentliche Aufgabe |
| **Sicherheit und Betrieb:** Anmeldesitzungen, ein Protokoll wichtiger Änderungen, technische Fehlerprotokolle | um den Dienst sicher und funktionsfähig zu halten | öffentliche Aufgabe |
| **Ihre Zustimmung zu dieser Vereinbarung:** die Version und das Datum | um nachzuweisen, dass Sie informiert wurden | rechtliche Verpflichtung, Art. 6 Abs. 1 lit. c DSGVO |
| **Gäste:** ein Wegwerf-Konto, das beim Beitritt zu einer Vorlesung per QR-Code entsteht, mit dem Namen, den Sie wählen (freiwillig) | damit Sie teilnehmen können, ohne sich zu registrieren | Einwilligung |

Citrus verwendet **keine** Werbe- oder Analyse-Tracker, verkauft keine Daten und schließt weder aus Ihrem Gesicht noch aus Ihrer Stimme auf Emotionen, Aufmerksamkeit oder Persönlichkeit.

### 4. Wer was sieht

- **Die Antworten der Studierenden sind für die Lehrperson anonym.** Sie werden als Summen angezeigt, es sei denn, die oder der Studierende entscheidet sich, für diese Vorlesung den Namen zu zeigen. Markierungen werden ohne Namen angezeigt.
- **Studierende sehen nur ihre eigenen Ergebnisse**, nie, wie die Gruppe abgeschnitten hat, und nie eine Zusammenfassung der Vorlesung. Nach einer Vorlesung unterstützt Citrus Studierende nur bei den Stellen, die ihnen selbst schwerfielen.
- **Eine Lehrperson sieht** die Summen der Gruppe, die anonymen Markierungen, das Vorlesungsprotokoll und, bei Studierenden, die sich dafür entschieden haben, deren Namen und Antworten.
- **Administratorinnen und Administratoren** verwalten die Einstellungen und Konten der Einrichtung. In der aktuellen Software kann eine Administratorin oder ein Administrator außerdem die Ansicht der Lehrperson für jeden Kurs der Einrichtung öffnen, einschließlich der Vorlesungsprotokolle. Private Gespräche mit dem Assistenten werden Administratoren nicht angezeigt.
- **Was eine Lehrperson sagt**, wird verschlüsselt gespeichert, mit einem eigenen Schlüssel für jede Vorlesung. Es lässt sich nur für die Lehrperson öffnen, die diese Vorlesung hält, oder als Eingabe für eine KI-Anfrage.

### 5. Künstliche Intelligenz

- Der Assistent, Vorlesungsnotizen, Erklärungen zu Markierungen, Lernnotizen und gesprochene Stimmen werden von KI-Modellen erzeugt. Sie können falsch sein. **Prüfen Sie Wichtiges nach**, bevor Sie sich darauf verlassen. Stimmen sind als KI-erzeugt gekennzeichnet.
- Citrus gibt den Modellen nur den Text, den eine Funktion braucht. Vorlesungsprotokolle und die daraus erstellten Notizen enthalten keine Namen oder Kontonummern von Studierenden. Der persönliche Assistent erhält Ihren Vornamen, Ihre Rolle und Ihre eigenen Kurs- und Stundenplanangaben, damit er Ihnen antworten kann; in den eigenen Vorlesungswerkzeugen einer Lehrperson kennt er auch deren Namen.
- KI-Ergebnisse sind **nur Hilfestellung**. Sie werden niemals verwendet, um Studierende zu benoten, zu ranken, zuzulassen, zu disziplinieren oder sonst etwas über sie zu entscheiden.
- Sie können KI-Funktionen in Ihren Einstellungen ausschalten, und die Einrichtung kann jede von ihnen für alle ausschalten.

### 6. Wer die Daten sonst noch verarbeitet, und wo

Citrus läuft in der Europäischen Union. Jeder der folgenden Dienste verarbeitet Daten nur für uns und aufgrund eines Vertrags, der ihn dazu verpflichtet.

| Dienst | Was er tut | Wo |
| --- | --- | --- |
| Vercel Inc. | betreibt die Anwendung und liefert ihre Dateien aus | ${hosting.app} |
| Turso | die Datenbank | ${hosting.database} |
| Vercel Blob | speichert hochgeladene Dateien und von der Android-App gespeicherte Aufnahmen | ${hosting.files} |
| Vercel AI Gateway und die Modellanbieter, die darüber erreicht werden (zum Beispiel OpenAI, Google, Microsoft, Perplexity und ElevenLabs, je nach Funktion) | KI-Antworten, Notizen, Websuche und Sprache | Verarbeitung durch den Anbieter; möglicherweise außerhalb des Europäischen Wirtschaftsraums |
| Deepgram oder Wispr Flow, nur wenn die Einrichtung sie einschaltet | Spracherkennung | Verarbeitung durch den Anbieter; möglicherweise außerhalb des Europäischen Wirtschaftsraums |
| Die Spracherkennung Ihres Browsers (Chrome und Edge senden Audio an Google oder Microsoft) | Spracherkennung, wenn kein anderer Dienst eingestellt ist | außerhalb des Einflusses des Dienstes |
| Das Single Sign-on der Einrichtung und Moodle, falls angebunden | Anmeldung und Kursdaten | die Einrichtung |

Wo Daten den Europäischen Wirtschaftsraum verlassen, sind sie durch einen Angemessenheitsbeschluss (für die Vereinigten Staaten das EU-US Data Privacy Framework, für zertifizierte Anbieter) oder durch die Standardvertragsklauseln der Europäischen Kommission geschützt. Ein Anbieter wird nur eingesetzt, wenn eine dieser Garantien besteht. Die Anbieter sind verpflichtet, die Daten nicht länger zu speichern, als die Anfrage es erfordert, und sie nicht zum Training ihrer Modelle zu verwenden.

### 7. Wie lange Daten gespeichert werden

| Daten | Speicherdauer |
| --- | --- |
| Konto- und Kursdaten | solange Ihr Konto besteht; bei Löschung des Kontos entfernt |
| Ihre Antworten in einer Vorlesung | solange Ihr Konto besteht; nach dessen Löschung bleiben sie nur als anonyme Gruppendaten |
| Vorlesungsmitschriften, Auszüge aus schwierigen Momenten, gespeicherte Aufnahmen sowie Notizen und Erklärungen zu Markierungen | ${kept(lectureTextRetentionDays)} |
| Besprechungsaufnahmen | bis ihre Eigentümerin oder ihr Eigentümer sie löscht, oder nach der Frist der Einrichtung |
| Gast-Konten | nach 30 Tagen ohne Nutzung stillgelegt |
| Sicherheitsprotokoll | 180 Tage |
| Benachrichtigungen | 60 Tage nach dem Lesen, höchstens 180 Tage |
| Geräteereignisse | 30 Tage |
| Anmeldesitzungen | bis sie ablaufen oder Sie sie beenden |
| Ihre Zustimmungen zu dieser Vereinbarung | solange Ihr Konto besteht |

### 8. Wie die Daten geschützt werden

Verbindungen sind verschlüsselt (TLS). Passwörter werden nur als gesalzene Hashes gespeichert. Was Dozierende sagen, wird mit einem Schlüssel pro Vorlesung verschlüsselt gespeichert. Der Zugriff wird bei jeder Anfrage auf dem Server geprüft und nach Rolle und Kurs begrenzt. Wichtige Änderungen werden in einem Sicherheitsprotokoll festgehalten. Der Dienst speichert keine Werbe- oder Analysekennungen. Die Datenbank wird von ihrem Anbieter gesichert, und der Verschlüsselungsschlüssel wird getrennt von der Datenbank aufbewahrt.

Wenn eine Verletzung des Schutzes personenbezogener Daten ein Risiko für Personen mit sich bringt, meldet der Verantwortliche dies, wo erforderlich, innerhalb von 72 Stunden der Aufsichtsbehörde und benachrichtigt die Betroffenen unverzüglich, wenn das Risiko hoch ist.

### 9. Ihre Rechte

Sie können jederzeit und kostenlos:

- **Auskunft über Ihre Daten erhalten und sie mitnehmen:** Einstellungen → Deine Daten → *Herunterladen*;
- **die Löschung verlangen:** Einstellungen → Deine Daten → *Mein Konto löschen*;
- **Unrichtiges berichtigen** (Ihr Profil in den Einstellungen; für alles andere schreiben Sie an die Stelle in Abschnitt 2);
- **der Verarbeitung widersprechen oder sie einschränken lassen**, soweit sie auf der öffentlichen Aufgabe beruht, aus Gründen, die sich aus Ihrer besonderen Situation ergeben (Art. 18 und 21 DSGVO);
- **Ihre Einwilligung widerrufen**, zum Beispiel indem Sie Ihren Namen in einer Vorlesung verbergen, keine Sprachfunktion nutzen oder Angehängtes löschen, ohne dass dies die bisherige Verarbeitung berührt;
- **sich bei der in Abschnitt 2 genannten Aufsichtsbehörde beschweren.**

Wir antworten innerhalb eines Monats. Die oben genannten Selbstbedienungsfunktionen wirken sofort, und sie bleiben auch dann verfügbar, wenn Sie der aktuellen Version dieser Vereinbarung noch nicht zugestimmt haben.

### 10. Cookies und ähnliche Speicherung

Citrus speichert ein Anmelde-Cookie und einige Einstellungen (Sprache, Darstellung, Stimmauswahl) auf Ihrem Gerät. Diese sind für den von Ihnen gewünschten Dienst unbedingt erforderlich, daher ist kein Einwilligungsbanner nötig. Citrus setzt keine Tracking- oder Werbe-Cookies.

### 11. Zulässige Nutzung

Sie werden nicht auf Daten oder Konten anderer Personen zugreifen; nicht versuchen, anonyme Personen zu identifizieren; den Dienst nicht ausspähen oder stören; keine rechtswidrigen Inhalte, Schadsoftware oder personenbezogenen Daten anderer ohne Berechtigung hochladen; und den Dienst nicht nutzen, um zu belästigen, bei Prüfungen zu täuschen oder Personen ohne die gesetzlich erforderliche Information aufzuzeichnen.

### 12. Verantwortung und anwendbares Recht

Der Dienst wird ohne Gewähr für Verfügbarkeit oder Eignung für einen bestimmten Zweck bereitgestellt. Die Haftung ist, soweit gesetzlich zulässig, auf Vorsatz und grobe Fahrlässigkeit sowie auf die Verletzung von Pflichten beschränkt, die für die Nutzung des Dienstes wesentlich sind; eine gesetzlich nicht beschränkbare Haftung bleibt unberührt. Es gilt deutsches Recht, vorbehaltlich zwingender Vorschriften zu Ihrem Schutz; Gerichtsstand ist der Sitz des Verantwortlichen.

### 13. Änderungen dieser Vereinbarung

Dies ist Version ${VERSION}, aktualisiert am ${UPDATED}. Ändern sich der Dienst oder das Recht in einer für Sie bedeutsamen Weise, ändert sich die Version, und Sie werden bei der nächsten Nutzung von Citrus gebeten, sie erneut zu lesen und ihr zuzustimmen. Bis dahin können Sie sie lesen, Ihre Daten herunterladen oder Ihr Konto löschen, den übrigen Dienst aber nicht nutzen. Kleine Korrekturen, die keine Rechte ändern, ändern die Version nicht. Die aktuelle Vereinbarung und das Datum Ihrer Zustimmung finden Sie unter Einstellungen → Deine Daten.
`;

  const student = `## Teil B: Studierende und Gäste

1. **Ihre Antworten gehören Ihnen.** „Ich folge“, „unsicher“ oder „abgehängt“ und Ihre Markierungen sind nur deshalb mit Ihrem Konto verbunden, damit Sie Ihre eigenen Ergebnisse sehen können. Die Lehrperson sieht Summen und anonyme Markierungen. Sie entscheiden Vorlesung für Vorlesung, ob Sie Ihren Namen zeigen, und können das später ändern.
2. **Sie sehen nur Ihre eigenen Ergebnisse.** Citrus zeigt Ihnen nicht, wie die Gruppe abgeschnitten hat, und gibt Ihnen keine Zusammenfassung der Vorlesung. Es hilft Ihnen bei den Stellen, die *Ihnen* schwerfielen, anhand Ihrer eigenen Antworten und Markierungen.
3. **Markierungen werden nicht benotet.** Was Sie markieren und welche Notizen Sie schreiben, wird nie verwendet, um Sie zu benoten, zu ranken oder zu disziplinieren. Schreiben Sie über die Vorlesung, nicht über Personen. Geben Sie keine sensiblen personenbezogenen Daten (Gesundheit, Weltanschauung und Ähnliches) in eine Notiz ein.
4. **Der Assistent und KI-Notizen können falsch sein.** Sie bleiben für Ihr Lernen und für alle Arbeiten verantwortlich, die Sie abgeben.
5. **Sprache.** Sprachfunktionen verwenden Ihr Mikrofon nur, nachdem Sie es erlaubt haben, und nur, solange Sie sie nutzen. Wenn Sie das Mikrofon ausschalten, enden sie.
6. **Gäste.** Ein Gast-Konto ist vorübergehend und enthält nur, was Sie in dieser Vorlesung tun. Es wird nach 30 Tagen ohne Nutzung stillgelegt, und ein Gast kann jederzeit seine Löschung verlangen.
7. **Austritt.** Sie können Ihre Daten jederzeit herunterladen und Ihr Konto löschen (Teil A, Abschnitt 9). Ihre Antworten bleiben dann nur als anonyme Gruppendaten.
`;

  const lecturer = `## Teil C: Dozierende

1. **Ihre Rolle.** Sie nutzen Citrus in Ihrer Lehre im Auftrag von ${controller}. ${controller} bleibt für die Daten verantwortlich; Sie sind dafür verantwortlich, sie richtig zu verwenden.
2. **Informieren Sie Ihre Studierenden.** Sagen Sie zu Beginn des Kurses, dass Citrus eingesetzt wird, was es erhebt (Teil A, Abschnitt 3) und dass ihre Antworten Ihnen gegenüber anonym sind, wenn sie sich nicht anders entscheiden.
3. **Anonymität.** Versuchen Sie nicht, Studierende aus anonymen Summen oder Markierungen zu identifizieren, zum Beispiel indem Sie eine Vorlesung mit so wenigen Antworten halten, dass eine Person heraussticht. Wenn eine oder ein Studierender sich entschieden hat, den Namen zu zeigen, nutzen Sie das Mitgeteilte nur, um zu helfen, etwa mit einem Wort nach der Vorlesung, nie um zu benoten oder zu sanktionieren.
4. **Keine Nutzung für Prüfungen.** Verwenden Sie das Feedback, die Notizen oder KI-Ergebnisse von Citrus nicht, um Studierende zu benoten, zu ranken, zuzulassen oder zu disziplinieren oder um eine Prüfung zu überwachen. So bleibt Citrus außerhalb der Hochrisiko-Anwendungen nach Anhang III der EU-KI-Verordnung.
5. **Ihre eigene Stimme und Aufnahmen.** Das Mithören in einer Vorlesung erfasst Ihre Sprache und kann sprechende Studierende erfassen. Eine Mitschrift wird nur gespeichert, wenn Sie das wählen. Audio wird nur gespeichert, wenn Sie die Aufnahme der Android-App nutzen und den Raum informieren. Nehmen Sie nichts auf und speichern Sie kein Audio ohne die vom Recht verlangte Information und, wo erforderlich, Einwilligung. Sie können jederzeit ein Kapitel, das Audio oder das ganze Protokoll löschen. Mitschriften und gespeichertes Audio werden nach der Frist der Einrichtung entfernt (Teil A, Abschnitt 7).
6. **Was Sie hochladen.** Notizen und Dateien, die Sie hinzufügen, werden Ihren Studierenden so angezeigt, wie Ihre Einrichtung es erlaubt. Laden Sie nichts hoch, wozu Sie kein Recht zum Teilen haben, und keine personenbezogenen Daten anderer.
7. **KI-Ergebnisse.** Prüfen Sie Vorlesungsnotizen, Auswertungen und Erklärungen, bevor Sie sie weitergeben oder sich darauf verlassen. Sie sind Vorschläge.
8. **Ihre eigenen Daten.** Ihre Nutzung von Citrus wird wie in Teil A, Abschnitt 8 beschrieben protokolliert. Wo das Recht es verlangt, wird der Einsatz von Werkzeugen im Unterricht durch Beschäftigte mit der Personalvertretung abgestimmt. Für Ihre eigenen Daten haben Sie die Rechte aus Teil A, Abschnitt 9.
9. **Vorfälle.** Informieren Sie ${contact} unverzüglich, wenn Sie eine Verletzung vermuten, zum Beispiel eine an die falsche Person gesendete Vorlesungsdatei.
`;

  const admin = `## Teil D: Administratorinnen und Administratoren

1. **Ihre Rolle.** Sie verwalten die Konten und Einstellungen der Einrichtung im Auftrag des Verantwortlichen, ${controller}. Nutzen Sie Ihre Befugnisse nur zu diesem Zweck und nur so weit, wie Ihre Aufgabe es erfordert.
2. **Zugriff.** Vergeben Sie Rollen und Kurszuordnungen nach dem Grundsatz der geringsten Berechtigung. Bestätigen Sie Dozierende erst, nachdem Sie ihre Identität geprüft haben. Entfernen Sie Konten und Zugriffe zügig, wenn jemand ausscheidet.
3. **Einstellungen in Ihrer Verantwortung.** Sie legen die Aufbewahrungsfristen der Einrichtung, die Anmelderegeln (Hochschulanmeldung, offene Registrierung), die eingeschalteten KI-Funktionen und die in dieser Vereinbarung angezeigten rechtlichen Angaben fest (Admin → Hochschule). Halten Sie die Aufbewahrung so kurz, wie der Zweck es erlaubt (Teil A, Abschnitt 7), und dokumentieren Sie jede Änderung mit ihrem Grund.
4. **Vertraulichkeit.** Sie können Konto- und technische Daten erreichen. Sehen Sie sich Daten einer Person nicht ohne aufgabenbezogenen Grund an, kopieren Sie sie nicht anderswohin und wahren Sie die Vertraulichkeit auch nach Ihrer Zeit als Administratorin oder Administrator. Ihre Handlungen im Dienst werden protokolliert.
5. **Anfragen von Personen.** Leiten Sie jede Anfrage zu Auskunft, Löschung, Widerspruch oder Beschwerde sofort an ${contact} weiter. Die meisten können die Personen selbst unter Einstellungen → Deine Daten erledigen.
6. **Auftragsverarbeiter und Verträge.** Halten Sie die Liste der Auftragsverarbeiter, ihrer Verträge und Standorte aktuell (Teil A, Abschnitt 6) und informieren Sie die oder den Datenschutzbeauftragte(n), bevor Sie einen neuen KI-Anbieter oder Sprachdienst einschalten.
7. **Vorfälle.** Melden Sie eine vermutete Verletzung sofort an ${contact}, in jedem Fall innerhalb von 24 Stunden, damit die Meldefrist von 72 Stunden an die Aufsichtsbehörde eingehalten werden kann. Helfen Sie bei der Eindämmung und Dokumentation.
8. **Sicherungen und Schlüssel.** Der Hauptschlüssel der Verschlüsselung und die Datenbanksicherungen gehören zum Schutz der Daten. Bewahren Sie sie so auf, wie die Sicherheitsanweisungen des Betreibers es vorsehen, nie im Code-Repository, und testen Sie mindestens einmal im Jahr eine Wiederherstellung.
9. **Verzeichnisse.** Helfen Sie, das Verzeichnis der Verarbeitungstätigkeiten, die Datenschutz-Folgenabschätzung und diese Vereinbarung aktuell zu halten, wenn sich der Dienst ändert. Eine bedeutsame Änderung dieser Vereinbarung bedeutet eine neue Version, der alle Nutzenden erneut zustimmen müssen.
`;

  const text = { student, lecturer, admin };
  const body = [common, ...parts.map((p) => text[p])].filter(Boolean).join('\n');
  return {
    title: 'Datendienst- und Datenschutzvereinbarung',
    markdown: `# Datendienst- und Datenschutzvereinbarung\n\nVersion ${VERSION} · ${controller}\n\n${body}`,
  };
}

module.exports = { germanFor };
