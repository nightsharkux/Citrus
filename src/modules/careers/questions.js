'use strict';
/**
 * Career interest activity content (RIASEC-inspired, illustrative only).
 * Each question: [prompt, four options, the interest letter each option signals].
 */
const questions = [
  ['You have a free afternoon at a community workshop. Which table would you visit first?',
    ['Repair a gadget', 'Explore an unfamiliar idea', 'Create a poster', 'Organize the sign-up desk'], ['R', 'I', 'A', 'C']],
  ['A friend is planning a neighborhood event. You would rather...',
    ['Make a useful physical setup', 'Research what has worked elsewhere', 'Welcome and connect visitors', 'Promote the event and find supporters'], ['R', 'I', 'S', 'E']],
  ['A small library has a spare room. Which project sounds most satisfying?',
    ['Set up a recording studio', 'Build a searchable inventory', 'Run workshops for newcomers', 'Coordinate a community fundraiser'], ['A', 'C', 'S', 'E']],
  ['A new board game has complicated rules. You are most inclined to...',
    ['Try a round and learn by doing', 'Examine how its strategy works', 'Invent a more interesting variation', 'Explain the basics to everyone'], ['R', 'I', 'A', 'S']],
  ['You are helping a friend launch a tiny shop. You would choose to...',
    ['Design its visual identity', 'Talk to potential customers', 'Organize the product records', 'Pitch the idea to potential partners'], ['A', 'S', 'C', 'E']],
  ['A local park needs improvements. Which contribution appeals most?',
    ['Build a bench or path', 'Study the area and its needs', 'Create new signs and murals', 'Coordinate volunteers and supplies'], ['R', 'I', 'A', 'E']],
  ['You find a collection of old photos. Your first instinct is to...',
    ['Restore the damaged prints', 'Investigate their history', 'Make a creative exhibition', 'Index the collection carefully'], ['R', 'I', 'A', 'C']],
  ['Your group has one hour to prepare a presentation. You would prefer to...',
    ['Research the key evidence', 'Help teammates understand the topic', 'Present the case persuasively', 'Keep the slides and schedule organized'], ['I', 'S', 'E', 'C']],
  ['A charity invites you to help for a day. You would be most interested in...',
    ['Building or setting up equipment', 'Teaching visitors a new skill', 'Planning a publicity campaign', 'Managing donation records'], ['R', 'S', 'E', 'C']],
  ['At an exhibition, which area would you spend the most time exploring?',
    ['Machines you can operate', 'Experiments you can investigate', 'Creative installations', 'Displays about community programs'], ['R', 'I', 'A', 'S']],
  ['You could take one short course this weekend. Which attracts you?',
    ['Crafting something practical', 'Investigating a scientific question', 'Starting a small venture', 'Building an organized data system'], ['R', 'I', 'E', 'C']],
  ['A club is publishing a monthly newsletter. You would rather...',
    ['Illustrate its stories', 'Interview people about their experiences', 'Find sponsors and grow readership', 'Edit and coordinate its publication'], ['A', 'S', 'E', 'C']],
  ['Your team has access to an unused space. Which task would you pick?',
    ['Plan its physical layout', 'Explore potential uses with research', 'Design an original atmosphere', 'Invite and engage community members'], ['R', 'I', 'A', 'S']],
  ['A student project needs someone to take the lead on one activity. Which one?',
    ['Prototype the idea', 'Test the assumptions', 'Present it to stakeholders', 'Track deadlines and deliverables'], ['R', 'I', 'E', 'C']],
  ['You could spend a day with a professional. Which sounds most interesting?',
    ['A product designer', 'A counselor or mentor', 'An entrepreneur', 'A laboratory researcher'], ['A', 'S', 'E', 'I']],
  ['When joining a new group, you tend to enjoy...',
    ['Making something useful together', 'Finding answers to a challenging question', 'Getting to know everyone', 'Creating a plan for shared work'], ['R', 'I', 'S', 'C']],
  ['A startup asks for ideas for a new app. Which role would you try?',
    ['Create the interface visuals', 'Interview people about their needs', 'Explain the idea to funders', 'Organize its specifications'], ['A', 'S', 'E', 'C']],
  ['You can choose a small personal project. Which is closest to your interests?',
    ['Build a useful object', 'Solve an intriguing mystery', 'Make an original piece of art', 'Launch a neighborhood initiative'], ['R', 'I', 'A', 'E']],
];

const groups = {
  R: 'Practical & hands-on',
  I: 'Investigative & analytical',
  A: 'Creative & expressive',
  S: 'Social & supportive',
  E: 'Enterprising & persuasive',
  C: 'Organizational & detail-focused',
};

const paths = [
  { title: 'Software and systems development', tags: ['I', 'R', 'C'], detail: 'Programming, testing, systems design and technical projects.' },
  { title: 'Product and experience design', tags: ['A', 'I', 'S'], detail: 'User research, interface design, prototyping and accessibility.' },
  { title: 'Engineering and applied technology', tags: ['R', 'I', 'C'], detail: 'Engineering disciplines, technical operations and practical problem-solving.' },
  { title: 'Research and data analysis', tags: ['I', 'C', 'A'], detail: 'Research methods, data interpretation and analytical work.' },
  { title: 'Teaching and student support', tags: ['S', 'I', 'A'], detail: 'Education, mentoring and student-facing roles.' },
  { title: 'Entrepreneurship and business development', tags: ['E', 'A', 'S'], detail: 'Building services, business strategy and partnerships.' },
  { title: 'Project and operations management', tags: ['C', 'E', 'S'], detail: 'Coordination, planning and process improvement.' },
  { title: 'Media and communication', tags: ['A', 'E', 'S'], detail: 'Communication, content creation and community engagement.' },
];

const METHOD = 'Illustrative RIASEC-inspired interest exploration — not a validated psychological or career-prediction test. Results describe your preferences in this activity, not aptitude, personality or future success.';

/** Score answers (array of option indexes). Pure function. */
function assess(answers) {
  const scores = Object.fromEntries(Object.keys(groups).map((k) => [k, 0]));
  answers.forEach((choice, i) => {
    scores[questions[i][2][choice]] += 1;
  });
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return {
    scores,
    top: ranked.slice(0, 3).map(([key, count]) => ({ key, label: groups[key], count })),
    recommendations: paths
      .map((p) => ({ ...p, score: p.tags.reduce((sum, k, i) => sum + scores[k] * (3 - i), 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map(({ title, detail, tags }) => ({ title, detail, basedOn: tags.map((x) => groups[x]) })),
    answered: answers.length,
    method: METHOD,
  };
}

module.exports = { questions, groups, paths, assess, METHOD };
