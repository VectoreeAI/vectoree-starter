import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { clearAuthCooldowns, createApp } from './app.js';
import { normalizeSchema, parseCreateTable } from './database.js';
import { loadEnvFiles, normalizeApiUrl, publicSetupStatus, writeLinkedConfig, writeProjectConfig, deploymentMode } from './config.js';
import { createImageToolResponse, normalizeGeneratedImages } from './image-tool.js';
import { clearPreviews, PREVIEW_COOKIE, PREVIEW_IDLE_MS, seedPreview } from './preview.js';
import { clearSessions, seedSession, SESSION_COOKIE } from './session.js';

const secret = 'sk-ve-v1-test-secret-do-not-leak';
const dirs: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-starter-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  clearAuthCooldowns();
  clearSessions();
  clearPreviews();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('setup status', () => {
  it('never returns the project API key', async () => {
    const root = tempRoot();
    writeProjectConfig(root, {
      apiUrl: 'https://vectoree.ai',
      projectId: 'proj_123',
      apiKey: secret,
    });
    const app = createApp({ root, env: {} });
    const res = await app.request('/api/setup/status');
    const body = (await res.json()) as { linked: boolean; projectId?: string; apiUrl?: string };
    assert.equal(res.status, 200);
    assert.deepEqual(body, {
      linked: true,
      mode: 'local',
      projectId: 'proj_123',
      apiUrl: 'https://vectoree.ai',
    });
    assert.equal(JSON.stringify(body).includes(secret), false);
    assert.equal(JSON.stringify(body).includes('sk-ve'), false);
  });

  it('hides an env key the same way', async () => {
    const app = createApp({
      root: tempRoot(),
      env: {
        VECTOREE_API_URL: 'https://vectoree.ai',
        VECTOREE_PROJECT_ID: 'from-env',
        VECTOREE_API_KEY: secret,
      },
    });
    const res = await app.request('/api/setup/status');
    const text = await res.text();
    assert.equal(text.includes(secret), false);
    assert.deepEqual(JSON.parse(text), {
      linked: true,
      mode: 'local',
      projectId: 'from-env',
      apiUrl: 'https://vectoree.ai',
    });
  });

  it('rejects a publishable key and a URL with a path', async () => {
    const app = createApp({ root: tempRoot(), env: {} });
    const res = await app.request('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiUrl: 'https://vectoree.ai',
        projectId: 'proj_123',
        apiKey: 'pk_public',
      }),
    });
    assert.equal(res.status, 400);
    assert.throws(() => normalizeApiUrl('https://vectoree.ai/api/v1'));
    assert.equal(normalizeApiUrl('https://vectoree.ai/'), 'https://vectoree.ai');
  });

  it('reports unlinked when nothing is configured', () => {
    assert.deepEqual(publicSetupStatus({ apiUrl: 'https://vectoree.ai', linked: false }), { linked: false });
  });

  it('starts unlinked when .env is a directory', async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, '.env'));
    const env: NodeJS.ProcessEnv = {};
    loadEnvFiles(root, env);
    const app = createApp({ root, env });
    const body = (await (await app.request('/api/setup/status')).json()) as { linked: boolean; mode?: string };
    assert.deepEqual(body, { linked: false, mode: 'local' });
  });

  it('treats a CLI config file as linked without POST /api/setup', async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, '.vectoree'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.vectoree', 'config.json'),
      JSON.stringify({
        apiUrl: 'https://vectoree.ai',
        projectId: 'proj_cli',
        projectName: 'Demo',
        apiKey: secret,
        keyId: 'key_1',
        accessToken: 'cli-user-jwt',
        refreshToken: 'cli-refresh',
      }),
    );
    const app = createApp({ root, env: {} });
    const res = await app.request('/api/setup/status');
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), {
      linked: true,
      mode: 'local',
      projectId: 'proj_cli',
      projectName: 'Demo',
      apiUrl: 'https://vectoree.ai',
    });
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes('cli-user-jwt'), false);
    assert.equal(text.includes('cli-refresh'), false);
  });

  it('reads snake_case aliases from a config file', async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, '.vectoree'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.vectoree', 'config.json'),
      JSON.stringify({
        api_url: 'https://vectoree.ai',
        project_id: 'proj_snake',
        api_key: secret,
      }),
    );
    const app = createApp({ root, env: {} });
    const body = (await (await app.request('/api/setup/status')).json()) as {
      linked: boolean;
      projectId?: string;
    };
    assert.equal(body.linked, true);
    assert.equal(body.projectId, 'proj_snake');
    assert.equal(JSON.stringify(body).includes(secret), false);
  });

  it('forgets a prior link once the credential files are gone', async () => {
    const root = tempRoot();
    const env: NodeJS.ProcessEnv = {};
    writeLinkedConfig(
      root,
      { apiUrl: 'https://vectoree.ai', projectId: 'proj_prior', apiKey: secret },
      env,
    );
    assert.equal(env.VECTOREE_PROJECT_ID, 'proj_prior');
    assert.equal(env.VECTOREE_API_KEY, secret);
    fs.rmSync(path.join(root, '.vectoree'), { recursive: true, force: true });
    fs.rmSync(path.join(root, '.env'), { force: true });
    const app = createApp({ root, env });
    const body = (await (await app.request('/api/setup/status')).json()) as { linked: boolean; mode?: string };
    assert.deepEqual(body, { linked: false, mode: 'local' });
    assert.equal(env.VECTOREE_PROJECT_ID, undefined);
    assert.equal(env.VECTOREE_API_KEY, undefined);
    assert.equal(JSON.stringify(body).includes(secret), false);
  });

  it('unlinks after a boot snapshot, a later link, and deleted credential files', async () => {
    const root = tempRoot();
    const env: NodeJS.ProcessEnv = {};
    loadEnvFiles(root, env);
    writeLinkedConfig(
      root,
      { apiUrl: 'https://vectoree.ai', projectId: 'proj_prior', apiKey: secret },
      env,
    );
    fs.rmSync(path.join(root, '.vectoree'), { recursive: true, force: true });
    fs.rmSync(path.join(root, '.env'), { force: true });
    const app = createApp({ root, env });
    const status = (await (await app.request('/api/setup/status')).json()) as { linked: boolean };
    assert.deepEqual(status, { linked: false, mode: 'local' });
    assert.equal(env.VECTOREE_PROJECT_ID, undefined);
    assert.equal(env.VECTOREE_API_KEY, undefined);
    const chat = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(chat.status, 400);
    const models = await app.request('/api/models');
    assert.equal(models.status, 400);
  });

  it('stays unlinked when the file has a key but no project id', async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, '.vectoree'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.vectoree', 'config.json'),
      JSON.stringify({ apiUrl: 'https://vectoree.ai', apiKey: secret }),
    );
    const app = createApp({ root, env: {} });
    const body = (await (await app.request('/api/setup/status')).json()) as { linked: boolean };
    assert.equal(body.linked, false);
    assert.equal(JSON.stringify(body).includes(secret), false);
  });

  it('reports cloud mode without treating a missing link as the link page', async () => {
    const app = createApp({ root: tempRoot(), env: { DEPLOY_MODE: 'cloud' } });
    const body = (await (await app.request('/api/setup/status')).json()) as { linked: boolean; mode: string };
    assert.deepEqual(body, { linked: false, mode: 'cloud', previewed: false });
    assert.equal(deploymentMode({}), 'local');
    assert.equal(deploymentMode({ DEPLOY_MODE: '' }), 'local');
    assert.equal(deploymentMode({ DEPLOY_MODE: 'local' }), 'local');
    assert.equal(deploymentMode({ DEPLOY_MODE: 'cloud' }), 'cloud');
    assert.throws(() => deploymentMode({ DEPLOY_MODE: 'Cloud' }));
  });
});

describe('gates', () => {
  it('refuses chat before link and before sign-in', async () => {
    const unlinked = createApp({ root: tempRoot(), env: {} });
    const blocked = await unlinked.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(blocked.status, 400);

    const root = tempRoot();
    writeProjectConfig(root, {
      apiUrl: 'https://vectoree.ai',
      projectId: 'proj_123',
      apiKey: secret,
    });
    const linked = createApp({ root, env: {} });
    const signedOut = await linked.request('/api/models');
    assert.equal(signedOut.status, 401);
    const text = await signedOut.text();
    assert.equal(text.includes(secret), false);
  });
});

