import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { PackagedNamespacePaths } from "./paths.js";
import { PACKAGED_CONFIG_PATH_ENV } from "./config.js";
import {
  resolvePackagedLauncherInstallContext,
  resolvePackagedLauncherRuntimeTarget,
  shouldRedirectToPackagedLauncherTarget,
  type PackagedLauncherInstallContextOptions,
} from "./launcher-install.js";

export const PACKAGED_LAUNCHER_ROOT_ENV = "OD_PACKAGED_LAUNCHER_ROOT";

export type PackagedLauncherHandoff = {
  args: string[];
  attempt?: {
    generation: number;
    markerPath: string;
    version: string;
  };
  cwd: string;
  env: NodeJS.ProcessEnv;
  executablePath: string;
  launcherRoot: string;
};

export type PackagedLauncherHandoffInput = {
  argv: readonly string[];
  currentExecutablePath: string;
  env: NodeJS.ProcessEnv;
  namespace: string;
  paths: Pick<PackagedNamespacePaths, "namespaceRoot">;
};

type SpawnLauncherProcess = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    detached: true;
    env: NodeJS.ProcessEnv;
    stdio: "ignore";
  },
) => { unref(): void };

type SpawnPackagedLauncherHandoffOptions = {
  parentPid?: number;
  platform?: NodeJS.Platform;
};

export function resolvePackagedLauncherRoot(input: Pick<PackagedLauncherHandoffInput, "env" | "paths">): string {
  const override = input.env[PACKAGED_LAUNCHER_ROOT_ENV]?.trim();
  return override == null || override.length === 0 ? join(input.paths.namespaceRoot, "launcher") : override;
}

export function resolvePackagedLauncherHandoff(
  input: PackagedLauncherHandoffInput,
  options: PackagedLauncherInstallContextOptions = {},
): PackagedLauncherHandoff | null {
  const launcherRoot = resolvePackagedLauncherRoot(input);
  const currentContext = resolvePackagedLauncherInstallContext(input.currentExecutablePath, {
    ...options,
    namespace: input.namespace,
    requireInstallRootMarkers: true,
  });
  if (currentContext?.installRoot === launcherRoot) return null;
  const target = resolvePackagedLauncherRuntimeTarget(launcherRoot, {
    ...options,
    namespace: input.namespace,
    requireInstallRootMarkers: true,
  });
  if (target == null || !shouldRedirectToPackagedLauncherTarget(input.currentExecutablePath, target)) return null;
  const env = {
    ...input.env,
    [PACKAGED_LAUNCHER_ROOT_ENV]: launcherRoot,
  };
  Reflect.deleteProperty(env, PACKAGED_CONFIG_PATH_ENV);
  return {
    args: [...input.argv.slice(1)],
    ...(target.selection === "active" && target.attemptMarkerPath != null
      ? {
          attempt: {
            generation: target.generation,
            markerPath: target.attemptMarkerPath,
            version: target.version,
          },
        }
      : {}),
    cwd: target.cwd,
    env,
    executablePath: target.executablePath,
    launcherRoot,
  };
}

function writePackagedLauncherAttempt(handoff: PackagedLauncherHandoff): void {
  if (handoff.attempt == null) return;
  mkdirSync(dirname(handoff.attempt.markerPath), { recursive: true });
  writeFileSync(handoff.attempt.markerPath, `${JSON.stringify({
    generation: handoff.attempt.generation,
    schemaVersion: 1,
    version: handoff.attempt.version,
  })}\n`);
}

export function spawnPackagedLauncherHandoff(
  handoff: PackagedLauncherHandoff,
  spawnProcess: SpawnLauncherProcess = spawn,
  options: SpawnPackagedLauncherHandoffOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const parentPid = options.parentPid ?? process.pid;
  const command = platform === "darwin" ? "/bin/sh" : handoff.executablePath;
  const args = platform === "darwin"
    ? [
        "-c",
        `while kill -0 ${parentPid} 2>/dev/null; do sleep 0.05; done\nexec "$@"`,
        "open-design-launcher-handoff",
        handoff.executablePath,
        ...handoff.args,
      ]
    : handoff.args;
  // macOS can reject the payload as a second instance while the public .app
  // process with the same bundle id is still exiting.
  writePackagedLauncherAttempt(handoff);
  const child = spawnProcess(command, args, {
    cwd: handoff.cwd,
    detached: true,
    env: handoff.env,
    stdio: "ignore",
  });
  child.unref();
}
