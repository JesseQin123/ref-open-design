import type { OkResponse } from '../common.js';
import type { ProjectSyncState } from './project-sync.js';

// Team-edition collaboration shared DTOs: presence overlay (presence) and
// the sync trigger. Single source of truth for the daemon routes, the web
// CollabClient, and the `od collab` CLI so no surface re-declares these shapes.

export type CollabMemberRole = 'owner' | 'admin' | 'member';

/** A member present in a shared project (heartbeat identity). */
export interface CollabPresenceMember {
  memberId: string;
  name?: string;
  role?: CollabMemberRole;
}

/** GET /api/projects/:id/presence and the heartbeat response body. */
export interface CollabPresenceResponse {
  present: CollabPresenceMember[];
}

/** POST /api/projects/:id/presence/heartbeat request body. */
export interface CollabPresenceHeartbeatRequest {
  memberId: string;
  name?: string;
  role?: CollabMemberRole;
}

/** POST /api/projects/:id/presence/leave request body. */
export interface CollabPresenceLeaveRequest {
  memberId: string;
}

export interface CollabPresenceLeaveResponse extends OkResponse {
  present: CollabPresenceMember[];
}

/**
 * GET /api/projects/:id/collab/status. `publishedVersion` is the head version
 * members poll to learn when to pull; null before the first publish.
 * `syncState` is the project sync state (see {@link ProjectSyncState}).
 */
export interface CollabSyncStatusResponse {
  publishedVersion: number | null;
  syncState: ProjectSyncState;
}

/** POST /api/projects/:id/collab/sync-intent response. */
export interface CollabSyncIntentResponse extends OkResponse {
  syncState: ProjectSyncState;
}

// Workspace context seam onto the B (identity/membership) + D (visibility)
// lanes. A faithful SUBSET of B's `CurrentWorkspaceContext`
// (vela packages/shared/src/workspace-context.ts) — the exact fields C needs to
// decide whether collab runs and who the present member is — so wiring B's real
// context in is a direct field pass-through. Field names mirror B verbatim.

export type WorkspaceType = 'personal' | 'team';
export type WorkspaceMemberStatus = 'active' | 'removed';
export type WorkspaceLifecycleState =
  | 'active'
  | 'billing_past_due'
  | 'locked'
  | 'deleting'
  | 'deleted';

export interface WorkspaceCollabContext {
  workspaceType: WorkspaceType;
  workspaceMemberId: string;
  role: CollabMemberRole;
  memberStatus: WorkspaceMemberStatus;
  lifecycleState: WorkspaceLifecycleState;
  /** Display name for the presence overlay (optional; falls back to the id). */
  displayName?: string;
}

/**
 * GET /api/workspace/context. The daemon's single B-integration point: in
 * production it proxies B's context for the caller; `context` is null when there
 * is no team-workspace context (personal, signed out, or B unavailable).
 */
export interface WorkspaceContextResponse {
  context: WorkspaceCollabContext | null;
}