describe('console connect', () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  const otherId = '22222222-2222-4222-8222-222222222222';
  const access = 'console-access-token';
  const refresh = 'console-refresh-token';

  function consoleFetch(root: string, calls: string[] = []): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/api/system/auth/cli/token')) {
        return Response.json({
          accessToken: access,
          refreshToken: refresh,
          user: { id: 'user-1', email: 'dev@example.com' },
        });
      }
      if (url.endsWith('/api/projects')) {
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${access}`);
        return Response.json([
          { id: projectId, name: 'Demo', organizationId: 'org-a' },
          { id: otherId, name: 'Demo', organization: { id: 'org-b', name: 'Team B' } },
        ]);
      }
      if (url.endsWith('/api/organizations')) {
        return Response.json([
          { id: 'org-a', name: 'Team A' },
          { id: 'org-b', name: 'Team B' },
        ]);
      }
      if (url.includes('/api/gateway/keys')) {
        const headers = new Headers(init?.headers);
        const body = JSON.parse(String(init?.body)) as {
          name?: string;
          projectId?: string;
          deviceId?: string;
          localFolderPath?: string;
          scopes?: string[];
        };
        assert.equal(headers.get('authorization'), `Bearer ${access}`);
        assert.equal(headers.get('x-project-id'), projectId);
        assert.equal(headers.get('user-agent'), 'VectoreeCLI');
        assert.equal(body.projectId, projectId);
        assert.match(body.name ?? '', /^CLI — /);
        assert.ok((body.deviceId ?? '').length >= 8);
        assert.equal(body.localFolderPath, root);
        assert.deepEqual(body.scopes, [
          'gateway:chat',
          'gateway:models',
          'tools:*',
          'database:*',
          'storage:*',
          'auth:*',
        ]);
        return Response.json({ id: 'key-uuid', apiKey: secret, name: body.name }, { status: 201 });
      }
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
  }

  async function startLogin(app: ReturnType<typeof createApp>, redirectOrigin?: string) {
    const started = await app.request('/api/setup/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openBrowser: false, ...(redirectOrigin ? { redirectOrigin } : {}) }),
    });
    const pending = (await started.json()) as { status: string; authorizeUrl?: string };
    assert.equal(started.status, 200);
    assert.equal(pending.status, 'pending');
    const authorize = new URL(pending.authorizeUrl ?? '');
    return { pending, authorize, state: authorize.searchParams.get('state') ?? '' };
  }

  it('logs in first, lists projects, then links the chosen one', async () => {
    const root = tempRoot();
    const app = createApp({ root, env: {}, fetchImpl: consoleFetch(root), connectTimeoutMs: 2000 });

    const { pending, authorize, state } = await startLogin(app, 'http://127.0.0.1:5173/starter/');
    assert.equal(authorize.origin + authorize.pathname, 'https://vectoree.ai/api/system/auth/cli/authorize');
    assert.ok((authorize.searchParams.get('code_challenge') ?? '').length >= 43);
    assert.equal(authorize.searchParams.get('redirect_uri'), 'http://127.0.0.1:5173/starter/api/setup/callback');
    assert.ok(state);
    assert.equal(JSON.stringify(pending).includes(access), false);

    const callback = await app.request(`/api/setup/callback?code=auth-code&state=${state}`);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), 'http://127.0.0.1:5173/starter/');
    const returned = (await (await app.request('/api/setup/connect')).json()) as { status: string };
    assert.equal(returned.status, 'callback');

    const token = await app.request('/api/setup/token', { method: 'POST' });
    const tokenText = await token.text();
    assert.equal(token.status, 200);
    assert.equal(JSON.parse(tokenText).status, 'authorized');
    assert.equal(tokenText.includes(access), false);
    assert.equal(tokenText.includes(refresh), false);

    const listed = await app.request('/api/setup/projects');
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), {
      projects: [
        { id: projectId, name: 'Demo', organizationId: 'org-a', organizationName: 'Team A' },
        { id: otherId, name: 'Demo', organizationId: 'org-b', organizationName: 'Team B' },
      ],
    });
    assert.equal(fs.existsSync(path.join(root, '.vectoree', 'config.json')), false);

    const linked = await app.request('/api/setup/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    const linkedText = await linked.text();
    assert.equal(linked.status, 200, linkedText);
    assert.deepEqual(JSON.parse(linkedText), {
      status: 'linked',
      apiUrl: 'https://vectoree.ai',
      projectId,
      projectName: 'Demo',
    });
    assert.equal(linkedText.includes(secret), false);
    assert.equal(linkedText.includes(access), false);

    const config = JSON.parse(fs.readFileSync(path.join(root, '.vectoree', 'config.json'), 'utf8')) as Record<
      string,
      string
    >;
    assert.equal(config.apiUrl, 'https://vectoree.ai');
    assert.equal(config.accessToken, access);
    assert.equal(config.refreshToken, refresh);
    assert.equal(config.apiKey, secret);
    assert.equal(config.projectId, projectId);
    assert.equal(config.projectName, 'Demo');
    assert.equal(config.keyId, 'key-uuid');

    const envFile = fs.readFileSync(path.join(root, '.env'), 'utf8');
    assert.match(envFile, /VECTOREE_API_URL=https:\/\/vectoree\.ai/);
    assert.match(envFile, new RegExp(`VECTOREE_PROJECT_ID=${projectId}`));
    assert.match(envFile, new RegExp(`VECTOREE_API_KEY=${secret}`));
    assert.equal(envFile.includes(access), false);
    assert.equal(envFile.includes(refresh), false);

    const statusText = await (await app.request('/api/setup/status')).text();
    assert.equal(JSON.parse(statusText).linked, true);
    assert.equal(statusText.includes(secret), false);
    assert.equal(statusText.includes(access), false);
    assert.equal(statusText.includes(refresh), false);

    const again = await app.request('/api/setup/projects');
    assert.equal(again.status, 401);
  });

  it('still lists projects when organizations cannot be loaded', async () => {
    const root = tempRoot();
    const base = consoleFetch(root);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/api/organizations')
        ? new Response('nope', { status: 500 })
        : base(input, init)) as typeof fetch;
    const app = createApp({ root, env: {}, fetchImpl });
    const { state } = await startLogin(app);
    await app.request(`/api/setup/callback?code=auth-code&state=${state}`);
    await app.request('/api/setup/token', { method: 'POST' });
    const listed = await app.request('/api/setup/projects');
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), {
      projects: [
        { id: projectId, name: 'Demo', organizationId: 'org-a' },
        { id: otherId, name: 'Demo', organizationId: 'org-b', organizationName: 'Team B' },
      ],
    });
  });

  it('exchanges the code only once when the page asks twice', async () => {
    const root = tempRoot();
    const calls: string[] = [];
    const app = createApp({ root, env: {}, fetchImpl: consoleFetch(root, calls) });
    const { state } = await startLogin(app);
    await app.request(`/api/setup/callback?code=auth-code&state=${state}`);
    const [first, second] = await Promise.all([
      app.request('/api/setup/token', { method: 'POST' }),
      app.request('/api/setup/token', { method: 'POST' }),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls.filter((url) => url.includes('/cli/token')).length, 1);
  });

  it('refuses projects and link before Console login', async () => {
    const app = createApp({ root: tempRoot(), env: {} });
    assert.equal((await app.request('/api/setup/projects')).status, 401);
    const link = await app.request('/api/setup/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    assert.equal(link.status, 401);
    assert.equal((await app.request('/api/setup/token', { method: 'POST' })).status, 409);
  });

  it('rejects a callback with the wrong state', async () => {
    const root = tempRoot();
    const app = createApp({ root, env: {}, fetchImpl: consoleFetch(root) });
    await startLogin(app);
    const res = await app.request('/api/setup/callback?code=auth-code&state=nope');
    assert.equal(res.status, 400);
  });

  it('returns to the app with an error when login is denied', async () => {
    const root = tempRoot();
    const app = createApp({ root, env: {}, fetchImpl: consoleFetch(root) });
    const { state } = await startLogin(app);
    const res = await app.request(`/api/setup/callback?error=access_denied&state=${state}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'http://127.0.0.1:5173/');
    const snap = (await (await app.request('/api/setup/connect')).json()) as { status: string; message?: string };
    assert.equal(snap.status, 'error');
    assert.match(snap.message ?? '', /access_denied/);
  });

  it('rejects a non-uuid or unknown project id', async () => {
    const root = tempRoot();
    const app = createApp({ root, env: {}, fetchImpl: consoleFetch(root) });
    const { state } = await startLogin(app);
    await app.request(`/api/setup/callback?code=auth-code&state=${state}`);
    await app.request('/api/setup/token', { method: 'POST' });
    const bad = await app.request('/api/setup/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'not-a-uuid' }),
    });
    assert.equal(bad.status, 400);
    const unknown = await app.request('/api/setup/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: '33333333-3333-4333-8333-333333333333' }),
    });
    assert.equal(unknown.status, 400);
    assert.equal(fs.existsSync(path.join(root, '.vectoree', 'config.json')), false);
  });

  it('defaults the callback to the loopback app origin', async () => {
    let opened = '';
    const app = createApp({
      root: tempRoot(),
      env: {},
      openUrl: async (url) => {
        opened = url;
      },
    });
    const res = await app.request('/api/setup/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    assert.equal(new URL(opened).searchParams.get('redirect_uri'), 'http://127.0.0.1:5173/api/setup/callback');
  });
});

