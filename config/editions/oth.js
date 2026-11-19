'use strict';
/**
 * OTH Amberg-Weiden edition (independent concept — not an official OTH service).
 * Everything here is public information with an official source link.
 * Edit this file to change branding, campus guide content or quick links.
 */
module.exports = {
  id: 'oth',
  name: 'Citrus · Student project',
  shortName: 'Citrus',
  institution: 'OTH Amberg-Weiden — Independent Concept',
  assistant: 'Citrus',
  tagline: 'Student project',
  conceptNotice: 'A student project. Not an official service of OTH Amberg-Weiden.',
  timezone: 'Europe/Berlin',
  // The six teaching periods printed on every timetable of the DTM programme (Stundenplan_DTM_WS2627.pdf: "8:15 1 / 9:45 /
  // 2 10:00 / 11:30 / 3 11:45 / 13:15 / 4 14:00 / 15:30 / 15:45 5 / 17:15 / 17:30 6 / 19:00"). A lecturer scheduling a lecture
  // picks from these instead of typing times (public/js/features/lecture-slots.js); tests/lecture-slots.test.js checks
  // them against the timetable data.
  teachingPeriods: [
    { n: 1, from: '08:15', to: '09:45' },
    { n: 2, from: '10:00', to: '11:30' },
    { n: 3, from: '11:45', to: '13:15' },
    { n: 4, from: '14:00', to: '15:30' },
    { n: 5, from: '15:45', to: '17:15' },
    { n: 6, from: '17:30', to: '19:00' },
  ],
  // The three sessions of a teaching day, each a whole number of periods run together. The afternoon is period 4 only:
  // 13:15 is the end of period 3, and the next class starts at 14:00.
  teachingSessions: [
    { id: 'morning', name: 'Morning', from: '08:15', to: '11:30', periods: [1, 2] },
    { id: 'afternoon', name: 'Afternoon', from: '14:00', to: '15:30', periods: [4] },
    { id: 'evening', name: 'Evening', from: '15:45', to: '19:00', periods: [5, 6] },
  ],
  palette: {
    accent: '#F07A2E',
    accentStrong: '#E0631A',
    aurora: ['#FF9A4D', '#F2557A', '#8B6CFF'],
  },
  campuses: [
    {
      id: 'amberg',
      name: 'Amberg',
      address: 'Kaiser-Wilhelm-Ring 23, 92224 Amberg',
      areas: ['EMI faculty', 'MB/UT faculty', 'Library', 'Mensa', 'Administration', 'Audimax / Siemens Innovatorium', 'Sports hall'],
      mapUrl: 'https://www.oth-aw.de/files/oth-aw/Standorte/Lageplan_OTH-AW_Amberg.pdf',
      infoUrl: 'https://www.oth-aw.de/en/university/about-our-university/campus-locations/campus-amberg/',
    },
    {
      id: 'weiden',
      name: 'Weiden',
      address: 'Hetzenrichter Weg 15, 92637 Weiden',
      areas: ['Weiden Business School', 'WIG faculty area', 'Lecture hall building', 'Mensa / Coffee Lounge', 'Weidener Technologie-Campus', 'Digital Business Campus'],
      mapUrl: 'https://www.oth-aw.de/files/oth-aw/Standorte/Lageplan_OTH-AW_Weiden.pdf',
      infoUrl: 'https://www.oth-aw.de/en/university/about-our-university/campus-locations/campus-weiden/',
    },
  ],
  links: [
    { label: 'MyOTH', description: 'University service portal', url: 'https://www.oth-aw.de/en/myoth/', icon: 'compass' },
    { label: 'Moodle', description: 'Course spaces and materials', url: 'https://www.oth-aw.de/en/studies/getting-started/', icon: 'book' },
    { label: 'PRIMUSS', description: 'Exams, grades, certificates', url: 'https://www.oth-aw.de/en/myoth/', icon: 'doc' },
    { label: 'Semester dates', description: 'Lecture and exam periods', url: 'https://www.oth-aw.de/en/studies/getting-started/university-formalties/lecture-examination-and-lecture-free-periods/', icon: 'calendar' },
    { label: 'Library', description: 'Opening hours and OPAC', url: 'https://www.oth-aw.de/en/university/about-our-university/facilities/library/', icon: 'library' },
    { label: 'Online services', description: 'Roomfinder, Wi-Fi, VPN, mail', url: 'https://www.oth-aw.de/en/university/services/online-services/', icon: 'grid' },
    { label: 'International Office', description: 'Exchange and visa support', url: 'https://www.oth-aw.de/en/international/international-profile/international-office/', icon: 'globe' },
    { label: 'Marketplace', description: 'Housing and learning partners', url: 'https://www.oth-aw.de/en/studies/campus-life/marketplace/about-the-marketplace/', icon: 'bag' },
  ],
  campusMap: 'resources/oth-campus-map.json',
  academicSnapshot: 'resources/Citrus_OTH_AW_Academic_Data_2026-11-08.txt',
  knowledgePack: [
    'resources/OTH_Public_Knowledge_2026-10-31.jsonl',
    'resources/OTH_Website_Knowledge.jsonl',
  ],
};
