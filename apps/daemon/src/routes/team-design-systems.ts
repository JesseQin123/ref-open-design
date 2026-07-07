import type { Express } from 'express';
import type { TeamDesignSystemShareService } from '../collab/team-design-system-share.js';

export interface RegisterTeamDesignSystemRoutesDeps {
  share: TeamDesignSystemShareService;
}

/**
 * Team design-system sharing routes. A member promotes a personal design system
 * into the team scope; the share service packs its directory and pushes it to
 * the resource hub under the `design_system` kind so teammates can pull it. When
 * there is no team identity (or the hub is not configured), share returns
 * `shared: false` so the client keeps a local-only view instead of erroring.
 */
export function registerTeamDesignSystemRoutes(
  app: Express,
  deps: RegisterTeamDesignSystemRoutesDeps,
): void {
  const { share } = deps;

  // Ids of design systems shared to the team — drives the "team" collection.
  app.get('/api/workspace/design-systems/team', (_req, res) => {
    res.json({ ids: share.sharedIds() });
  });

  // Share a personal design system to the team.
  app.post('/api/workspace/design-systems/:id/share', async (req, res) => {
    const id = typeof req.params.id === 'string' ? decodeURIComponent(req.params.id) : '';
    if (!id) return res.status(400).json({ error: 'invalid design system id' });
    try {
      const result = await share.share(id);
      if (!result) return res.json({ shared: false });
      res.json({ shared: true, version: result.version });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'share failed' });
    }
  });
}
