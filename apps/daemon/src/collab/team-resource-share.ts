// Team resource sharing. A member with publish rights promotes a personal
// resource — a design system, plugin, or skill — into the team scope: the
// resource's directory is packed and pushed to the resource hub under its kind,
// so teammates can pull it into their own workspace. This reuses the same
// content-addressed publish machinery as project sync — only the resource kind
// and id namespace differ — and degrades to a no-op when there is no team
// identity or the hub is not configured (the same identity gate as the rest of
// the collab surface).

import {
  createResourceHubClient,
  readResourceHubConfig,
  type ResourceHubClient,
  type ResourceHubPrincipal,
} from '../integrations/resource-hub.js';
import { createResourceHubPublishAdapter } from './resource-hub-publish-adapter.js';

export interface TeamResourceShareService {
  /** Share a resource to the team. Returns the published version, or null off-team. */
  share(resourceId: string): Promise<{ version: number } | null>;
  /** Ids of resources shared to the team in this session. */
  sharedIds(): string[];
  /** True once a resource has been shared to the team. */
  isShared(resourceId: string): boolean;
  /** Whether the hub is reachable (share is a no-op otherwise). */
  readonly configured: boolean;
}

export interface CreateTeamResourceShareOptions {
  /** Resource hub kind, e.g. `design_system` | `plugin` | `skill`. */
  kind: string;
  /** Colon-free id-namespace prefix distinguishing this kind on the shared hub. */
  idPrefix: string;
  /** Resolve a resource's source directory (what gets packed and pushed). May be
   *  async: the skill resolver awaits the skill index, and the publish adapter
   *  awaits this before packing. */
  resolveDir: (resourceId: string) => string | Promise<string>;
  /** Resolve the current principal (null = no team identity → share no-ops). */
  getPrincipal: () => ResourceHubPrincipal | null | Promise<ResourceHubPrincipal | null>;
  /** Injectable client for tests; built from env when omitted. */
  client?: ResourceHubClient;
  env?: NodeJS.ProcessEnv;
}

export function createTeamResourceShareService(
  options: CreateTeamResourceShareOptions,
): TeamResourceShareService {
  const env = options.env ?? process.env;
  const client =
    options.client ??
    (env.OD_RESOURCE_HUB_URL?.trim()
      ? createResourceHubClient({ config: readResourceHubConfig(env) })
      : null);
  // Ids shared this session. The published resources are the durable record on
  // the hub; this is the fast local view the team collection reads until a hub
  // listing query lands.
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
    resolveProjectDir: options.resolveDir,
    // Distinct, colon-free id namespace on the shared hub. The caller's id (e.g.
    // `user:palette-x`) is sanitized to path-safe chars — the hub routes the
    // resource id as a path param, so a colon would 404.
    resourceIdFor: (id) => `${options.idPrefix}-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
    kind: options.kind,
  });

  return {
    async share(resourceId) {
      const result = await adapter.publish({ projectId: resourceId, reason: 'share' });
      if (result) shared.add(resourceId);
      return result;
    },
    sharedIds: () => [...shared],
    isShared: (resourceId) => shared.has(resourceId),
    configured: true,
  };
}
