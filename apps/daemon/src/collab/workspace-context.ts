import type {
  CollabMemberRole,
  WorkspaceCollabContext,
  WorkspaceLifecycleState,
  WorkspaceMemberStatus,
  WorkspaceType,
} from '@open-design/contracts';

// The daemon's single B-integration point . Presence + sync need the
// caller's workspace identity (workspaceMemberId + role + lifecycle). In
// production this provider verifies the request's auth against the B service and
// returns B's CurrentWorkspaceContext for that user; until B is reachable, the
// dev provider below holds an in-memory context that a demo/tools-dev run can
// set. Swapping the provider is the only change when B ships — routes and the
// web client stay put.

export interface WorkspaceContextRequest {
  /** The caller's bearer token (a real provider verifies this against B). */
  authorization?: string | undefined;
}

export interface WorkspaceContextProvider {
  current(req: WorkspaceContextRequest): Promise<WorkspaceCollabContext | null>;
  /**
   * Dev/demo seam: override the returned context. Absent on a real B-backed
   * provider (whose context is derived per-request from the token).
   */
  set?(context: WorkspaceCollabContext | null): void;
}

const WORKSPACE_TYPES: ReadonlySet<WorkspaceType> = new Set(['personal', 'team']);
const ROLES: ReadonlySet<CollabMemberRole> = new Set(['owner', 'admin', 'member']);
const MEMBER_STATUSES: ReadonlySet<WorkspaceMemberStatus> = new Set(['active', 'removed']);
const LIFECYCLE_STATES: ReadonlySet<WorkspaceLifecycleState> = new Set([
  'active',
  'billing_past_due',
  'locked',
  'deleting',
  'deleted',
]);

/**
 * Validate an untrusted workspace-context payload (dev PUT body / env). Returns
 * the typed context or null if any required field is missing or out of enum.
 */
export function parseWorkspaceCollabContext(input: unknown): WorkspaceCollabContext | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const workspaceMemberId = typeof raw.workspaceMemberId === 'string' ? raw.workspaceMemberId.trim() : '';
  if (!workspaceMemberId) return null;
  if (!WORKSPACE_TYPES.has(raw.workspaceType as WorkspaceType)) return null;
  if (!ROLES.has(raw.role as CollabMemberRole)) return null;
  if (!MEMBER_STATUSES.has(raw.memberStatus as WorkspaceMemberStatus)) return null;
  if (!LIFECYCLE_STATES.has(raw.lifecycleState as WorkspaceLifecycleState)) return null;
  const context: WorkspaceCollabContext = {
    workspaceType: raw.workspaceType as WorkspaceType,
    workspaceMemberId,
    role: raw.role as CollabMemberRole,
    memberStatus: raw.memberStatus as WorkspaceMemberStatus,
    lifecycleState: raw.lifecycleState as WorkspaceLifecycleState,
  };
  if (typeof raw.displayName === 'string' && raw.displayName.trim()) {
    context.displayName = raw.displayName.trim();
  }
  return context;
}

/**
 * Dev/demo provider: holds a single in-memory context, optionally seeded from
 * `OD_DEV_WORKSPACE_CONTEXT` (JSON). Ignores the request — a real B-backed
 * provider derives the context per-caller from the token instead.
 */
export function createDevWorkspaceContextProvider(
  seed?: WorkspaceCollabContext | null,
): WorkspaceContextProvider {
  let context: WorkspaceCollabContext | null = seed ?? readEnvContext();
  return {
    current: () => Promise.resolve(context),
    set: (next) => {
      context = next;
    },
  };
}

function readEnvContext(): WorkspaceCollabContext | null {
  const raw = process.env.OD_DEV_WORKSPACE_CONTEXT;
  if (!raw) return null;
  try {
    return parseWorkspaceCollabContext(JSON.parse(raw));
  } catch {
    return null;
  }
}
