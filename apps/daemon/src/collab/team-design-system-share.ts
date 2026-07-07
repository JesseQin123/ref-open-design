// Team design-system sharing. A member with publish rights promotes a personal
// design system into the team scope: the system's directory is packed and
// pushed to the resource hub under the `design_system` kind, so teammates can
// pull it into their own workspace. This reuses the same content-addressed
// publish machinery as project sync — only the resource kind and id namespace
// differ — and degrades to a no-op when there is no team identity or the hub is
// not configured (the same identity gate as the rest of the collab surface).

import {
  createResourceHubClient,
  readResourceHubConfig,
  type ResourceHubClient,
  type ResourceHubPrincipal,
} from '../integrations/resource-hub.js';
import { createResourceHubPublishAdapter } from './resource-hub-publish-adapter.js';

const DESIGN_SYSTEM_KIND = 'design_system';

export interface TeamDesignSystemShareService {
  /** Share a design system to the team. Returns the published version, or null off-team. */
  share(designSystemId: string): Promise<{ version: number } | null>;
  /** Ids of design systems shared to the team in this session. */
  sharedIds(): string[];
  /** True once a design system has been shared to the team. */
  isShared(designSystemId: string): boolean;
  /** Whether the hub is reachable (share is a no-op otherwise). */
  readonly configured: boolean;
}

export interface CreateTeamDesignSystemShareOptions {
  /** Resolve a design system's source directory (what gets packed and pushed). */
  resolveDesignSystemDir: (designSystemId: string) => string;
  /** Resolve the current principal (null = no team identity → share no-ops). */
  getPrincipal: () => ResourceHubPrincipal | null | Promise<ResourceHubPrincipal | null>;
  /** Injectable client for tests; built from env when omitted. */
  client?: ResourceHubClient;
  env?: NodeJS.ProcessEnv;
}

export function createTeamDesignSystemShareService(
  options: CreateTeamDesignSystemShareOptions,
): TeamDesignSystemShareService {
  const env = options.env ?? process.env;
  const client =
    options.client ??
    (env.OD_RESOURCE_HUB_URL?.trim()
      ? createResourceHubClient({ config: readResourceHubConfig(env) })
      : null);
  // Ids shared this session. The published `design_system` resources are the
  // durable record on the hub; this is the fast local view the team collection
  // reads until a hub listing query lands.
  const shared = new Set<string>();

  if (!client) {
    return {
      share: async () => null,
      sharedIds: () => [],
      isShared: () => false,
      configured: false,
    };
  }

  const adapter = createResourceHubPublishAdapter({
    client,
    getPrincipal: options.getPrincipal,
    resolveProjectDir: options.resolveDesignSystemDir,
    // Distinct, colon-free id namespace on the shared hub. The design-system id
    // the caller uses (e.g. `user:palette-x`) is sanitized to path-safe chars —
    // the hub routes the resource id as a path param, so a colon would 404.
    resourceIdFor: (id) => `ds-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
    kind: DESIGN_SYSTEM_KIND,
  });

  return {
    async share(designSystemId) {
      const result = await adapter.publish({ projectId: designSystemId, reason: 'share' });
      if (result) shared.add(designSystemId);
      return result;
    },
    sharedIds: () => [...shared],
    isShared: (designSystemId) => shared.has(designSystemId),
    configured: true,
  };
}
