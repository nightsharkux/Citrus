'use strict';
/**
 * OTH Amberg-Weiden edition (independent concept — not an official OTH service).
 * Everything here is public information with an official source link.
 * Edit this file to change branding, campus guide content or quick links.
 */
module.exports = {
  id: 'oth',
  name: 'Campus OS · OTH Amberg-Weiden',
  shortName: 'Campus OS',
  institution: 'OTH Amberg-Weiden — Independent Concept',
  assistant: 'Campus',
  tagline: 'Amberg · Weiden',
  logo: '/assets/oth-aw-logo.jpg',
  conceptNotice: 'Independent concept for OTH Amberg-Weiden. Not an official university service.',
  timezone: 'Europe/Berlin',
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
  academicSnapshot: 'resources/CampusOS_OTH_AW_Academic_Data_2026-11-08.txt',
  knowledgePack: [
    'resources/OTH_Public_Knowledge_2026-10-31.jsonl',
    'resources/OTH_Website_Knowledge.jsonl',
  ],
};