describe('settings', () => {
  it('returns the project key only after sign-in', async () => {
    const root = tempRoot();
    writeProjectConfig(root, {
      apiUrl: 'https://vectoree.ai',
      projectId: 'proj_123',
      apiKey: secret,
    });
    const app = createApp({ root, env: {} });
    const unsigned = await app.request('/api/settings');
    assert.equal(unsigned.status, 401);
    const statusText = await (await app.request('/api/setup/status')).text();
    assert.equal(statusText.includes(secret), false);
    const token = seedSession({ user: { id: 'user_1', email: 'a@example.com' }, accessToken: 'app-jwt' });
    const res = await app.request('/api/settings', { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
    const body = (await res.json()) as { apiUrl: string; apiKey: string };
    assert.equal(res.status, 200);
    assert.equal(body.apiUrl, 'https://vectoree.ai');
    assert.equal(body.apiKey, secret);
  });
});

describe('conversations', () => {
  function linkedApp(fetchImpl?: typeof fetch) {
    const root = tempRoot();
    writeProjectConfig(root, {
      apiUrl: 'https://vectoree.ai',
      projectId: 'proj_123',
      apiKey: secret,
    });
    const app = createApp({ root, env: {}, ...(fetchImpl ? { fetchImpl } : {}) });
    const sid = seedSession({ user: { id: 'u1', email: 'a@example.com' }, accessToken: 'app-jwt' });
    return { app, sid, root };
  }

  function cookie(sid: string): Record<string, string> {
    return { Cookie: `${SESSION_COOKIE}=${sid}`, 'Content-Type': 'application/json' };
  }

  it('requires a link and a session', async () => {
    const root = tempRoot();
    const open = createApp({ root, env: {} });
    assert.equal((await open.request('/api/conversations')).status, 400);
    writeProjectConfig(root, {
      apiUrl: 'https://vectoree.ai',
      projectId: 'proj_123',
      apiKey: secret,
    });
    const linked = createApp({ root, env: {} });
    const unsigned = await linked.request('/api/conversations');
    assert.equal(unsigned.status, 401);
    assert.equal((await unsigned.text()).includes(secret), false);
  });

  it('creates, lists, updates, and deletes a conversation', async () => {
    const { app, sid } = linkedApp();
    const headers = cookie(sid);
    const created = (await (await app.request('/api/conversations', { method: 'POST', headers, body: '{}' })).json()) as {
      id: string;
      title: string;
    };
    assert.equal(created.title, 'New chat');
    const again = (await (await app.request('/api/conversations', { method: 'POST', headers, body: '{}' })).json()) as {
      id: string;
    };
    assert.equal(again.id, created.id);
    const forced = (await (
      await app.request('/api/conversations', { method: 'POST', headers, body: JSON.stringify({ force: true }) })
    ).json()) as { id: string };
    assert.notEqual(forced.id, created.id);
    const put = await app.request(`/api/conversations/${created.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        messages: [
          { id: 'm1', role: 'user', content: 'hello' },
          { id: 'm2', role: 'assistant', content: 'hi there' },
        ],
      }),
    });
    assert.equal(put.status, 200);
    const loaded = (await (await app.request(`/api/conversations/${created.id}`, { headers })).json()) as {
      messages: { content: string }[];
    };
    assert.equal(loaded.messages[1]?.content, 'hi there');
    const listed = (await (await app.request('/api/conversations', { headers })).json()) as {
      conversations: { id: string }[];
    };
    assert.equal(listed.conversations[0]?.id, created.id);
    const renamed = (await (
      await app.request(`/api/conversations/${created.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ title: 'Manual name' }),
      })
    ).json()) as { title: string; titledByModel?: boolean };
    assert.equal(renamed.title, 'Manual name');
    assert.equal(renamed.titledByModel, true);
    const removed = await app.request(`/api/conversations/${forced.id}`, { method: 'DELETE', headers });
    assert.equal(removed.status, 200);
    const after = (await (await app.request('/api/conversations', { headers })).json()) as { conversations: { id: string }[] };
    assert.equal(after.conversations.some((item) => item.id === forced.id), false);
    assert.equal(JSON.stringify(after).includes(secret), false);
  });

  it('keeps a long generated data URL intact', async () => {
    const { app, sid } = linkedApp();
    const headers = cookie(sid);
    const dataUrl = `data:image/png;base64,${'A'.repeat(50_000)}`;
    const httpsUrl = 'https://cdn.example/cat.png';
    const created = (await (await app.request('/api/conversations', { method: 'POST', headers, body: '{}' })).json()) as {
      id: string;
    };
    const put = await app.request(`/api/conversations/${created.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: '',
            generated: [{ url: dataUrl }, { url: httpsUrl }],
          },
        ],
      }),
    });
    assert.equal(put.status, 200);
    const loaded = (await (await app.request(`/api/conversations/${created.id}`, { headers })).json()) as {
      messages: { generated?: { url: string }[] }[];
    };
    const urls = loaded.messages[0]?.generated ?? [];
    assert.equal(urls[0]?.url, dataUrl);
    assert.equal(urls[0]?.url.length, dataUrl.length);
    assert.notEqual(urls[0]?.url.length, 2000);
    assert.equal(urls[1]?.url, httpsUrl);
  });

  it('names a conversation from a tool-free chat completion', async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), 'https://vectoree.ai/api/v1/chat/completions');
      const body = JSON.parse(String(init?.body)) as { stream?: boolean; tools?: unknown; model?: string; messages?: { content: string }[] };
      assert.equal(body.stream, false);
      assert.equal(body.tools, undefined);
      assert.equal(body.model, 'vendor/chat');
      assert.match(body.messages?.[1]?.content ?? '', /hello from the user/);
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      assert.equal(auth, `Bearer ${secret}`);
      return Response.json({ choices: [{ message: { content: '"Red fox sketch."' } }] });
    }) as typeof fetch;
    const { app, sid } = linkedApp(fetchImpl);
    const headers = cookie(sid);
    const created = (await (await app.request('/api/conversations', { method: 'POST', headers, body: '{}' })).json()) as {
      id: string;
    };
    await app.request(`/api/conversations/${created.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', content: 'hello from the user' }] }),
    });
    const named = await app.request(`/api/conversations/${created.id}/generate-title`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'vendor/chat' }),
    });
    const body = (await named.json()) as { id: string; title: string };
    assert.equal(named.status, 200);
    assert.equal(body.title, 'Red fox sketch');
    const stored = (await (await app.request(`/api/conversations/${created.id}`, { headers })).json()) as {
      title: string;
      titledByModel?: boolean;
    };
    assert.equal(stored.title, 'Red fox sketch');
    assert.equal(stored.titledByModel, true);
    assert.equal(JSON.stringify(body).includes(secret), false);
  });
});

describe('setup validate', () => {
  it('probes /api/v1/models with the stored key and hides that key', async () => {
    const root = tempRoot();
    writeProjectConfig(root, {
      apiUrl: 'https://vectoree.ai',
      projectId: 'proj_123',
      apiKey: secret,
    });
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), 'https://vectoree.ai/api/v1/models');
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      assert.equal(auth, `Bearer ${secret}`);
      return new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const app = createApp({ root, env: {} });
      const res = await app.request('/api/setup/status?validate=1');
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(text), {
        linked: true,
        mode: 'local',
        projectId: 'proj_123',
        apiUrl: 'https://vectoree.ai',
      });
      assert.equal(text.includes(secret), false);
    } finally {
      globalThis.fetch = previous;
    }
  });
});

function sseEvents(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function toolCallEvents(): unknown[] {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'generate_image', arguments: '' },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"prompt":"red fox"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  ];
}

