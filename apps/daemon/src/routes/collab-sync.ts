import type { Express } from 'express';
import type { ProjectSyncIntentEvent } from '@open-design/contracts';
import type { CollabRuntime } from '../collab/runtime.js';

export interface RegisterCollabSyncRoutesDeps {
  collab: Pick<
    CollabRuntime,
    | 'scheduler'
    | 'publishedVersion'
    | 'projectSyncState'
    | 'projectOwnerMemberId'
    | 'requestTeamShare'
    | 'pullLatest'
    | 'workspaceContext'
  >;
}

const SYNC_INTENT_EVENTS: ReadonlySet<ProjectSyncIntentEvent> = new Set([
  'project_visibility_changed',
  'project_team_share_requested',
]);

/**
 * Team collaboration sync trigger, exposed as a client-driven capability . The client is authoritative about whether it is in a shared context, so
 * it drives the trigger — the daemon does not need D's visibility fact to gate
 * this. Publishing content + advancing the published ref is the resource hub; here
 * we only coalesce and flush.
 */
export function registerCollabSyncRoutes(app: Express, deps: RegisterCollabSyncRoutesDeps): void {
  const {
    scheduler,
    publishedVersion,
    projectSyncState,
    projectOwnerMemberId,
    requestTeamShare,
    pullLatest,
    workspaceContext,
  } = deps.collab;

  // An author-side edit landed. The publish is coalesced within the scheduler's
  // window so a burst of edits collapses into one publish.
  app.post('/api/projects/:id/collab/changed', (req, res) => {
    scheduler.notifyChanged(req.params.id, 'change');
    res.json({ ok: true });
  });

  // Run boundary — flush any pending publish immediately (publish the stable
  // end-of-run state rather than waiting out the debounce).
  app.post('/api/projects/:id/collab/publish', (req, res) => {
    scheduler.notifyChanged(req.params.id, 'run');
    scheduler.runBoundary(req.params.id);
    res.json({ ok: true });
  });

  // visibility-to-sync orchestration seam. The visibility surface flips project visibility and emits a
  // ProjectSyncIntent here; the sync trigger owns the reaction. `project_team_share_requested`
  // marks the project pending and flushes a publish (which drives E's resource
  // mechanism behind the scheduler). `project_visibility_changed` is accepted as
  // a no-op signal for now (the share request is the actionable one).
  app.post('/api/projects/:id/collab/sync-intent', async (req, res) => {
    const event = (req.body as { event?: unknown } | undefined)?.event;
    if (typeof event !== 'string' || !SYNC_INTENT_EVENTS.has(event as ProjectSyncIntentEvent)) {
      return res.status(400).json({ error: 'invalid sync intent event' });
    }
    if (event === 'project_team_share_requested') {
      // The caller sharing the project is its single writer; record their id so
      // members can distinguish it from a project of their own.
      const context = await workspaceContext.current({
        authorization: req.headers.authorization,
      });
      requestTeamShare(req.params.id, context?.workspaceMemberId);
    }
    res.json({ ok: true, syncState: projectSyncState(req.params.id) });
  });

  // Member pull trigger (the sync trigger owns *when*; the resource hub fetches + extracts the bytes behind the
  // adapter). Returns the head version that was pulled.
  app.post('/api/projects/:id/collab/pull', async (req, res) => {
    const result = await pullLatest(req.params.id);
    res.json({ ok: true, version: result.version });
  });

  // Members poll this to learn the published head version they should pull and
  // the current sync state (local_only / pending_upload / synced / sync_failed).
  app.get('/api/projects/:id/collab/status', (req, res) => {
    res.json({
      publishedVersion: publishedVersion(req.params.id),
      syncState: projectSyncState(req.params.id),
      ownerMemberId: projectOwnerMemberId(req.params.id),
    });
  });
}
