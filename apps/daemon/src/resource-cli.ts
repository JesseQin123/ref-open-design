import {
  ResourceHubError,
  createResourceHubClient,
  readResourceHubPrincipal,
} from './integrations/resource-hub.js';
import { materializeRef, packTree, pushTree } from './resource-drive.js';

// `od resource …` — neutral cloud-drive CLI over the resource hub. It moves
// directory trees to/from the hub (put/get) and lists team resources; it is
// kind-agnostic. Feature-specific sharing ("share a design system") belongs to
// a consumer layer built on top, not here.

const USAGE = `Usage:
  od resource list                              List team resources
  od resource put <dir> --kind <kind> [--resource <id>] [--ref <name>]
                                                Upload a directory tree as a new version
  od resource get <resource-id> <dest-dir> [--ref <name>]
                                                Materialize a version's tree locally

Environment (dev/local, provisional until link B lands the member table):
  OD_RESOURCE_HUB_URL / OD_RESOURCE_HUB_TOKEN
  OD_WORKSPACE_MEMBER_ID / OD_WORKSPACE_TEAM_ID / OD_WORKSPACE_ROLE
`;

function printUsage(): void {
  console.log(USAGE);
}

function parseFlags(args: string[]): {
  positionals: string[];
  flags: Map<string, string>;
} {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        index += 1;
      } else {
        flags.set(key, 'true');
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function requirePrincipalOrExit() {
  const principal = readResourceHubPrincipal();
  if (!principal) {
    console.error(
      'workspace principal unavailable; set OD_WORKSPACE_MEMBER_ID and OD_WORKSPACE_TEAM_ID',
    );
    process.exitCode = 1;
    return null;
  }
  return principal;
}

function reportError(error: unknown): void {
  if (error instanceof ResourceHubError) {
    console.error(`resource hub error (${error.status} ${error.code})`);
  } else if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error('resource hub operation failed');
  }
  process.exitCode = 1;
}

async function runList(): Promise<void> {
  const principal = requirePrincipalOrExit();
  if (!principal) return;
  try {
    const resources = await createResourceHubClient().listResources(principal);
    if (resources.length === 0) {
      console.log('no team resources');
      return;
    }
    for (const resource of resources) {
      console.log(`${resource.kind}\t${resource.id}\t${resource.ownerMemberId}`);
    }
  } catch (error) {
    reportError(error);
  }
}

async function runPut(args: string[]): Promise<void> {
  const principal = requirePrincipalOrExit();
  if (!principal) return;
  const { positionals, flags } = parseFlags(args);
  const dir = positionals[0];
  const kind = flags.get('kind');
  if (!dir || !kind) {
    console.error(
      'usage: od resource put <dir> --kind <kind> [--resource <id>] [--ref <name>]',
    );
    process.exitCode = 1;
    return;
  }
  try {
    const client = createResourceHubClient();
    const resourceId = flags.get('resource');
    const resource = await client.createResource(principal, {
      kind,
      ...(resourceId ? { resourceId } : {}),
    });
    const packed = await packTree(dir);
    const version = await pushTree(client, principal, resource.id, packed, {
      ref: flags.get('ref') ?? 'latest',
    });
    console.log(
      `pushed ${packed.blobs.size} blob(s) -> resource ${resource.id} version ${version.version} (${version.id})`,
    );
  } catch (error) {
    reportError(error);
  }
}

async function runGet(args: string[]): Promise<void> {
  const principal = requirePrincipalOrExit();
  if (!principal) return;
  const { positionals, flags } = parseFlags(args);
  const resourceId = positionals[0];
  const dest = positionals[1];
  if (!resourceId || !dest) {
    console.error(
      'usage: od resource get <resource-id> <dest-dir> [--ref <name>]',
    );
    process.exitCode = 1;
    return;
  }
  const ref = flags.get('ref') ?? 'latest';
  try {
    await materializeRef(
      createResourceHubClient(),
      principal,
      resourceId,
      ref,
      dest,
    );
    console.log(`materialized resource ${resourceId} (ref ${ref}) -> ${dest}`);
  } catch (error) {
    reportError(error);
  }
}

export async function runResource(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'list':
      await runList();
      return;
    case 'put':
      await runPut(rest);
      return;
    case 'get':
      await runGet(rest);
      return;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      return;
    default:
      console.error(`unknown subcommand: od resource ${sub}`);
      printUsage();
      process.exitCode = 1;
  }
}