describe('image tool', () => {
  it('runs generate_image and streams the image event plus final text', async () => {
    const root = tempRoot();
    writeProjectConfig(root, {
      apiUrl: 'https://vectoree.ai',
      projectId: 'proj_123',
      apiKey: secret,
    });
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`);
      if (url.endsWith('/api/v1/chat/completions')) {
        const body = JSON.parse(String(init?.body)) as {
          tools?: Array<{ function?: { name?: string } }>;
          tool_choice?: string;
          messages?: Array<{ role?: string }>;
        };
        const chatCount = calls.filter((item) => item.endsWith('/api/v1/chat/completions')).length;
        assert.equal(body.tool_choice, 'auto');
        assert.equal(body.tools?.[0]?.function?.name, 'generate_image');
        assert.equal(chatCount, 1);
        assert.equal(body.messages?.[0]?.role, 'system');
        return sseEvents(toolCallEvents());
      }
      if (url.endsWith('/api/v1/images')) {
        const headers = new Headers(init?.headers);
        const body = JSON.parse(String(init?.body)) as {
          model?: string;
          prompt?: string;
          async?: boolean;
          n?: number;
          size?: string;
        };
        assert.equal(headers.get('prefer'), 'respond-async');
        assert.match(headers.get('idempotency-key') ?? '', /^[0-9a-f-]{36}$/i);
        assert.equal(body.model, 'vendor/paint');
        assert.equal(body.prompt, 'red fox');
        assert.equal(body.async, true);
        assert.equal(body.n, undefined);
        assert.equal(body.size, undefined);
        return Response.json(
          { id: 'job_fox', status: 'pending', polling_url: '/api/v1/images/jobs/job_fox' },
          { status: 202 },
        );
      }
      if (url.endsWith('/api/v1/images/jobs/job_fox')) {
        return Response.json({
          id: 'job_fox',
          status: 'completed',
          data: [{ url: 'https://cdn.example/fox.png' }],
        });
      }
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    const app = createApp({ root, env: {}, fetchImpl });
    const sid = seedSession({ user: { id: 'u1', email: 'a@example.com' }, accessToken: 'app-jwt' });
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${sid}` },
      body: JSON.stringify({
        model: 'vendor/chat',
        imageTool: true,
        imageModel: 'vendor/paint',
        messages: [{ role: 'user', content: '画一只红色的狐狸' }],
      }),
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    const statusAt = text.indexOf('event: starter.image_status');
    const imagesAt = text.indexOf('event: starter.images\n');
    assert.ok(statusAt >= 0 && imagesAt > statusAt);
    assert.match(text, /"status":"generating"/);
    assert.match(text, /"n":1/);
    assert.match(text, /event: starter\.images/);
    assert.match(text, /https:\/\/cdn\.example\/fox\.png/);
    assert.match(text, /data: \[DONE\]/);
    assert.ok(text.indexOf('event: starter.images\n') < text.indexOf('data: [DONE]'));
    assert.equal(
      calls.filter((url) => url.endsWith('/api/v1/chat/completions')).length,
      1,
    );
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes('app-jwt'), false);
    assert.equal(calls.some((url) => url.endsWith('/api/v1/images')), true);
  });

  it('sends database tools when the image tool is off', async () => {
    const root = tempRoot();
    writeProjectConfig(root, {
      apiUrl: 'https://vectoree.ai',
      projectId: 'proj_123',
      apiKey: secret,
    });
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      const body = JSON.parse(String(init?.body)) as {
        tools?: Array<{ function?: { name?: string } }>;
        tool_choice?: string;
      };
      const names = (body.tools ?? []).map((item) => item.function?.name);
      assert.equal(body.tool_choice, 'auto');
      assert.equal(names.includes('generate_image'), false);
      assert.equal(names.includes('list_tables'), true);
      assert.equal(names.includes('create_table'), true);
      assert.equal(names.includes('insert_records'), true);
      assert.equal(names.includes('list_buckets'), true);
      assert.equal(names.includes('upload_object'), true);
      return sseEvents([{ choices: [{ delta: { content: 'plain' }, finish_reason: 'stop' }] }]);
    }) as typeof fetch;
    const app = createApp({ root, env: {}, fetchImpl });
    const sid = seedSession({ user: { id: 'u1', email: 'a@example.com' }, accessToken: 'app-jwt' });
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${sid}` },
      body: JSON.stringify({
        model: 'vendor/chat',
        imageTool: false,
        imageModel: 'vendor/paint',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /plain/);
    assert.equal(text.includes('starter.images'), false);
    assert.equal(calls.some((url) => url.includes('/images')), false);
    assert.equal(text.includes(secret), false);
  });

  it('polls a 202 image job and prefers b64 data urls', async () => {
    let polls = 0;
    const response = await createImageToolResponse({
      apiUrl: 'https://vectoree.ai',
      apiKey: secret,
      model: 'vendor/chat',
      imageModel: 'vendor/paint',
      pollIntervalMs: 0,
      pollTimeoutMs: 5_000,
      messages: [{ role: 'user', content: 'draw' }],
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`);
        if (url.endsWith('/api/v1/chat/completions')) {
          const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string }> };
          assert.equal(body.messages?.some((message) => message.role === 'tool'), false);
          return sseEvents(toolCallEvents());
        }
        if (url.endsWith('/api/v1/images')) {
          const headers = new Headers(init?.headers);
          const body = JSON.parse(String(init?.body)) as { async?: boolean; size?: string };
          assert.equal(headers.get('prefer'), 'respond-async');
          assert.equal(body.async, true);
          assert.equal(body.size, undefined);
          return Response.json(
            { id: 'job_1', status: 'pending', polling_url: '/api/v1/images/jobs/job_1' },
            { status: 202 },
          );
        }
        polls += 1;
        if (polls < 2) return Response.json({ id: 'job_1', status: 'pending' });
        return Response.json({
          id: 'job_1',
          status: 'completed',
          data: [{ b64_json: 'aaaa', media_type: 'image/png' }],
        });
      }) as typeof fetch,
    });
    const text = await response.text();
    assert.match(text, /data:image\/png;base64,aaaa/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(text.includes('caption'), false);
    assert.equal(text.includes(secret), false);
    assert.equal(polls >= 2, true);
    assert.deepEqual(normalizeGeneratedImages({ data: [{ url: 'https://cdn.example/a.png' }] }), [
      { url: 'https://cdn.example/a.png' },
    ]);
  });

  it('rejects imageTool without an image model', async () => {
    const root = tempRoot();
    writeProjectConfig(root, {
      apiUrl: 'https://vectoree.ai',
      projectId: 'proj_123',
      apiKey: secret,
    });
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('unused', { status: 500 });
    }) as typeof fetch;
    const app = createApp({ root, env: {}, fetchImpl });
    const sid = seedSession({ user: { id: 'u1', email: 'a@example.com' }, accessToken: 'app-jwt' });
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${sid}` },
      body: JSON.stringify({
        model: 'amazon/nova-2-lite-v1',
        imageTool: true,
        messages: [{ role: 'user', content: 'draw a cat' }],
      }),
    });
    const body = (await res.json()) as { message?: string };
    assert.equal(res.status, 400);
    assert.equal(body.message, 'imageModel is required when imageTool is enabled');
    assert.equal(called, false);
    assert.equal(JSON.stringify(body).includes(secret), false);
  });

  it('retries an image request with a forced generate_image tool choice', async () => {
    const root = tempRoot();
    writeProjectConfig(root, {
      apiUrl: 'https://vectoree.ai',
      projectId: 'proj_123',
      apiKey: secret,
    });
    const choices: unknown[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/v1/chat/completions')) {
        const body = JSON.parse(String(init?.body)) as {
          tool_choice?: unknown;
          tools?: Array<{ function?: { name?: string } }>;
          messages?: Array<{ role?: string }>;
        };
        choices.push(body.tool_choice);
        assert.equal(body.tools?.[0]?.function?.name, 'generate_image');
        if (choices.length === 1) {
          assert.equal(body.tool_choice, 'auto');
          assert.equal(body.messages?.[0]?.role, 'system');
          return sseEvents([{ choices: [{ delta: { content: 'I cannot draw' }, finish_reason: 'stop' }] }]);
        }
        assert.equal(choices.length, 2);
        assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'generate_image' } });
        return sseEvents(toolCallEvents());
      }
      if (url.endsWith('/api/v1/images')) {
        return Response.json({ data: [{ url: 'https://cdn.example/cat.png' }] });
      }
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    const app = createApp({ root, env: {}, fetchImpl });
    const sid = seedSession({ user: { id: 'u1', email: 'a@example.com' }, accessToken: 'app-jwt' });
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${sid}` },
      body: JSON.stringify({
        model: 'amazon/nova-2-lite-v1',
        imageTool: true,
        imageModel: 'x-ai/grok-imagine-image-quality',
        messages: [{ role: 'user', content: 'draw a cat' }],
      }),
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(choices.length, 2);
    assert.match(text, /event: starter\.images/);
    assert.match(text, /https:\/\/cdn\.example\/cat\.png/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(text.includes('Here is a cat'), false);
    assert.equal(text.includes('I cannot draw'), false);
    assert.equal(text.includes(secret), false);
  });
});

