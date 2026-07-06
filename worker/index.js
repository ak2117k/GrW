// Cloudflare Worker for the GrW frontend.
//
// It does two jobs:
//   1. Proxy /api/* and /auth/* to the Render backend, server-side. The browser
//      only ever talks to this Worker's origin, so these are SAME-ORIGIN calls
//      — no CORS preflight, and the React client keeps its relative axios
//      baseURL ('/api', '/auth/refresh') with zero code changes.
//   2. Everything else is served from the static SPA (apps/web/dist) via the
//      ASSETS binding. Because wrangler.jsonc sets
//      run_worker_first: ["/api/*", "/auth/*"], non-API paths are served
//      directly by the asset store and this Worker isn't even invoked for them;
//      the env.ASSETS.fetch fallback below only matters if that scoping changes.
//
// The Render origin is fixed (the API's public URL). If it ever changes, update
// it here and redeploy.
const API_ORIGIN = 'https://grw-api.onrender.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
      // Forward method, headers, and body unchanged to Render. Passing the
      // original request as init preserves everything; the runtime sets the
      // Host header from the target URL.
      return fetch(API_ORIGIN + url.pathname + url.search, request);
    }

    return env.ASSETS.fetch(request);
  },
};
