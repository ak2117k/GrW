// Cloudflare Worker for the GrW frontend.
//
// It does two jobs:
//   1. Proxy /api/*, /auth/*, and /socket.io/* to the API host
//      (vars.API_ORIGIN), server-side. The browser only ever talks to this Worker's origin, so
//      these are SAME-ORIGIN calls — no CORS preflight, and the React client
//      keeps its relative axios baseURL ('/api', '/auth/refresh') and relative
//      socket.io connection (io('/ws', { path: '/socket.io' })) with zero code
//      changes. The socket.io proxy also carries the WebSocket upgrade: passing
//      the original request through fetch() preserves the Upgrade header, which
//      Cloudflare tunnels transparently (and polling transport works either way).
//   2. Everything else is served from the static SPA (apps/web/dist) via the
//      ASSETS binding. Because wrangler.jsonc sets
//      run_worker_first: ["/api/*", "/auth/*"], non-API paths are served
//      directly by the asset store and this Worker isn't even invoked for them;
//      the env.ASSETS.fetch fallback below only matters if that scoping changes.
//
// The API origin comes from wrangler.jsonc `vars.API_ORIGIN` (the Oracle host's
// tunnel hostname). The Render URL remains only as a fallback so a missing var
// fails over to the old host instead of to nothing.
const FALLBACK_API_ORIGIN = 'https://grw-api.onrender.com';

export function apiOrigin(env) {
  return env.API_ORIGIN || FALLBACK_API_ORIGIN;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/auth/') ||
      url.pathname.startsWith('/socket.io/')
    ) {
      // Forward method, headers, and body unchanged to the API host. Passing the
      // original request as init preserves everything; the runtime sets the
      // Host header from the target URL.
      return fetch(apiOrigin(env) + url.pathname + url.search, request);
    }

    return env.ASSETS.fetch(request);
  },
};
