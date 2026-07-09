// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollab } from '../src/collab/useCollab.js';

function makeFetch(present: Array<{ memberId: string; name?: string }>, publishedVersion: number | null) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const pathname = new URL(url, 'http://daemon.local').pathname;
    let payload: unknown = { ok: true };
    if (pathname.endsWith('/presence/heartbeat')) payload = { present };
    else if (pathname.endsWith('/collab/status')) payload = { publishedVersion };
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useCollab', () => {
  it('populates presence + published version once the client polls', async () => {
    const { fetchImpl } = makeFetch([{ memberId: 'm1', name: 'Author' }], 3);
    const { result } = renderHook(() =>
      useCollab({ projectId: 'p1', member: { memberId: 'm1', name: 'Author' }, fetch: fetchImpl }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.present).toEqual([{ memberId: 'm1', name: 'Author' }]);
    expect(result.current.publishedVersion).toBe(3);
  });

  it('does not start when disabled', async () => {
    const { fetchImpl, calls } = makeFetch([], null);
    renderHook(() =>
      useCollab({ projectId: 'p1', member: { memberId: 'm1' }, enabled: false, fetch: fetchImpl }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(calls.length).toBe(0);
  });

  it('reportChange and requestPublish hit the sync routes', async () => {
    const { fetchImpl, calls } = makeFetch([], null);
    const { result } = renderHook(() =>
      useCollab({ projectId: 'p1', member: { memberId: 'm1' }, fetch: fetchImpl }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      result.current.reportChange();
      result.current.requestPublish();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/collab/changed'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/collab/publish'))).toBe(true);
  });

  it('stops polling on unmount', async () => {
    const { fetchImpl, calls } = makeFetch([{ memberId: 'm1' }], 1);
    const { unmount } = renderHook(() =>
      useCollab({ projectId: 'p1', member: { memberId: 'm1' }, heartbeatMs: 10_000, fetch: fetchImpl }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    const afterUnmount = calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // One trailing leave POST is allowed; no further heartbeat/status polls.
    const polls = calls.slice(afterUnmount).filter((c) => !c.url.endsWith('/presence/leave'));
    expect(polls.length).toBe(0);
  });
});
