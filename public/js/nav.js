/**
 * Navigation per role. `tabs` are the five mobile tab-bar slots ('more' opens
 * the full menu). `hidden` pages are not in the menu but can be opened by search,
 * voice and All tools. Change navigation here — nothing else needs editing.
 */
const item = (href, label, icon, extra = {}) => ({ href, label, icon, ...extra });

const COMMON_FOOT = [item('/tools', 'All tools', 'layers'), item('/settings', 'Settings', 'settings')];

export const NAV = {
  // The menu shows the classroom loop: lectures with live feedback, check-in with the student ID, progress, meetings.
  // Everything else is in All tools (and still reachable by search and by voice: `hidden` items).
  student: {
    primary: [
      item('/home', 'Home', 'home'),
      item('/lectures', 'Lectures', 'presentation'),
      item('/participation', 'Check-in', 'nfc'),
      item('/learning', 'My progress', 'trending'),
      item('/assistant', 'Ask Citrus', 'campus'),
    ],
    secondary: [
      item('/courses', 'Courses', 'book'), item('/meetings', 'Meetings', 'message'), item('/schedule', 'Schedule', 'calendar'),
      item('/quiz', 'Quizzes', 'target'), item('/sign', 'Study sign', 'moon'), item('/inbox', 'Inbox', 'inbox', { badge: 'unread' }),
    ],
    hidden: [
      item('/spaces', 'Spaces', 'grid'), item('/groups', 'Study groups', 'users'), item('/campus', 'Campus life', 'compass'),
      item('/campus/map', 'Campus map', 'map-pin'), item('/career', 'Career explorer', 'briefcase'), item('/apps', 'My tools', 'layers'),
    ],
    foot: COMMON_FOOT,
    tabs: ['/home', '/lectures', '/participation', '/learning', 'more'],
  },
  lecturer: {
    primary: [
      item('/home', 'Home', 'home'),
      item('/lectures', 'Lectures', 'presentation'),
      item('/participation', 'Participation', 'nfc'),
      item('/courses', 'Teaching', 'book'),
      item('/meetings', 'Meetings', 'message'),
    ],
    secondary: [
      item('/assistant', 'Ask Citrus', 'campus'), item('/library', 'Documents', 'library'), item('/classroom', 'Rooms & devices', 'door'),
      item('/schedule', 'Schedule', 'calendar'), item('/sign', 'Study sign', 'moon'), item('/inbox', 'Inbox', 'inbox', { badge: 'unread' }),
    ],
    hidden: [
      item('/quiz', 'Quizzes', 'target'), item('/spaces', 'Spaces', 'grid'), item('/campus', 'Campus life', 'compass'),
      item('/campus/map', 'Campus map', 'map-pin'), item('/apps', 'My tools', 'layers'),
    ],
    foot: COMMON_FOOT,
    tabs: ['/home', '/lectures', '/participation', '/courses', 'more'],
  },
  admin: {
    primary: [
      item('/home', 'Home', 'home'),
      item('/assistant', 'Ask Citrus', 'campus'),
      item('/admin/people', 'People', 'users'),
      item('/courses', 'Courses', 'book'),
      item('/admin/moderation', 'Moderation', 'flag'),
      item('/admin/ai', 'AI & knowledge', 'cpu'),
      item('/library', 'Documents', 'library'),
      item('/admin/devices', 'Devices', 'radio'),
      item('/admin/institution', 'Institution', 'shield'),
      item('/inbox', 'Inbox', 'inbox', { badge: 'unread' }),
    ],
    secondary: [item('/meetings', 'Meetings', 'message'), item('/participation', 'Participation', 'nfc'), item('/classroom', 'Rooms & devices', 'door'), item('/schedule', 'Schedule', 'calendar'), item('/sign', 'Study sign', 'moon'), item('/spaces', 'Spaces', 'grid')],
    hidden: [item('/quiz', 'Quizzes', 'target'), item('/campus/map', 'Campus map', 'map-pin'), item('/campus', 'Campus life', 'compass'), item('/apps', 'My tools', 'layers')],
    foot: COMMON_FOOT,
    tabs: ['/home', '/admin/people', '/assistant', '/admin/moderation', 'more'],
  },
};

export const navFor = (role) => NAV[role] || NAV.student;
/** Every page a role can open by name (search, voice): the menu plus the pages that live in All tools. */
export const allItems = (role) => {
  const n = navFor(role);
  return [...n.primary, ...n.secondary, ...n.foot, ...(n.hidden || [])];
};

/** Is `href` the active section for `path`? */
export function isActive(href, path) {
  if (href === '/home') return path === '/home' || path === '/';
  return path === href || path.startsWith(`${href}/`);
}
