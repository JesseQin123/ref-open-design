// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectCollab } from '../src/collab/useProjectCollab';

const TEAM_CONTEXT = {
  workspaceType: 'team',
  workspaceMemberId: 'wm-1',
  role: 'member',
  memberStatus: 'active',
  lifecycleState: 'active',
  displayName: 'Ma Shu',
};

function installFetch(context: unknown, present: Array<{ memberId: string }>) {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const pathname = new URL(url, 'http://d.local').pathname;
    let payload: unknown = { ok: true };
    if (pathname.endsWith('/workspace/context')) payload = { context };
    else if (pathname.endsWith('/presence/heartbeat')) payload = { present };
    else if (pathname.endsWith('/collab/status')) payload = { publishedVersion: 2, syncState: 'synced' };
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  }) as typeof fetch;
  return fetchImpl;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useProjectCollab', () => {
  it('activates presence + sync for a team member', async () => {
    const fetchImpl = installFetch(TEAM_CONTEXT, [{ memberId: 'wm-1' }, { memberId: 'other' }]);
    const { result } = renderHook(() => useProjectCollab('p1', { fetch: fetchImpl }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0); // context fetch
      await vi.advanceTimersByTimeAsync(0); // presence/status polls
    });

    expect(result.current.enabled).toBe(true);
    expect(result.current.member).toEqual({ memberId: 'wm-1', role: 'member', name: 'Ma Shu' });
    expect(result.current.present.length).toBe(2);
    expect(result.current.publishedVersion).toBe(2);
    expect(result.current.syncState).toBe('synced');
  });

  it('stays dormant for a personal workspace (no heartbeat)', async () => {
    const calls: string[] = [];
    const base = installFetch({ ...TEAM_CONTEXT, workspaceType: 'personal' }, []);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new URL(String(input), 'http://d.local').pathname);
      return base(input, init);
    }) as typeof fetch;
    const { result } = renderHook(() => useProjectCollab('p1', { fetch: fetchImpl }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(result.current.enabled).toBe(false);
    expect(result.current.present).toEqual([]);
    // Only the context was fetched; no presence heartbeat fired.
    expect(calls.some((p) => p.endsWith('/presence/heartbeat'))).toBe(false);
  });

  it('stays dormant when there is no workspace context', async () => {
    const fetchImpl = installFetch(null, []);
    const { result } = renderHook(() => useProjectCollab('p1', { fetch: fetchImpl }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(result.current.enabled).toBe(false);
  });
});
