// Team-collab (C lane) daemon subsystem: bundles the author-side publish
// scheduler and the presence tracker behind one factory so the server wires
// them once. The resource hub itself is E's (沅锡) — this holds only C's
// trigger + presence, talking to the hub through ResourcePublishAdapter.

import {
  CollabPresenceTracker,
  type CollabPresenceTrackerOptions,
  type PresenceMember,
} from './presence-tracker.js';
import {
  CollabPublishScheduler,
  type CollabPublishSchedulerOptions,
  type ResourcePublishAdapter,
} from './publish-scheduler.js';
import { createStubResourcePublishAdapter } from './stub-resource-adapter.js';
import {
  createDevWorkspaceContextProvider,
  type WorkspaceContextProvider,
} from './workspace-context.js';
import {
  createDevTeamResourceStateProvider,
  type TeamResourceStateProvider,
} from './team-resource-state.js';
import type { ProjectSyncState } from '@open-design/contracts';

export interface CollabRuntime {
  presence: CollabPresenceTracker;
  scheduler: CollabPublishScheduler;
  /** Workspace-context provider — the B-integration seam (identity/visibility). */
  workspaceContext: WorkspaceContextProvider;
  /** Team-resource state provider — the E-resource-hub seam (share/freeze state). */
  teamResources: TeamResourceStateProvider;
  /** Last published version for a project (members poll this to know what to pull). */
  publishedVersion(projectId: string): number | null;
  /** C-owned sync state for a project (`local_only` until a share is requested). */
  projectSyncState(projectId: string): ProjectSyncState;
  /**
   * D→C sync-intent seam: mark a project as awaiting upload and flush a publish.
   * D calls this (through the route) when a project flips to team-visible; C
   * orchestrates the publish, which drives E's resource mechanism behind it.
   */
  requestTeamShare(projectId: string): void;
  /**
   * Member pull trigger (C owns *when* to pull). Reads the published head via
   * the adapter (E's `syncLatest`); E's client also fetches + extracts the
   * bytes locally. Returns the head version, or null if nothing is published.
   */
  pullLatest(projectId: string): Promise<{ version: number | null }>;
  dispose(): void;
}

export interface CreateCollabRuntimeOptions {
  /** Resource hub client. Defaults to the local stub until E's client ships. */
  adapter?: ResourcePublishAdapter;
  /** Workspace-context provider. Defaults to the dev provider until B's client ships. */
  workspaceContext?: WorkspaceContextProvider;
  /** Team-resource state provider. Defaults to the dev provider until E's hub ships. */
  teamResources?: TeamResourceStateProvider;
  /** Fired after a project is published so the caller can notify online members. */
  onPublished?: (result: { projectId: string; version: number; reason: string }) => void;
  /** Fired when a project's presence set changes (join/leave). */
  onPresenceChange?: (result: { projectId: string; present: PresenceMember[] }) => void;
  onError?: (result: { projectId: string; error: unknown }) => void;
}

export function createCollabRuntime(options: CreateCollabRuntimeOptions = {}): CollabRuntime {
  const adapter = options.adapter ?? createStubResourcePublishAdapter();
  const published = new Map<string, number>();
  const syncStates = new Map<string, ProjectSyncState>();
  // Always track the published head + sync state so members can poll them; also
  // forward to any caller-supplied callback. (exactOptionalPropertyTypes forbids
  // assigning an explicit `undefined` to an optional property, hence we always
  // wrap onError rather than passing options.onError through conditionally.)
  const schedulerOptions: CollabPublishSchedulerOptions = {
    adapter,
    onPublished: (result) => {
      published.set(result.projectId, result.version);
      syncStates.set(result.projectId, 'synced');
      options.onPublished?.(result);
    },
    onError: (result) => {
      // A failed publish leaves the prior head standing; surface it as a
      // recoverable sync state rather than wedging the project.
      syncStates.set(result.projectId, 'sync_failed');
      options.onError?.(result);
    },
  };
  const scheduler = new CollabPublishScheduler(schedulerOptions);
  const presenceOptions: CollabPresenceTrackerOptions = {};
  if (options.onPresenceChange) presenceOptions.onChange = options.onPresenceChange;
  const presence = new CollabPresenceTracker(presenceOptions);
  const workspaceContext = options.workspaceContext ?? createDevWorkspaceContextProvider();
  const teamResources = options.teamResources ?? createDevTeamResourceStateProvider();
  return {
    presence,
    scheduler,
    workspaceContext,
    teamResources,
    publishedVersion: (projectId) => published.get(projectId) ?? null,
    projectSyncState: (projectId) => syncStates.get(projectId) ?? 'local_only',
    requestTeamShare(projectId) {
      // Pending until the publish confirms (onPublished → 'synced' / onError →
      // 'sync_failed'). Flushing at a run boundary publishes the stable state.
      syncStates.set(projectId, 'pending_upload');
      scheduler.notifyChanged(projectId, 'share');
      scheduler.runBoundary(projectId);
    },
    async pullLatest(projectId) {
      // Fall back to the tracked head when the adapter can't read it (older stub).
      const head = adapter.syncLatest
        ? await adapter.syncLatest({ projectId })
        : { version: published.get(projectId) ?? null };
      return { version: head?.version ?? null };
    },
    dispose() {
      scheduler.dispose();
      presence.dispose();
    },
  };
}
