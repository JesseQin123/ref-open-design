import { useEffect, useState } from 'react';
import type { CollabPresenceMember, WorkspaceCollabContext } from '@open-design/contracts';
import { resolveCollabSession } from './collab-session';
import { useCollab } from './useCollab';

export interface UseProjectCollabOptions {
  /** Injectable for tests. */
  fetch?: typeof fetch;
  baseUrl?: string;
  heartbeatMs?: number;
  statusPollMs?: number;
}

/**
 * Fetch the current workspace context (B-integration seam, GET /api/workspace/
 * context). Null until it loads, or when there is no team-workspace context
 * (personal / signed out / hub unavailable). The daemon serves a dev context
 * until B is wired; production proxies B.
 */
export function useWorkspaceContext(options: UseProjectCollabOptions = {}): WorkspaceCollabContext | null {
  const [context, setContext] = useState<WorkspaceCollabContext | null>(null);
  const baseUrl = options.baseUrl ?? '';
  const fetchImpl = options.fetch;

  useEffect(() => {
    let cancelled = false;
    const run = fetchImpl ?? globalThis.fetch.bind(globalThis);
    void (async () => {
      try {
        const response = await run(`${baseUrl}/api/workspace/context`);
        if (!response.ok) return;
        const body = (await response.json()) as { context?: WorkspaceCollabContext | null };
        if (!cancelled) setContext(body?.context ?? null);
      } catch {
        if (!cancelled) setContext(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchImpl]);

  return context;
}

export interface ProjectCollab {
  /** Whether collab (presence + sync) is active for this project + viewer. */
  enabled: boolean;
  /** The viewer's presence identity, when enabled. */
  member: CollabPresenceMember | null;
  present: CollabPresenceMember[];
  publishedVersion: number | null;
  syncState: ReturnType<typeof useCollab>['syncState'];
  /**
   * Whether the viewer should see this project single-writer/read-only: it has
   * been shared to the team and the viewer is not its owner (the member who
   * shared it). Ownership — not workspace role — is the determinant, so the
   * sharer keeps editing their own project while everyone else views it
   * read-only. A personal or unshared project is never read-only.
   */
  viewerOnly: boolean;
  reportChange: () => void;
  requestPublish: () => void;
}

/**
 * Real-product collab integration for a project : resolves the workspace
 * context → decides whether collab runs (team member of a live workspace) → runs
 * presence + sync for the viewer. Dormant (enabled=false, no heartbeat) when the
 * project is personal / the viewer is not a team member — so it is safe to mount
 * unconditionally in the project view.
 */
export function useProjectCollab(
  projectId: string | null | undefined,
  options: UseProjectCollabOptions = {},
): ProjectCollab {
  const context = useWorkspaceContext(options);
  const decision = resolveCollabSession(context);
  const collab = useCollab({
    projectId: projectId ?? null,
    member: decision.member,
    enabled: decision.enabled,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
    ...(options.statusPollMs !== undefined ? { statusPollMs: options.statusPollMs } : {}),
  });
  // A project shared to the team (syncState past `local_only`) is read-only for
  // everyone except the member who shared it — the single writer keeps editing
  // their own project. Until the owner id has been polled, fall back to the
  // workspace role so a member does not momentarily get edit affordances on a
  // shared project. A personal / unshared project is never read-only.
  const shared = collab.syncState !== 'local_only' && collab.syncState !== null;
  const isOwner = collab.ownerMemberId != null && collab.ownerMemberId === context?.workspaceMemberId;
  const viewerOnly = shared && !isOwner && (collab.ownerMemberId != null || context?.role === 'member');
  return {
    enabled: decision.enabled,
    member: decision.member,
    present: collab.present,
    publishedVersion: collab.publishedVersion,
    syncState: collab.syncState,
    viewerOnly,
    reportChange: collab.reportChange,
    requestPublish: collab.requestPublish,
  };
}
