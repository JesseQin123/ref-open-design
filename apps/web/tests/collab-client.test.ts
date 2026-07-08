import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollabClient, type CollabSnapshot } from '../src/collab/collab-client.js';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

interface FakeFetchOptions {
  present?: Array<{ memberId: string; name?: string }>;
  publishedVersion?: number | null;
  failPath?: string;
}

function makeFetch(options: FakeFetchOptions = {}) {
  const calls: RecordedCall[] = [];
  const state = {
    present: options.present ?? [{ memberId: 'm1', name: 'Author' }],
    publishedVersion: options.publishedVersion ?? null,
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const pathname = new URL(url, 'http://daemon.local').pathname;
    if (options.failPath && pathname.endsWith(options.failPath)) {
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }
    let payload: unknown = { ok: true };
    if (pathname.endsWith('/presence/heartbeat')) payload = { present: state.present };
    else if (pathname.endsWith('/collab/status')) payload = { publishedVersion: state.publishedVersion };
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls, state };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CollabClient', () => {
  it('sends an immediate heartbeat + status poll on start and updates the snapshot', async () => {
    const { fetchImpl, calls, state } = makeFetch({
      present: [{ memberId: 'm1', name: 'Author' }],
      publishedVersion: 4,
    });
    const updates: CollabSnapshot[] = [];
    const client = new CollabClient({
      projectId: 'p1',
      member: { memberId: 'm1', name: 'Author', role: 'owner' },
      fetch: fetchImpl,
      onUpdate: (snapshot) => updates.push(snapshot),
    });

    client.start();
    await vi.advanceTimersByTimeAsync(0);

    const heartbeat = calls.find((c) => c.url.endsWith('/presence/heartbeat'));
    expect(heartbeat?.method).toBe('POST');
    expect(heartbeat?.body).toMatchObject({ memberId: 'm1', name: 'Author', role: 'owner' });
    expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/collab/status'))).toBe(true);

    const snapshot = client.getSnapshot();
    expect(snapshot.present).toEqual(state.present);
    expect(snapshot.publishedVersion).toBe(4);
    expect(updates.length).toBeGreaterThanOrEqual(2);

    client.stop();
  });

  it('re-heartbeats and re-polls on their own intervals', async () => {
    const { fetchImpl, calls } = makeFetch();
    const client = new CollabClient({
      projectId: 'p1',
      member: { memberId: 'm1' },
      fetch: fetchImpl,
      heartbeatMs: 10_000,
      statusPollMs: 5_000,
    });

    client.start();
    await vi.advanceTimersByTimeAsync(0);
    const initialHeartbeats = calls.filter((c) => c.url.endsWith('/presence/heartbeat')).length;
    const initialStatus = calls.filter((c) => c.url.endsWith('/collab/status')).length;

    // One full heartbeat window: status polls twice more (5s each), heartbeat once more.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(calls.filter((c) => c.url.endsWith('/presence/heartbeat')).length).toBe(initialHeartbeats + 1);
    expect(calls.filter((c) => c.url.endsWith('/collab/status')).length).toBe(initialStatus + 2);

    client.stop();
  });

  it('reports author changes and requests a publish through the sync routes', async () => {
    const { fetchImpl, calls } = makeFetch();
    const client = new CollabClient({ projectId: 'p9', member: { memberId: 'm1' }, fetch: fetchImpl });

    await client.reportChange();
    await client.requestPublish();

    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/p9/collab/changed'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/p9/collab/publish'))).toBe(true);
  });

  it('sends leave and stops polling on stop', async () => {
    const { fetchImpl, calls } = makeFetch();
    const client = new CollabClient({
      projectId: 'p1',
      member: { memberId: 'm1' },
      fetch: fetchImpl,
      heartbeatMs: 10_000,
    });

    client.start();
    await vi.advanceTimersByTimeAsync(0);
    client.stop();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/presence/leave'))).toBe(true);

    const afterStop = calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.length).toBe(afterStop); // timers cleared — no further polling
  });

  it('leaveBeacon delivers the leave via sendBeacon so it survives page unload', () => {
    const { fetchImpl, calls } = makeFetch();
    const beacons: Array<{ url: string; body: string }> = [];
    const sendBeacon = vi.fn((url: string, blob: Blob) => {
      // Blob.text() is async; the daemon parses the JSON body, so record the URL
      // and mark it delivered. Body shape is asserted via the fallback test.
      beacons.push({ url, body: String((blob as unknown as { type: string }).type) });
      return true;
    });
    vi.stubGlobal('navigator', { sendBeacon });
    const client = new CollabClient({ projectId: 'p1', member: { memberId: 'm1' }, fetch: fetchImpl });

    client.leaveBeacon();

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(beacons[0]!.url).toBe('/api/projects/p1/presence/leave');
    // Beacon path used — no keepalive fetch fallback.
    expect(calls.some((c) => c.url.endsWith('/presence/leave'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('leaveBeacon falls back to a keepalive fetch when sendBeacon is unavailable', () => {
    const { fetchImpl, calls } = makeFetch();
    vi.stubGlobal('navigator', {});
    const client = new CollabClient({ projectId: 'p1', member: { memberId: 'm-x' }, fetch: fetchImpl });

    client.leaveBeacon();

    const leave = calls.find((c) => c.url.endsWith('/presence/leave'));
    expect(leave?.method).toBe('POST');
    expect(leave?.body).toEqual({ memberId: 'm-x' });
    vi.unstubAllGlobals();
  });

  it('surfaces fetch failures through onError without wedging the client', async () => {
    const { fetchImpl } = makeFetch({ failPath: '/collab/status' });
    const errors: unknown[] = [];
    const client = new CollabClient({
      projectId: 'p1',
      member: { memberId: 'm1' },
      fetch: fetchImpl,
      onError: (error) => errors.push(error),
    });

    client.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(errors.length).toBeGreaterThanOrEqual(1);
    // Heartbeat still succeeded despite the status failure.
    expect(client.getSnapshot().present.length).toBeGreaterThanOrEqual(1);

    client.stop();
  });
});
