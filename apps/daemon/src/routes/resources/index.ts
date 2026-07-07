import type { Express, Request, Response } from 'express';

import {
  ResourceHubError,
  createResourceHubClient,
  readResourceHubPrincipal,
  type ResourceHubClient,
} from '../../integrations/resource-hub.js';

// Daemon-local team-resource-sharing surface (Spec E, daemon side). Thin: it
// resolves the workspace principal and proxies the INDEX operations to the hub.
// The capability operations (share/pull) that wrap the local design-system /
// plugin / skill managers into blobs + manifests are stubbed 501 — they depend
// on the blob transport decision (presigned vs proxy) and the shared_resources
// local mapping, which are not built yet. Self-contained on purpose so the
// server.ts wiring is a single dep-free call.

interface RegisterResourceSharingRoutesOptions {
  client?: ResourceHubClient;
}

function resolvePrincipalOr401(res: Response) {
  const principal = readResourceHubPrincipal();
  if (!principal) {
    res.status(401).json({ error: 'workspace_principal_unavailable' });
    return null;
  }
  return principal;
}

function handleHubError(res: Response, error: unknown) {
  if (error instanceof ResourceHubError) {
    res.status(error.status).json({ error: error.code });
    return;
  }
  res.status(502).json({ error: 'resource_hub_unreachable' });
}

export function registerResourceSharingRoutes(
  app: Express,
  options: RegisterResourceSharingRoutesOptions = {},
): void {
  const client = options.client ?? createResourceHubClient();

  // Readiness probe: confirms wiring (hub URL configured, principal resolvable)
  // without touching data — useful for the local closed-loop check.
  app.get('/api/resources/_status', (_req: Request, res: Response) => {
    res.json({
      configured: client.isConfigured(),
      principalAvailable: readResourceHubPrincipal() !== null,
    });
  });

  app.get('/api/resources', async (_req: Request, res: Response) => {
    const principal = resolvePrincipalOr401(res);
    if (!principal) return;
    try {
      res.json({ resources: await client.listResources(principal) });
    } catch (error) {
      handleHubError(res, error);
    }
  });

  // Capability ops pending wrap logic + transport decision.
  app.post(
    '/api/resources/:kind/:id/share',
    (_req: Request, res: Response) => {
      res.status(501).json({
        error: 'not_implemented',
        detail:
          'sharing wraps the local resource into blobs+manifest; pending blob transport decision and shared_resources mapping',
      });
    },
  );

  app.post('/api/resources/:kind/:id/pull', (_req: Request, res: Response) => {
    res.status(501).json({
      error: 'not_implemented',
      detail: 'pull materializes a hub version locally; pending blob transport decision',
    });
  });
}