describe('database', () => {
  function linkedApp(fetchImpl: typeof fetch) {
    const root = tempRoot();
    writeProjectConfig(root, {
      apiUrl: 'https://vectoree.ai',
      projectId: 'proj_123',
      apiKey: secret,
    });
    const app = createApp({ root, env: {}, fetchImpl });
    const sid = seedSession({ user: { id: 'u1', email: 'a@example.com' }, accessToken: 'app-jwt' });
    return { app, cookie: `${SESSION_COOKIE}=${sid}` };
  }

  it('rejects database calls before link and before sign-in', async () => {
    const unlinked = createApp({ root: tempRoot(), env: {} });
    const blocked = await unlinked.request('/api/database/tables');
    assert.equal(blocked.status, 400);

    const root = tempRoot();
    writeProjectConfig(root, {
      apiUrl: 'https://vectoree.ai',
      projectId: 'proj_123',
      apiKey: secret,
    });
    const linked = createApp({ root, env: {} });
    const signedOut = await linked.request('/api/database/tables');
    assert.equal(signedOut.status, 401);
  });

  it('proxies table list, records, create, patch, and delete', async () => {
    const hits: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      hits.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`);
      if (url.pathname === '/api/database/tables') return Response.json(['posts']);
      if (url.pathname === '/api/database/tables/posts/schema') {
        return Response.json({
          table_name: 'posts',
          columns: [
            { columnName: 'id', type: 'uuid', isNullable: false, isUnique: true, isPrimaryKey: true },
            { columnName: 'title', type: 'string', isNullable: false, isUnique: false },
          ],
        });
      }
      if (url.pathname === '/api/database/records/posts' && (init?.method ?? 'GET') === 'GET') {
        assert.equal(url.searchParams.get('limit'), '50');
        assert.equal(url.searchParams.get('offset'), '0');
        return new Response(JSON.stringify([{ id: 'row-1', title: 'Hello' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Total-Count': '1' },
        });
      }
      if (url.pathname === '/api/database/records/posts' && init?.method === 'POST') {
        assert.equal(new Headers(init.headers).get('prefer'), 'return=representation');
        assert.deepEqual(JSON.parse(String(init.body)), [{ title: 'Next' }]);
        return Response.json([{ id: 'row-2', title: 'Next' }], { status: 201 });
      }
      if (init?.method === 'PATCH') {
        assert.equal(url.pathname, '/api/database/records/posts');
        assert.equal(url.searchParams.get('id'), 'eq.row-1');
        assert.equal(new Headers(init.headers).get('prefer'), 'return=representation');
        assert.deepEqual(JSON.parse(String(init.body)), { title: 'Edited' });
        return Response.json([{ id: 'row-1', title: 'Edited' }]);
      }
      if (init?.method === 'DELETE') {
        assert.equal(url.searchParams.get('id'), 'eq.row-1');
        return new Response(null, { status: 204 });
      }
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    const { app, cookie } = linkedApp(fetchImpl);
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };

    const tables = await app.request('/api/database/tables', { headers });
    const tablesBody = await tables.text();
    assert.equal(tables.status, 200);
    assert.deepEqual(JSON.parse(tablesBody), { tables: ['posts'] });
    assert.equal(tablesBody.includes(secret), false);

    const schema = await app.request('/api/database/tables/posts/schema', { headers });
    const schemaBody = (await schema.json()) as { tableName: string; columns: Array<{ name: string }> };
    assert.equal(schemaBody.tableName, 'posts');
    assert.equal(schemaBody.columns[0]?.name, 'id');
    assert.equal(schemaBody.columns[1]?.name, 'title');

    const records = await app.request('/api/database/tables/posts/records?limit=50&offset=0', { headers });
    assert.deepEqual(await records.json(), { records: [{ id: 'row-1', title: 'Hello' }], total: 1 });

    const created = await app.request('/api/database/tables/posts/records', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Next' }),
    });
    assert.equal(created.status, 200);
    assert.deepEqual(await created.json(), { records: [{ id: 'row-2', title: 'Next' }] });

    const patched = await app.request('/api/database/tables/posts/records/row-1', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ title: 'Edited' }),
    });
    assert.equal(patched.status, 200);

    const removed = await app.request('/api/database/tables/posts/records/row-1', {
      method: 'DELETE',
      headers,
    });
    assert.deepEqual(await removed.json(), { ok: true });
    assert.equal(hits.some((hit) => hit.startsWith('DELETE /api/database/records/posts?id=eq.row-1')), true);
    assert.equal(JSON.stringify(hits).includes(secret), false);
  });
});

describe('database agent tools', () => {
  function toolEvents(name: string, args: string, id: string) {
    return [
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ];
  }

  it('creates a table, inserts rows, then streams the summary', async () => {
    const root = tempRoot();
    writeProjectConfig(root, {
      apiUrl: 'https://vectoree.ai',
      projectId: 'proj_123',
      apiKey: secret,
    });
    let chats = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/v1/chat/completions')) {
        chats += 1;
        const body = JSON.parse(String(init?.body)) as {
          tools?: Array<{ function?: { name?: string } }>;
          tool_choice?: string;
          messages?: Array<{ role?: string }>;
        };
        const names = (body.tools ?? []).map((item) => item.function?.name);
        assert.equal(names.includes('generate_image'), false);
        assert.equal(names.includes('create_table'), true);
        assert.equal(names.includes('insert_records'), true);
        assert.equal(body.tool_choice, 'auto');
        if (chats === 1) {
          return sseEvents(
            toolEvents(
              'create_table',
              JSON.stringify({
                tableName: 'demo',
                columns: [
                  { name: 'title', type: 'string', nullable: false },
                  { name: 'note', type: 'string', nullable: true },
                ],
              }),
              'call_create',
            ),
          );
        }
        if (chats === 2) {
          assert.equal(body.messages?.some((message) => message.role === 'tool'), true);
          return sseEvents(
            toolEvents(
              'insert_records',
              JSON.stringify({
                table: 'demo',
                records: [{ title: 'one', note: 'a' }, { title: 'two', note: 'b' }],
              }),
              'call_insert',
            ),
          );
        }
        assert.equal(chats, 3);
        return sseEvents([
          { choices: [{ delta: { content: 'Created demo and inserted 2 rows.' }, finish_reason: 'stop' }] },
        ]);
      }
      const parsed = new URL(url);
      if (parsed.pathname === '/api/database/tables' && init?.method === 'POST') {
        assert.deepEqual(JSON.parse(String(init.body)), {
          tableName: 'demo',
          rlsEnabled: true,
          columns: [
            { columnName: 'title', type: 'string', isNullable: false, isUnique: false },
            { columnName: 'note', type: 'string', isNullable: true, isUnique: false },
          ],
        });
        return Response.json({ message: 'Table created successfully', tableName: 'demo' }, { status: 201 });
      }
      if (parsed.pathname === '/api/database/records/demo' && init?.method === 'POST') {
        assert.equal(new Headers(init.headers).get('prefer'), 'return=representation');
        const rows = JSON.parse(String(init.body)) as unknown[];
        assert.equal(Array.isArray(rows), true);
        assert.equal(rows.length, 2);
        return Response.json([{ id: 'r1', title: 'one' }, { id: 'r2', title: 'two' }], { status: 201 });
      }
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    const app = createApp({ root, env: {}, fetchImpl });
    const sid = seedSession({ user: { id: 'u1', email: 'a@example.com' }, accessToken: 'app-jwt' });
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${sid}` },
      body: JSON.stringify({
        model: 'vendor/chat',
        imageTool: false,
        messages: [{ role: 'user', content: '帮我创建一个 demo 表，再插入几条数据' }],
      }),
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(chats, 3);
    assert.match(text, /event: starter\.database/);
    assert.match(text, /tables_changed/);
    assert.match(text, /records_changed/);
    assert.match(text, /Created demo and inserted 2 rows/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(text.includes(secret), false);
  });

  it('retries a database request with tool_choice required', async () => {
    const root = tempRoot();
    writeProjectConfig(root, {
      apiUrl: 'https://vectoree.ai',
      projectId: 'proj_123',
      apiKey: secret,
    });
    const choices: unknown[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (new URL(url).pathname === '/api/database/tables') return Response.json(['posts']);
      if (!url.endsWith('/api/v1/chat/completions')) return new Response('missing', { status: 404 });
      const body = JSON.parse(String(init?.body)) as { tool_choice?: unknown };
      choices.push(body.tool_choice);
      if (choices.length === 1) {
        assert.equal(body.tool_choice, 'auto');
        return sseEvents([{ choices: [{ delta: { content: 'I cannot access the database' }, finish_reason: 'stop' }] }]);
      }
      if (choices.length === 2) {
        assert.equal(body.tool_choice, 'required');
        return sseEvents(toolEvents('list_tables', '{}', 'call_list'));
      }
      assert.equal(body.tool_choice, 'auto');
      return sseEvents([{ choices: [{ delta: { content: 'There is a posts table.' }, finish_reason: 'stop' }] }]);
    }) as typeof fetch;
    const app = createApp({ root, env: {}, fetchImpl });
    const sid = seedSession({ user: { id: 'u1', email: 'a@example.com' }, accessToken: 'app-jwt' });
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${sid}` },
      body: JSON.stringify({
        model: 'vendor/chat',
        imageTool: false,
        messages: [{ role: 'user', content: '列出有哪些表' }],
      }),
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(choices[0], 'auto');
    assert.equal(choices[1], 'required');
    assert.match(text, /There is a posts table/);
    assert.equal(text.includes('I cannot access the database'), false);
    assert.match(text, /data: \[DONE\]/);
  });

  it('forces another tool call when create_table fails and the model only apologizes', async () => {
    const root = tempRoot();
    writeProjectConfig(root, {
      apiUrl: 'https://vectoree.ai',
      projectId: 'proj_123',
      apiKey: secret,
    });
    let chats = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/v1/chat/completions')) {
        chats += 1;
        const body = JSON.parse(String(init?.body)) as {
          tool_choice?: string;
          messages?: Array<{ role?: string; content?: unknown }>;
        };
        if (chats === 1) {
          assert.equal(body.tool_choice, 'auto');
          return sseEvents(
            toolEvents(
              'create_table',
              JSON.stringify({
                tableName: '演示',
                columns: [{ columnName: 'title', type: 'string', isNullable: false, isUnique: false }],
              }),
              'call_bad',
            ),
          );
        }
        if (chats === 2) {
          assert.equal(body.tool_choice, 'auto');
          assert.equal(
            body.messages?.some((message) => message.role === 'tool' && String(message.content).includes('Invalid table name')),
            true,
          );
          return sseEvents([
            {
              choices: [
                { delta: { content: '抱歉，表名似乎有问题。让我使用简单的英文表名来创建一个表：' }, finish_reason: 'stop' },
              ],
            },
          ]);
        }
        if (chats === 3) {
          assert.equal(body.tool_choice, 'required');
          assert.equal(
            body.messages?.some((message) => message.role === 'tool' && String(message.content).includes('Invalid table name')),
            true,
          );
          return sseEvents(
            toolEvents(
              'create_table',
              JSON.stringify({
                tableName: 'demo',
                columns: [{ columnName: 'title', type: 'string', isNullable: false, isUnique: false }],
              }),
              'call_ok',
            ),
          );
        }
        assert.equal(chats, 4);
        return sseEvents([{ choices: [{ delta: { content: 'Created the demo table.' }, finish_reason: 'stop' }] }]);
      }
      const parsed = new URL(url);
      if (parsed.pathname === '/api/database/tables' && init?.method === 'POST') {
        assert.equal(JSON.parse(String(init.body)).tableName, 'demo');
        return Response.json({ message: 'Table created successfully', tableName: 'demo' }, { status: 201 });
      }
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    const app = createApp({ root, env: {}, fetchImpl });
    const sid = seedSession({ user: { id: 'u1', email: 'a@example.com' }, accessToken: 'app-jwt' });
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${sid}` },
      body: JSON.stringify({
        model: 'vendor/chat',
        imageTool: false,
        messages: [{ role: 'user', content: '随便创建一个表 随便创建一些表的列 再插入3条数据看看' }],
      }),
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(chats, 4);
    assert.equal(text.includes('让我使用简单的英文表名'), false);
    assert.match(text, /Created the demo table/);
    assert.match(text, /tables_changed/);
    assert.match(text, /data: \[DONE\]/);
  });

  it('posts canonical columns and rejects a file type', () => {
    assert.deepEqual(
      parseCreateTable({
        tableName: 'demo',
        columns: [{ columnName: 'title', type: 'string', isNullable: false, isUnique: true }],
      }),
      {
        tableName: 'demo',
        rlsEnabled: true,
        columns: [{ columnName: 'title', type: 'string', isNullable: false, isUnique: true }],
      },
    );
    assert.deepEqual(
      parseCreateTable({
        tableName: 'demo',
        columns: [
          { name: 'id', type: 'uuid', nullable: false },
          { name: 'title', type: 'string', nullable: false, unique: false },
        ],
      }).columns,
      [{ columnName: 'title', type: 'string', isNullable: false, isUnique: false }],
    );
    assert.throws(() => parseCreateTable({ tableName: '演示', columns: [{ columnName: 'title', type: 'string', isNullable: true, isUnique: false }] }), /ASCII/);
    assert.throws(() => parseCreateTable({ tableName: 'demo', columns: [{ columnName: 'blob', type: 'file', isNullable: true, isUnique: false }] }), /file/);
    assert.throws(
      () => parseCreateTable({ tableName: 'demo', columns: [{ columnName: 'id', type: 'string', isNullable: false, isUnique: true }] }),
      /reserved/,
    );
    assert.equal(normalizeSchema('posts', { columns: [{ columnName: 'title', type: 'string', isNullable: false, isUnique: false }] }).columns[0]?.name, 'title');
  });
});

