import fs from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

const BASE = '/starter';

/**
 * One process for the page and the API. The browser keeps calling /starter/api,
 * which reaches the same app as /api, so no service name is resolved at runtime.
 */
export function withWeb(api: Hono, distDir: string): Hono {
  const root = path.resolve(distDir);
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    throw new Error(`WEB_DIST has no index.html: ${root}`);
  }
  const app = new Hono();

  app.all(`${BASE}/api/*`, (c) => {
    const url = new URL(c.req.url);
    url.pathname = url.pathname.slice(BASE.length);
    return api.fetch(new Request(url, c.req.raw));
  });
  app.all('/api/*', (c) => api.fetch(c.req.raw));

  app.get('/', (c) => c.redirect(`${BASE}/`, 302));
  app.get(BASE, (c) => c.redirect(`${BASE}/`, 302));
  app.get(
    `${BASE}/*`,
    serveStatic({ root, rewriteRequestPath: (requestPath) => requestPath.slice(BASE.length) || '/' }),
  );
  app.get(`${BASE}/*`, (c) => {
    if (path.extname(c.req.path)) return c.notFound();
    return c.html(fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
  });

  return app;
}
