import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { findRepoRoot, deploymentMode, loadEnvFiles } from './config.js';
import { withWeb } from './web.js';

const root = findRepoRoot();
loadEnvFiles(root);
deploymentMode();
const hostname = process.env.HOST?.trim() || '127.0.0.1';
const port = Number(process.env.PORT) || 8787;
const webDist = process.env.WEB_DIST?.trim();
const api = createApp({ root });
const app = webDist ? withWeb(api, webDist) : api;

serve(
  {
    fetch: app.fetch,
    port,
    hostname,
  },
  (info) => {
    console.log(`vectoree-starter ${webDist ? 'web + BFF' : 'BFF'} listening on http://${hostname}:${info.port}`);
  },
);