describe('storage', () => {
  function linked() {
    const root = tempRoot();
    writeProjectConfig(root, {
      apiUrl: 'https://vectoree.ai',
      projectId: 'proj_123',
      apiKey: secret,
    });
    const sid = seedSession({ user: { id: 'u1', email: 'a@example.com' }, accessToken: 'app-jwt' });
    return { root, cookie: `${SESSION_COOKIE}=${sid}` };
  }

  function toolEvents(name: string, args: string, id: string) {
    return [
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] },
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ];
  }

  it('rejects storage calls before link and before sign-in', async () => {
    const unlinked = createApp({ root: tempRoot(), env: {} });
    assert.equal((await unlinked.request('/api/storage/buckets')).status, 400);
    const { root } = linked();
    const signedOut = createApp({ root, env: {} });
    assert.equal((await signedOut.request('/api/storage/buckets')).status, 401);
  });

  it('proxies buckets and object upload, list, and delete', async () => {
    const hits: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      hits.push(`${init?.method ?? 'GET'} ${url}`);
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`);
      const parsed = new URL(url);
      if (parsed.pathname === '/api/storage/buckets' && (init?.method ?? 'GET') === 'GET') {
        return Response.json([{ name: 'demo', public: true, createdAt: '2026-01-01T00:00:00.000Z' }]);
      }
      if (parsed.pathname === '/api/storage/buckets' && init?.method === 'POST') {
        assert.deepEqual(JSON.parse(String(init.body)), { bucketName: 'demo', isPublic: false });
        return Response.json({ name: 'demo', public: false }, { status: 201 });
      }
      if (parsed.pathname === '/api/storage/buckets/demo' && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (parsed.pathname === '/api/storage/buckets/demo/objects' && (init?.method ?? 'GET') === 'GET') {
        assert.equal(parsed.searchParams.get('prefix'), 'notes/');
        return Response.json({
          data: [{ key: 'notes/hello.txt', size: 5, mimeType: 'text/plain', uploadedAt: '2026-01-02', url: 'https://cdn.example/hello.txt' }],
          pagination: { offset: 0, limit: 100, total: 1 },
        });
      }
      if (init?.method === 'PUT' && url.includes('/objects/notes%2Fhello.txt')) {
        assert.equal(init.body instanceof FormData, true);
        assert.ok((init.body as FormData).get('file'));
        return Response.json({ key: 'notes/hello.txt', size: 5, url: 'https://cdn.example/hello.txt' });
      }
      if (init?.method === 'DELETE' && url.includes('/objects/notes%2Fhello.txt')) {
        return new Response(null, { status: 204 });
      }
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    const { root, cookie } = linked();
    const app = createApp({ root, env: {}, fetchImpl });
    const headers = { Cookie: cookie };

    const listed = await app.request('/api/storage/buckets', { headers });
    assert.deepEqual(await listed.json(), {
      buckets: [{ name: 'demo', isPublic: true, createdAt: '2026-01-01T00:00:00.000Z' }],
    });

    const created = await app.request('/api/storage/buckets', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucketName: 'demo', isPublic: false }),
    });
    assert.equal(created.status, 200);

    const objects = await app.request('/api/storage/buckets/demo/objects?prefix=notes%2F', { headers });
    const page = (await objects.json()) as { objects: Array<{ key: string }>; pagination: { total: number } };
    assert.equal(page.objects[0]?.key, 'notes/hello.txt');
    assert.equal(page.pagination.total, 1);

    const form = new FormData();
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt');
    form.append('key', 'notes/hello.txt');
    const uploaded = await app.request('/api/storage/buckets/demo/objects', { method: 'POST', headers, body: form });
    assert.equal(uploaded.status, 200);
    assert.equal(((await uploaded.json()) as { key?: string }).key, 'notes/hello.txt');

    const removed = await app.request(`/api/storage/buckets/demo/objects?key=${encodeURIComponent('notes/hello.txt')}`, {
      method: 'DELETE',
      headers,
    });
    assert.deepEqual(await removed.json(), { ok: true });

    const dropped = await app.request('/api/storage/buckets/demo', { method: 'DELETE', headers });
    assert.deepEqual(await dropped.json(), { ok: true });
    assert.equal(JSON.stringify(hits).includes(secret), false);
  });

  it('creates a bucket, uploads hello.txt, lists it, then summarizes', async () => {
    const { root, cookie } = linked();
    let chats = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/v1/chat/completions')) {
        chats += 1;
        const body = JSON.parse(String(init?.body)) as {
          tool_choice?: string;
          tools?: Array<{ function?: { name?: string } }>;
        };
        const names = (body.tools ?? []).map((item) => item.function?.name);
        assert.equal(names.includes('list_buckets'), true);
        assert.equal(names.includes('create_table'), true);
        assert.equal(names.includes('generate_image'), false);
        if (chats === 1) {
          return sseEvents(toolEvents('create_bucket', JSON.stringify({ bucketName: 'demo' }), 'call_bucket'));
        }
        if (chats === 2) {
          return sseEvents(
            toolEvents('upload_object', JSON.stringify({ bucket: 'demo', key: 'hello.txt', textContent: 'hello' }), 'call_up'),
          );
        }
        if (chats === 3) {
          return sseEvents(toolEvents('list_objects', JSON.stringify({ bucket: 'demo' }), 'call_ls'));
        }
        return sseEvents([{ choices: [{ delta: { content: 'Uploaded hello.txt to demo.' }, finish_reason: 'stop' }] }]);
      }
      const parsed = new URL(url);
      if (parsed.pathname === '/api/storage/buckets' && init?.method === 'POST') {
        assert.equal(JSON.parse(String(init.body)).bucketName, 'demo');
        return Response.json({ name: 'demo' }, { status: 201 });
      }
      if (init?.method === 'PUT' && url.includes('/objects/hello.txt')) {
        assert.equal(init.body instanceof FormData, true);
        return Response.json({ key: 'hello.txt', size: 5, url: 'https://cdn.example/hello.txt' });
      }
      if (parsed.pathname === '/api/storage/buckets/demo/objects') {
        return Response.json({ data: [{ key: 'hello.txt', size: 5 }], pagination: { offset: 0, limit: 100, total: 1 } });
      }
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    const app = createApp({ root, env: {}, fetchImpl });
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        model: 'vendor/chat',
        imageTool: false,
        messages: [{ role: 'user', content: '创建一个 demo 桶，上传一个 hello.txt，再列出来' }],
      }),
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(chats, 4);
    assert.match(text, /buckets_changed/);
    assert.match(text, /objects_changed/);
    assert.match(text, /Uploaded hello.txt to demo/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(text.includes(secret), false);
  });

  it('forces a storage tool when the first reply is only text', async () => {
    const { root, cookie } = linked();
    const choices: unknown[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith('/api/v1/chat/completions')) return new Response('missing', { status: 404 });
      const body = JSON.parse(String(init?.body)) as { tool_choice?: unknown };
      choices.push(body.tool_choice);
      if (choices.length === 1) {
        return sseEvents([{ choices: [{ delta: { content: 'I cannot touch storage' }, finish_reason: 'stop' }] }]);
      }
      if (choices.length === 2) {
        assert.equal(body.tool_choice, 'required');
        return sseEvents(toolEvents('list_buckets', '{}', 'call_list'));
      }
      return sseEvents([{ choices: [{ delta: { content: 'There is a demo bucket.' }, finish_reason: 'stop' }] }]);
    }) as typeof fetch;
    const buckets = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (new URL(url).pathname === '/api/storage/buckets') return Response.json(['demo']);
      return fetchImpl(input, init);
    }) as typeof fetch;
    const app = createApp({ root, env: {}, fetchImpl: buckets });
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        model: 'vendor/chat',
        imageTool: false,
        messages: [{ role: 'user', content: '列出存储桶' }],
      }),
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(choices[0], 'auto');
    assert.equal(choices[1], 'required');
    assert.equal(text.includes('I cannot touch storage'), false);
    assert.match(text, /There is a demo bucket/);
  });
});

describe('cloud preview', () => {
  const keyA = 'sk-ve-v1-preview-key-user-a';
  const keyB = 'sk-ve-v1-preview-key-user-b';
  const vectoree = 'http://vectoree.test';
  const ticket = 'ticket-0123456789abcdef';

  function cloudEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return { DEPLOY_MODE: 'cloud', VECTOREE_API_URL: vectoree, ...extra };
  }

  function linkedRoot(): string {
    const root = tempRoot();
    writeProjectConfig(root, { apiUrl: 'https://vectoree.ai', projectId: 'proj_linked', apiKey: secret });
    return root;
  }

  function previewCookie(apiKey: string, projectId: string, userId: string): string {
    const pid = seedPreview({ apiUrl: vectoree, apiKey, projectId, organizationId: 'org_1' });
    const sid = seedSession({ user: { id: userId, email: `${userId}@example.com` }, accessToken: 'app-jwt', previewId: pid });
    return `${PREVIEW_COOKIE}=${pid}; ${SESSION_COOKIE}=${sid}`;
  }

  function readCookie(res: Response, name: string): string | undefined {
    const header = res.headers.get('set-cookie') ?? '';
    const match = new RegExp(`${name}=([^;]*)`).exec(header);
    return match?.[1];
  }

  it('reports the preview in status without a key, and ignores the link file', async () => {
    const root = linkedRoot();
    const app = createApp({ root, env: cloudEnv({ VECTOREE_PROJECT_ID: 'from-env', VECTOREE_API_KEY: secret }) });
    const bare = await app.request('/api/setup/status');
    assert.deepEqual(await bare.json(), { linked: false, mode: 'cloud', previewed: false });

    const pid = seedPreview({ apiUrl: vectoree, apiKey: keyA, projectId: 'proj_a' });
    const res = await app.request('/api/setup/status', { headers: { Cookie: `${PREVIEW_COOKIE}=${pid}` } });
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), {
      linked: false,
      mode: 'cloud',
      previewed: true,
      projectId: 'proj_a',
      apiUrl: vectoree,
    });
    assert.equal(text.includes('sk-ve'), false);
  });

  it('forgets a preview after the idle limit', async () => {
    const app = createApp({ root: tempRoot(), env: cloudEnv() });
    const pid = seedPreview({ apiUrl: vectoree, apiKey: keyA, projectId: 'proj_a' }, Date.now() - PREVIEW_IDLE_MS - 1);
    const body = (await (await app.request('/api/setup/status', { headers: { Cookie: `${PREVIEW_COOKIE}=${pid}` } })).json()) as {
      previewed: boolean;
    };
    assert.equal(body.previewed, false);
  });

  it('redeems a ticket once and keeps the key on the server', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ apiKey: keyA, projectId: 'proj_a', organizationId: 'org_a' });
    }) as typeof fetch;
    const root = tempRoot();
    const app = createApp({ root, env: cloudEnv(), fetchImpl });
    const res = await app.request('/api/preview/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(text), { projectId: 'proj_a', organizationId: 'org_a' });
    assert.equal(text.includes('sk-ve'), false);
    assert.deepEqual(calls, [{ url: `${vectoree}/api/system/starter/preview/redeem`, body: { ticket } }]);
    const pid = readCookie(res, PREVIEW_COOKIE);
    assert.ok(pid);
    const status = (await (await app.request('/api/setup/status', { headers: { Cookie: `${PREVIEW_COOKIE}=${pid}` } })).json()) as {
      previewed: boolean;
      projectId?: string;
    };
    assert.equal(status.previewed, true);
    assert.equal(status.projectId, 'proj_a');
    assert.equal(fs.existsSync(path.join(root, '.vectoree', 'config.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.env')), false);
  });

  it('maps a rejected ticket to preview_required and a network failure to 502', async () => {
    const rejected = createApp({
      root: tempRoot(),
      env: cloudEnv(),
      fetchImpl: (async () => Response.json({ message: 'Ticket expired' }, { status: 410 })) as typeof fetch,
    });
    const used = await rejected.request('/api/preview/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    assert.equal(used.status, 401);
    assert.equal(((await used.json()) as { code?: string }).code, 'preview_required');
    assert.equal(readCookie(used, PREVIEW_COOKIE), undefined);

    const short = await rejected.request('/api/preview/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: 'short' }),
    });
    assert.equal(short.status, 401);

    const offline = createApp({
      root: tempRoot(),
      env: cloudEnv(),
      fetchImpl: (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as typeof fetch,
    });
    const down = await offline.request('/api/preview/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    assert.equal(down.status, 502);
  });

  it('refuses redeem in local mode', async () => {
    const app = createApp({ root: tempRoot(), env: {} });
    const res = await app.request('/api/preview/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    assert.equal(res.status, 404);
  });

  it('ends the app session on redeem and drops a session from another preview', async () => {
    const fetchImpl = (async () => Response.json({ apiKey: keyB, projectId: 'proj_b' })) as typeof fetch;
    const app = createApp({ root: tempRoot(), env: cloudEnv(), fetchImpl });
    const cookieA = previewCookie(keyA, 'proj_a', 'u1');
    const before = (await (await app.request('/api/auth/session', { headers: { Cookie: cookieA } })).json()) as {
      user: unknown;
    };
    assert.ok(before.user);

    const res = await app.request('/api/preview/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ ticket }),
    });
    assert.equal(res.status, 200);
    assert.equal(readCookie(res, SESSION_COOKIE), '');

    const sid = /ve_session=([^;]*)/.exec(cookieA)?.[1];
    const pidB = seedPreview({ apiUrl: vectoree, apiKey: keyB, projectId: 'proj_b' });
    const staleSid = seedSession({ user: { id: 'u1', email: 'u1@example.com' }, accessToken: 'app-jwt', previewId: 'other' });
    for (const id of [sid, staleSid]) {
      const after = (await (
        await app.request('/api/auth/session', { headers: { Cookie: `${PREVIEW_COOKIE}=${pidB}; ${SESSION_COOKIE}=${id}` } })
      ).json()) as { user: unknown };
      assert.equal(after.user, null);
    }
  });

  it('sends each visitor only their own preview key upstream', async () => {
    const seen: Array<{ path: string; auth: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ path: url.pathname, auth: new Headers(init?.headers).get('authorization') ?? '' });
      if (url.pathname === '/api/auth/users') {
        return Response.json({ user: { id: 'app-user', email: 'new@example.com' }, accessToken: 'app-access' });
      }
      if (url.pathname === '/api/v1/models') return Response.json({ data: [] });
      if (url.pathname === '/api/database/tables') return Response.json(['posts']);
      if (url.pathname === '/api/storage/buckets') return Response.json([]);
      if (url.pathname === '/api/v1/chat/completions') {
        const body = JSON.parse(String(init?.body)) as { stream?: boolean };
        if (body.stream === false) return Response.json({ choices: [{ message: { content: 'Named chat' } }] });
        return sseEvents([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }]);
      }
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    const app = createApp({ root: linkedRoot(), env: cloudEnv({ VECTOREE_API_KEY: secret }), fetchImpl });

    for (const [key, projectId, userId] of [
      [keyA, 'proj_a', 'ua'],
      [keyB, 'proj_b', 'ub'],
    ] as const) {
      seen.length = 0;
      const cookie = previewCookie(key, projectId, userId);
      const json = { Cookie: cookie, 'Content-Type': 'application/json' };
      const register = await app.request('/api/auth/email/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie.split('; ')[0] ?? '' },
        body: JSON.stringify({ email: 'new@example.com' }),
      });
      assert.equal(register.status, 200);
      assert.equal((await app.request('/api/models', { headers: json })).status, 200);
      assert.equal((await app.request('/api/database/tables', { headers: json })).status, 200);
      assert.equal((await app.request('/api/storage/buckets', { headers: json })).status, 200);
      const chat = await app.request('/api/chat', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ model: 'vendor/chat', messages: [{ role: 'user', content: 'hello' }] }),
      });
      assert.match(await chat.text(), /hi/);
      const created = (await (await app.request('/api/conversations', { method: 'POST', headers: json, body: '{}' })).json()) as {
        id: string;
      };
      await app.request(`/api/conversations/${created.id}`, {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', content: 'hello' }] }),
      });
      const named = await app.request(`/api/conversations/${created.id}/generate-title`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ model: 'vendor/chat' }),
      });
      assert.equal(named.status, 200);

      const paths = new Set(seen.map((item) => item.path));
      for (const expected of ['/api/auth/users', '/api/v1/models', '/api/database/tables', '/api/storage/buckets', '/api/v1/chat/completions']) {
        assert.equal(paths.has(expected), true, expected);
      }
      assert.equal(
        seen.every((item) => item.auth === `Bearer ${key}`),
        true,
        JSON.stringify(seen.map((item) => item.auth)),
      );
    }
  });

  it('refuses project routes without a preview even when a link exists', async () => {
    const app = createApp({
      root: linkedRoot(),
      env: cloudEnv({ VECTOREE_PROJECT_ID: 'from-env', VECTOREE_API_KEY: secret }),
      fetchImpl: (async () => {
        throw new Error('must not reach Vectoree');
      }) as typeof fetch,
    });
    const sid = seedSession({ user: { id: 'u1', email: 'a@example.com' }, accessToken: 'app-jwt' });
    const headers = { Cookie: `${SESSION_COOKIE}=${sid}`, 'Content-Type': 'application/json' };
    for (const [method, route] of [
      ['GET', '/api/models'],
      ['GET', '/api/database/tables'],
      ['GET', '/api/storage/buckets'],
      ['GET', '/api/conversations'],
      ['GET', '/api/auth/methods'],
      ['POST', '/api/auth/email/start'],
      ['POST', '/api/chat'],
    ] as const) {
      const res = await app.request(route, {
        method,
        headers,
        ...(method === 'POST'
          ? { body: JSON.stringify({ email: 'a@example.com', password: 'pw', messages: [{ role: 'user', content: 'hi' }] }) }
          : {}),
      });
      const text = await res.text();
      assert.equal(res.status, 401, route);
      assert.equal((JSON.parse(text) as { code?: string }).code, 'preview_required', route);
      assert.equal(text.includes(secret), false);
    }
  });

  it('closes link and settings routes without writing config', async () => {
    const root = tempRoot();
    const app = createApp({ root, env: cloudEnv() });
    const pid = seedPreview({ apiUrl: vectoree, apiKey: keyA, projectId: 'proj_a' });
    const headers = { Cookie: `${PREVIEW_COOKIE}=${pid}`, 'Content-Type': 'application/json' };
    const body = JSON.stringify({ apiUrl: 'https://vectoree.ai', projectId: 'proj_x', apiKey: secret });
    for (const [method, route] of [
      ['POST', '/api/setup'],
      ['GET', '/api/setup/connect'],
      ['POST', '/api/setup/connect'],
      ['GET', '/api/setup/callback?code=x&state=y'],
      ['POST', '/api/setup/token'],
      ['GET', '/api/setup/projects'],
      ['POST', '/api/setup/link'],
      ['GET', '/api/settings'],
      ['PATCH', '/api/settings'],
    ] as const) {
      const res = await app.request(route, { method, headers, ...(method === 'GET' ? {} : { body }) });
      const text = await res.text();
      assert.equal(res.status, 404, `${method} ${route}`);
      assert.equal(text.includes('sk-ve'), false);
    }
    assert.equal(fs.existsSync(path.join(root, '.vectoree', 'config.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.env')), false);
  });

  it('keeps conversations apart per project and leaves the local path alone', async () => {
    const root = tempRoot();
    const app = createApp({ root, env: cloudEnv() });
    const cookieA = previewCookie(keyA, 'proj_a', 'same-user');
    const cookieB = previewCookie(keyB, 'proj_b', 'same-user');
    const make = async (cookie: string) =>
      (await (
        await app.request('/api/conversations', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Kept', force: true }),
        })
      ).json()) as { id: string };
    const list = async (cookie: string) =>
      ((await (await app.request('/api/conversations', { headers: { Cookie: cookie } })).json()) as { conversations: { id: string }[] })
        .conversations.map((item) => item.id);
    const a = await make(cookieA);
    const b = await make(cookieB);
    assert.deepEqual(await list(cookieA), [a.id]);
    assert.deepEqual(await list(cookieB), [b.id]);
    assert.equal((await app.request(`/api/conversations/${a.id}`, { headers: { Cookie: cookieB } })).status, 404);
    assert.equal(fs.existsSync(path.join(root, '.vectoree', 'conversations', 'proj_a', 'same-user', 'index.json')), true);

    const localRoot = tempRoot();
    writeProjectConfig(localRoot, { apiUrl: 'https://vectoree.ai', projectId: 'proj_123', apiKey: secret });
    const local = createApp({ root: localRoot, env: {} });
    const sid = seedSession({ user: { id: 'u1', email: 'a@example.com' }, accessToken: 'app-jwt' });
    await local.request('/api/conversations', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE}=${sid}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(fs.existsSync(path.join(localRoot, '.vectoree', 'conversations', 'u1', 'index.json')), true);
  });
});

describe('preview auth', () => {
  function linkedApp(fetchImpl: typeof fetch) {
    const root = tempRoot();
    writeProjectConfig(root, { apiUrl: 'https://vectoree.ai', projectId: 'proj_123', apiKey: secret });
    return createApp({ root, env: {}, fetchImpl });
  }

  function start(app: ReturnType<typeof createApp>, body: unknown) {
    return app.request('/api/auth/email/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('creates an account from an email and does not send a second code', async () => {
    const calls: string[] = [];
    let bridgePassword = '';
    const app = linkedApp((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      const payload = JSON.parse(String(init?.body)) as { password?: string };
      bridgePassword = payload.password ?? '';
      return Response.json({
        user: { id: 'app-user', email: 'new@example.com' },
        requireEmailVerification: true,
        accessToken: null,
      });
    }) as typeof fetch);

    const res = await start(app, { email: 'new@example.com' });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(text), { next: 'code' });
    assert.deepEqual(calls, ['/api/auth/users']);
    assert.equal(bridgePassword.length > 16, true);
    assert.equal(text.includes(bridgePassword), false);
    assert.equal(text.includes(secret), false);
  });

  it('resends the code when the email already has an account', async () => {
    const calls: string[] = [];
    const app = linkedApp((async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === '/api/auth/users') {
        return Response.json({ error: 'AUTH_EMAIL_EXISTS', message: 'Email already registered' }, { status: 409 });
      }
      return Response.json({ success: true }, { status: 202 });
    }) as typeof fetch);

    const res = await start(app, { email: 'known@example.com' });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(text), { next: 'code' });
    assert.deepEqual(calls, ['/api/auth/users', '/api/auth/email/send-verification']);
    assert.equal(text.includes('AUTH_EMAIL_EXISTS'), false);
    assert.equal(text.includes(secret), false);
  });

  it('stores a session when the email is already verified', async () => {
    const app = linkedApp((async () =>
      Response.json({
        user: { id: 'app-user', email: 'ready@example.com' },
        accessToken: 'app-access',
        refreshToken: 'app-refresh',
      })) as typeof fetch);

    const res = await start(app, { email: 'ready@example.com' });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(text), { next: 'signed-in', user: { id: 'app-user', email: 'ready@example.com' } });
    assert.match(res.headers.get('set-cookie') ?? '', /ve_session=/);
    assert.equal(text.includes('app-access'), false);
    assert.equal(text.includes('app-refresh'), false);
    assert.equal(text.includes(secret), false);
  });

  it('retries a transient wallet-not-activated response and still sends the code', async () => {
    let calls = 0;
    const root = tempRoot();
    writeProjectConfig(root, { apiUrl: 'https://vectoree.ai', projectId: 'proj_123', apiKey: secret });
    const app = createApp({
      root,
      env: {},
      walletRetryDelaysMs: [0],
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json(
            { code: 'BILLING_WALLET_NOT_ACTIVATED', message: 'Organization wallet is not activated' },
            { status: 402 },
          );
        }
        return Response.json({
          user: { id: 'app-user', email: 'funded@example.com' },
          requireEmailVerification: true,
        });
      }) as typeof fetch,
    });
    const res = await start(app, { email: 'funded@example.com' });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(text), { next: 'code' });
    assert.equal(calls, 2);
    assert.equal(text.includes('wallet is not activated'), false);
  });

  it('reports an inactive wallet only after the same 402 keeps coming back', async () => {
    let calls = 0;
    const root = tempRoot();
    writeProjectConfig(root, { apiUrl: 'https://vectoree.ai', projectId: 'proj_123', apiKey: secret });
    const app = createApp({
      root,
      env: {},
      walletRetryDelaysMs: [0, 0],
      fetchImpl: (async () => {
        calls += 1;
        return Response.json({ message: 'Organization wallet is not activated' }, { status: 402 });
      }) as typeof fetch,
    });
    const res = await start(app, { email: 'empty@example.com' });
    const body = (await res.json()) as { message?: string; code?: string };
    assert.equal(res.status, 402);
    assert.equal(body.message, 'Organization wallet is not activated');
    assert.equal(body.code, 'BILLING_WALLET_NOT_ACTIVATED');
    assert.equal(calls, 3);
  });

  it('does not retry a wallet sentence that is not a 402', async () => {
    let calls = 0;
    const root = tempRoot();
    writeProjectConfig(root, { apiUrl: 'https://vectoree.ai', projectId: 'proj_123', apiKey: secret });
    const app = createApp({
      root,
      env: {},
      walletRetryDelaysMs: [0, 0],
      fetchImpl: (async () => {
        calls += 1;
        return Response.json({ message: 'Organization wallet is not activated' }, { status: 503 });
      }) as typeof fetch,
    });
    const res = await start(app, { email: 'funded@example.com' });
    const body = (await res.json()) as { message?: string; code?: string };
    assert.equal(res.status, 503);
    assert.equal(body.message, 'Organization wallet is not activated');
    assert.equal(body.code, undefined);
    assert.equal(calls, 1);
  });

  it('rejects an empty email before calling upstream', async () => {
    const app = linkedApp((async () => {
      throw new Error('must not reach Vectoree');
    }) as typeof fetch);
    const res = await start(app, { email: '   ' });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { message?: string }).message, 'email is required');
  });

  it('rejects a resend until 60 seconds after the code was sent', async () => {
    let verificationSends = 0;
    const app = linkedApp((async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/auth/email/send-verification') verificationSends += 1;
      return Response.json({
        user: { id: 'app-user', email: 'new@example.com' },
        requireEmailVerification: true,
      });
    }) as typeof fetch);

    assert.equal((await start(app, { email: 'new@example.com' })).status, 200);
    const resend = await app.request('/api/auth/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com' }),
    });
    assert.equal(resend.status, 429);
    assert.equal(verificationSends, 0);
  });

  it('emails a reset code, then saves the password with the project key', async () => {
    const calls: Array<{ path: string; auth: string; body: Record<string, string> }> = [];
    const app = linkedApp((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const payload = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
      calls.push({ path: url.pathname, auth: new Headers(init?.headers).get('authorization') ?? '', body: payload });
      if (url.pathname === '/api/auth/users') {
        return Response.json({
          user: { id: 'app-user', email: 'ready@example.com' },
          accessToken: 'app-access',
          refreshToken: 'app-refresh',
        });
      }
      if (url.pathname === '/api/auth/email/send-reset-password') return Response.json({ success: true }, { status: 202 });
      if (url.pathname === '/api/auth/email/exchange-reset-password-token') return Response.json({ token: 'reset-token' });
      if (url.pathname === '/api/auth/email/reset-password') return Response.json({ message: 'Password reset successfully' });
      return new Response('missing', { status: 404 });
    }) as typeof fetch);

    const started = await start(app, { email: 'ready@example.com' });
    const cookie = (started.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const pending = await app.request('/api/account/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ password: 'chosen-secret', confirmPassword: 'chosen-secret' }),
    });
    assert.equal(pending.status, 200);
    assert.deepEqual(await pending.json(), { next: 'code' });

    const saved = await app.request('/api/account/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ password: 'chosen-secret', confirmPassword: 'chosen-secret', code: '123456' }),
    });
    const text = await saved.text();
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true });
    const resetCalls = calls.filter((item) => item.path.startsWith('/api/auth/email/'));
    assert.deepEqual(
      resetCalls.map((item) => item.path),
      ['/api/auth/email/send-reset-password', '/api/auth/email/exchange-reset-password-token', '/api/auth/email/reset-password'],
    );
    assert.ok(resetCalls.every((item) => item.auth === `Bearer ${secret}`));
    assert.deepEqual(resetCalls[0]?.body, { email: 'ready@example.com' });
    assert.deepEqual(resetCalls[1]?.body, { email: 'ready@example.com', code: '123456' });
    assert.deepEqual(resetCalls[2]?.body, { newPassword: 'chosen-secret', otp: 'reset-token' });
    assert.equal(text.includes('chosen-secret'), false);
    assert.equal(text.includes('reset-token'), false);
    assert.equal(text.includes(secret), false);
  });

  it('hides an upstream HTML error when the reset email cannot be sent', async () => {
    const app = linkedApp((async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/auth/email/send-reset-password') {
        return new Response('<html><pre>Cannot POST /api/auth/password</pre></html>', {
          status: 404,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      return new Response('missing', { status: 404 });
    }) as typeof fetch);
    const sid = seedSession({ user: { id: 'app-user', email: 'ready@example.com' }, accessToken: 'app-access' });
    const res = await app.request('/api/account/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${sid}` },
      body: JSON.stringify({ password: 'chosen-secret', confirmPassword: 'chosen-secret' }),
    });
    const body = (await res.json()) as { message?: string };
    assert.equal(res.status, 404);
    assert.equal(body.message, 'Could not email a reset code');
  });

  it('rejects a password that does not match its confirmation', async () => {
    const app = linkedApp((async () => {
      throw new Error('must not reach Vectoree');
    }) as typeof fetch);
    const sid = seedSession({ user: { id: 'app-user', email: 'ready@example.com' }, accessToken: 'app-access' });
    const res = await app.request('/api/account/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${sid}` },
      body: JSON.stringify({ password: 'chosen-secret', confirmPassword: 'other-secret' }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { message?: string }).message, 'Passwords do not match');
  });
});
