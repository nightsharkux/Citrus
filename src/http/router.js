'use strict';
/**
 * Minimal router. Routes look like `/api/courses/:id` and map to async
 * handlers that receive a context object and return a JSON-serialisable value.
 *
 *   router.get('/api/courses/:id', async (ctx) => ({ course }), { roles: ['admin'] })
 *
 * Options:
 *   auth   'user' (default) | 'public' | 'device'
 *   roles  restrict to these user roles
 *   maxBody  JSON body limit in bytes
 */
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, options = {}) {
    const keys = [];
    const source = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\/:(\w+)/g, (_, key) => {
        keys.push(key);
        return '/([^/]+)';
      });
    this.routes.push({ method, pattern, regex: new RegExp(`^${source}$`), keys, handler, options });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  /** Returns { route, params } for a match, { allowed } when only the method differs, or null. */
  match(method, path) {
    const allowed = [];
    for (const route of this.routes) {
      const m = route.regex.exec(path);
      if (!m) continue;
      if (route.method !== method) {
        allowed.push(route.method);
        continue;
      }
      const params = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(m[i + 1]);
      });
      return { route, params };
    }
    return allowed.length ? { allowed } : null;
  }
}

module.exports = { Router };
