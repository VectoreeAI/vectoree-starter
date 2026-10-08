import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { findRepoRoot, deploymentMode, loadEnvFiles } from './config.js';

const root = findRepoRoot();
loadEnvFiles(root);
deploymentMode();
const hostname = process.env.HOST?.trim() || '127.0.0.1';
const port = Number(process.env.PORT) || 8787;

serve(
  {
    fetch: createApp({ root }).fetch,
    port,
    hostname,
  },
  (info) => {
    console.log(`vectoree-starter BFF listening on http://${hostname}:${info.port}`);
  },
);
