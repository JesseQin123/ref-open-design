import type { Express } from 'express';
import type { WorkspaceContextResponse } from '@open-design/contracts';
import {
  parseWorkspaceCollabContext,
  type WorkspaceContextProvider,
} from '../collab/workspace-context.js';

export interface RegisterCollabContextRoutesDeps {
  workspaceContext: WorkspaceContextProvider;
}

/**
 * Workspace-context route : the daemon's single B-integration seam. The
 * web client fetches the current caller's workspace context here to decide
 * whether collab runs and who the present member is (resolveCollabSession). In
 * production the provider proxies B; the dev provider is settable via PUT so a
 * demo/tools-dev run can exercise the full path before B is reachable.
 */
export function registerCollabContextRoutes(app: Express, deps: RegisterCollabContextRoutesDeps): void {
  const { workspaceContext } = deps;

  app.get('/api/workspace/context', async (req, res) => {
    const authorization = req.header('authorization') ?? undefined;
    const context = await workspaceContext.current({ authorization });
    const body: WorkspaceContextResponse = { context };
    res.json(body);
  });

  // Dev/demo seam: override the in-memory context. A real B-backed provider does
  // not expose `set`, so this 404s in production instead of spoofing identity.
  app.put('/api/workspace/context', (req, res) => {
    if (!workspaceContext.set) {
      return res.status(404).json({ error: 'workspace context is not settable' });
    }
    const body = req.body as unknown;
    // `null` explicitly clears the context (sign-out / leave team).
    if (body === null || (body && typeof body === 'object' && Object.keys(body).length === 0)) {
      workspaceContext.set(null);
      const cleared: WorkspaceContextResponse = { context: null };
      return res.json(cleared);
    }
    const context = parseWorkspaceCollabContext(body);
    if (!context) return res.status(400).json({ error: 'invalid workspace context' });
    workspaceContext.set(context);
    const response: WorkspaceContextResponse = { context };
    res.json(response);
  });
}
