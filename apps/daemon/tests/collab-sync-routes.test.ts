import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createCollabRuntime, type CollabRuntime } from '../src/collab/runtime.js';
import { registerCollabSyncRoutes } from '../src/routes/collab-sync.js';

let server: http.Server | null = null;
let runtime: CollabRuntime | null = null;

afterEach(async () => {
  runtime?.dispose(); // cancel any pending debounce timers
  runtime = null;
  if (server) {
    const toClose = server;
    server = null;
    await new Promise<void>((resolve) => toClose.close(() => resolve()));
  }
});

async function startSyncServer() {
  const app = express();
  app.use(express.json());
  runtime = createCollabRuntime();
  registerCollabSyncRoutes(app, { collab: runtime });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    async json(route: string, options: { method?: string; body?: unknown } = {}) {
      const init: RequestInit = { method: options.method ?? 'GET' };
      if (options.body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(options.body);
      }
      const response = await fetch(`${base}${route}`, init);
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    },
    // Publishing is async (flush → adapter → onPublished); poll until it lands.
    async awaitPublishedVersion(route: string, notEqualTo: number | null): Promise<number | null> {
      let version = notEqualTo;
      for (let i = 0; i < 40 && version === notEqualTo; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        version = (await this.json(route)).body.publishedVersion;
      }
      return version;
    },
  };
}

describe('collab sync routes', () => {
  it('publishes on request and advances the published version monotonically', async () => {
    const api = await startSyncServer();
    expect((await api.json('/api/projects/p1/collab/status')).body.publishedVersion).toBeNull();

    const pub = await api.json('/api/projects/p1/collab/publish', { method: 'POST' });
    expect(pub.status).toBe(200);
    expect(pub.body.ok).toBe(true);

    const v1 = await api.awaitPublishedVersion('/api/projects/p1/collab/status', null);
    expect(v1).toBe(1);

    await api.json('/api/projects/p1/collab/publish', { method: 'POST' });
    const v2 = await api.awaitPublishedVersion('/api/projects/p1/collab/status', v1);
    expect(v2).toBe(2);
  });

  it('accepts a coalesced change notification', async () => {
    const api = await startSyncServer();
    const res = await api.json('/api/projects/p1/collab/changed', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('keeps published versions independent per project', async () => {
    const api = await startSyncServer();
    await api.json('/api/projects/a/collab/publish', { method: 'POST' });
    await api.awaitPublishedVersion('/api/projects/a/collab/status', null);
    expect((await api.json('/api/projects/b/collab/status')).body.publishedVersion).toBeNull();
  });

  it('reports local_only sync state before any share', async () => {
    const api = await startSyncServer();
    expect((await api.json('/api/projects/p1/collab/status')).body.syncState).toBe('local_only');
  });

  it('drives the visibility-to-sync team-share intent through to synced', async () => {
    const api = await startSyncServer();
    const intent = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    expect(intent.status).toBe(200);
    // The intent marks it pending immediately; the publish confirms asynchronously.
    expect(['pending_upload', 'synced']).toContain(intent.body.syncState);

    // Poll until the publish confirms → synced.
    let state = intent.body.syncState;
    for (let i = 0; i < 40 && state !== 'synced'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = (await api.json('/api/projects/p1/collab/status')).body.syncState;
    }
    expect(state).toBe('synced');
    expect((await api.json('/api/projects/p1/collab/status')).body.publishedVersion).toBe(1);
  });

  it('accepts a visibility-changed intent as a no-op signal', async () => {
    const api = await startSyncServer();
    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_visibility_changed', projectId: 'p1' },
    });
    expect(res.status).toBe(200);
    expect(res.body.syncState).toBe('local_only'); // visibility change alone doesn't publish
  });

  it('rejects an unknown sync intent event', async () => {
    const api = await startSyncServer();
    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'nonsense', projectId: 'p1' },
    });
    expect(res.status).toBe(400);
  });

  it('pulls the published head for a member (null before any publish)', async () => {
    const api = await startSyncServer();
    const before = await api.json('/api/projects/p1/collab/pull', { method: 'POST' });
    expect(before.status).toBe(200);
    expect(before.body.version).toBeNull();

    await api.json('/api/projects/p1/collab/publish', { method: 'POST' });
    await api.awaitPublishedVersion('/api/projects/p1/collab/status', null);
    const after = await api.json('/api/projects/p1/collab/pull', { method: 'POST' });
    expect(after.body.version).toBe(1);
  });
});
