/**
 * Navigation per role. `tabs` are the five mobile tab-bar slots ('more' opens
 * the full menu). Change navigation here — nothing else needs editing.
 */
const item = (href, label, icon, extra = {}) => ({ href, label, icon, ...extra });

const COMMON_FOOT = [item('/tools', 'All tools', 'layers'), item('/settings', 'Settings', 'settings')];

export const NAV = {
  student: {
    primary: [
      item('/home', 'Home', 'home'),
      item('/assistant', 'Ask Campus', 'campus'),
      item('/learning', 'Learning', 'graduation'),
      item('/courses', 'Courses', 'book'),
      item('/schedule', 'Schedule', 'calendar'),
      item('/spaces', 'Spaces', 'grid'),
      item('/campus', 'Campus life', 'compass'),
      item('/inbox', 'Inbox', 'inbox', { badge: 'unread' }),
    ],
    secondary: [item('/campus/map', 'Campus map', 'map-pin'), item('/participation', 'Check-in', 'clipboard'), item('/career', 'Career explorer', 'briefcase')],
    foot: COMMON_FOOT,
    tabs: ['/home', '/learning', '/assistant', '/campus', 'more'],
  },
  lecturer: {
    primary: [
      item('/home', 'Home', 'home'),
      item('/assistant', 'Ask Campus', 'campus'),
      item('/courses', 'Teaching', 'book'),
      item('/schedule', 'Schedule', 'calendar'),
      item('/classroom', 'Classroom', 'door'),
      item('/participation', 'Participation', 'clipboard'),
      item('/spaces', 'Spaces', 'grid'),
      item('/campus', 'Campus life', 'compass'),
      item('/inbox', 'Inbox', 'inbox', { badge: 'unread' }),
    ],
    secondary: [item('/campus/map', 'Campus map', 'map-pin')],
    foot: COMMON_FOOT,
    tabs: ['/home', '/courses', '/assistant', '/classroom', 'more'],
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
    secondary: [item('/campus/map', 'Campus map', 'map-pin'), item('/campus', 'Campus life', 'compass'), item('/schedule', 'Schedule', 'calendar'), item('/spaces', 'Spaces', 'grid'), item('/classroom', 'Classroom', 'door'), item('/participation', 'Participation', 'clipboard')],
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
