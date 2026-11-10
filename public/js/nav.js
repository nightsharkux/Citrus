/**
 * Navigation per role. `tabs` are the five mobile tab-bar slots ('more' opens
 * the full menu). Change navigation here — nothing else needs editing.
 */
const item = (href, label, icon, extra = {}) => ({ href, label, icon, ...extra });

const COMMON_FOOT = [item('/tools', 'All tools', 'layers'), item('/settings', 'Settings', 'settings')];

export const NAV = {
  // Student and lecturer: only the classroom loop is in the main list. Everything else sits under "More".
  student: {
    primary: [
      item('/home', 'Home', 'home'),
      item('/lectures', 'Lectures', 'presentation'),
      item('/courses', 'Courses', 'book'),
      item('/learning', 'Review', 'graduation'),
      item('/participation', 'Check-in', 'clipboard'),
    ],
    secondary: [
      item('/assistant', 'Ask Campus', 'campus'), item('/schedule', 'Schedule', 'calendar'), item('/quiz', 'Quizzes', 'target'),
      item('/spaces', 'Spaces', 'grid'), item('/groups', 'Study groups', 'users'), item('/campus', 'Campus life', 'compass'),
      item('/campus/map', 'Campus map', 'map-pin'), item('/career', 'Career explorer', 'briefcase'), item('/inbox', 'Inbox', 'inbox', { badge: 'unread' }),
    ],
    foot: COMMON_FOOT,
    tabs: ['/home', '/lectures', '/courses', '/learning', 'more'],
  },
  lecturer: {
    primary: [
      item('/home', 'Home', 'home'),
      item('/lectures', 'Lectures', 'presentation'),
      item('/courses', 'Teaching', 'book'),
      item('/classroom', 'Classroom', 'door'),
      item('/participation', 'Participation', 'clipboard'),
    ],
    secondary: [
      item('/assistant', 'Ask Campus', 'campus'), item('/schedule', 'Schedule', 'calendar'), item('/quiz', 'Quizzes', 'target'),
      item('/spaces', 'Spaces', 'grid'), item('/campus', 'Campus life', 'compass'), item('/campus/map', 'Campus map', 'map-pin'),
      item('/inbox', 'Inbox', 'inbox', { badge: 'unread' }),
    ],
    foot: COMMON_FOOT,
    tabs: ['/home', '/lectures', '/courses', '/classroom', 'more'],
  },
  admin: {
    primary: [
      item('/home', 'Home', 'home'),
      item('/assistant', 'Ask Campus', 'campus'),
      item('/admin/people', 'People', 'users'),
      item('/courses', 'Courses', 'book'),
      item('/admin/moderation', 'Moderation', 'flag'),
      item('/admin/ai', 'AI & knowledge', 'cpu'),
      item('/admin/devices', 'Devices', 'radio'),
      item('/admin/institution', 'Institution', 'shield'),
      item('/inbox', 'Inbox', 'inbox', { badge: 'unread' }),
    ],
    secondary: [item('/quiz', 'Quizzes', 'target'), item('/campus/map', 'Campus map', 'map-pin'), item('/campus', 'Campus life', 'compass'), item('/schedule', 'Schedule', 'calendar'), item('/spaces', 'Spaces', 'grid'), item('/classroom', 'Classroom', 'door'), item('/participation', 'Participation', 'clipboard')],
    foot: COMMON_FOOT,
    tabs: ['/home', '/admin/people', '/assistant', '/admin/moderation', 'more'],
  },
};

export const navFor = (role) => NAV[role] || NAV.student;
export const allItems = (role) => {
  const n = navFor(role);
  return [...n.primary, ...n.secondary, ...n.foot];
};

/** Is `href` the active section for `path`? */
export function isActive(href, path) {
  if (href === '/home') return path === '/home' || path === '/';
  return path === href || path.startsWith(`${href}/`);
}
