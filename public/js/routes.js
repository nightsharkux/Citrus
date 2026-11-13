/** URL → page module. Pages load on demand. */
import { route } from './core/router.js';

export function registerRoutes() {
  route('/', () => import('./pages/landing.js'));
  route('/login', () => import('./pages/login.js'));
  route('/register', () => import('./pages/register.js'));

  route('/home', () => import('./pages/home.js'));
  route('/assistant/:id?', () => import('./pages/assistant.js'));
  route('/courses', () => import('./pages/courses.js'));
  route('/courses/:id', () => import('./pages/course.js'));
  route('/learning/packs/:id', () => import('./pages/pack.js'));
  route('/learning/:tab?', () => import('./pages/learning.js'));
  route('/lectures', () => import('./pages/lectures.js'));
  route('/lectures/review/:id', () => import('./pages/review.js'));
  route('/live/:id', () => import('./pages/live.js'));
  route('/join/:code?', () => import('./pages/join.js'));
  route('/quiz/:id?', () => import('./pages/quiz.js'));
  route('/groups', () => import('./pages/groups.js'));
  route('/schedule', () => import('./pages/schedule.js'));
  route('/spaces', () => import('./pages/spaces.js'));
  route('/spaces/:id/:tab?', () => import('./pages/space.js'));
  route('/campus/:tab?', () => import('./pages/campus.js'));
  route('/inbox/:tab?', () => import('./pages/inbox.js'));
  route('/participation', () => import('./pages/participation.js'));
  route('/participation/:id', () => import('./pages/session.js'));
  route('/career', () => import('./pages/career.js'));
  route('/classroom', () => import('./pages/classroom.js'));
  route('/library', () => import('./pages/library.js'));
  route('/meetings', () => import('./pages/meetings.js'));
  route('/apps', () => import('./pages/apps.js'));
  route('/apps/gallery', () => import('./pages/apps-gallery.js'));
  route('/apps/:id', () => import('./pages/app.js'));
  route('/settings/:section?', () => import('./pages/settings.js'));
  route('/tools', () => import('./pages/tools.js'));

  route('/admin/people', () => import('./pages/admin/people.js'));
  route('/admin/ai', () => import('./pages/admin/ai.js'));
  route('/admin/moderation', () => import('./pages/admin/moderation.js'));
  route('/admin/devices', () => import('./pages/admin/devices.js'));
  route('/admin/institution', () => import('./pages/admin/institution.js'));

  route('/404', () => import('./pages/not-found.js'));
}
