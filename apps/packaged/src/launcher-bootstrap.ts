import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";

import type { PackagedNamespacePaths } from "./paths.js";
import { resolvePackagedLauncherRoot } from "./launcher-handoff.js";
import { resolvePackagedLauncherRuntimeTarget } from "./launcher-install.js";

const execFileAsync = promisify(execFile);
const PAYLOAD_DIR_NAME = "payload";
const VERSIONS_DIR_NAME = "versions";

export type PackagedMacLauncherBootstrapResult = {
  appBundleName: string;
  executableName: string;
  launcherRoot: string;
  payloadAppPath: string;
  runtimeConfigPath: string;
  seeded: boolean;
  version: string;
};

export type PackagedMacLauncherBootstrapInput = {
  appVersion: string | null;
  currentExecutablePath: string;
  env: NodeJS.ProcessEnv;
  namespace: string;
  paths: Pick<PackagedNamespacePaths, "namespaceRoot">;
};

type BootstrapFs = {
  copyAppBundle?: (source: string, destination: string) => Promise<void>;
  now?: () => Date;
  platform?: NodeJS.Platform;
};

function normalizeVersionSegment(value: string): string | null {
  const version = value.trim();
  if (version.length === 0) return null;
  if (
    version !== value ||
    /[<>:"/\\|?*\x00-\x1f\s]/.test(version) ||
    version === "." ||
    version === ".." ||
    version.endsWith(".")
  ) {
    return null;
  }
  return version;
}

function safeMacPathSegment(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed !== value || /[/\\\x00-\x1f]/.test(trimmed) || trimmed === "." || trimmed === "..") return null;
  return trimmed;
}

function resolveCurrentMacApp(input: Pick<PackagedMacLauncherBootstrapInput, "currentExecutablePath">): {
  appBundleName: string;
  appPath: string;
  executableName: string;
} | null {
  const executableName = safeMacPathSegment(posix.basename(input.currentExecutablePath));
  if (executableName == null) return null;
  const macOsRoot = posix.dirname(input.currentExecutablePath);
  if (posix.basename(macOsRoot) !== "MacOS") return null;
  const contentsRoot = posix.dirname(macOsRoot);
  if (posix.basename(contentsRoot) !== "Contents") return null;
  const appPath = posix.dirname(contentsRoot);
  const appBundleName = posix.basename(appPath);
  if (safeMacPathSegment(appBundleName) == null || !appBundleName.endsWith(".app")) return null;
  return { appBundleName, appPath, executableName };
}

function descriptorRelativePath(...segments: string[]): string {
  return segments.join("/");
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function copyMacAppBundle(source: string, destination: string): Promise<void> {
  await rm(destination, { force: true, recursive: true });
  await mkdir(dirname(destination), { recursive: true });
  await execFileAsync("/usr/bin/ditto", [source, destination]);
}

function buildInstallMetadata(input: {
  appBundleName: string;
  executableName: string;
  namespace: string;
  version: string;
}): Record<string, unknown> {
  return {
    appBundleName: input.appBundleName,
    currentVersion: input.version,
    displayName: input.executableName,
    executableName: input.executableName,
    launcher: {
      appBundleName: input.appBundleName,
      executableName: input.executableName,
      rootDiscovery: "external",
    },
    namespace: input.namespace,
    payload: {
      appBundleName: input.appBundleName,
      executable: descriptorRelativePath("Contents", "MacOS", input.executableName),
    },
    platform: "darwin",
    runtimePath: "runtime.json",
    schemaVersion: 1,
    versionsRoot: VERSIONS_DIR_NAME,
  };
}

function buildLauncherConfig(): Record<string, unknown> {
  return {
    attemptPath: "state/attempt.json",
    runtimePath: "runtime.json",
    schemaVersion: 1,
  };
}

function buildRuntimeConfig(input: {
  appBundleName: string;
  executableName: string;
  namespace: string;
  version: string;
}): Record<string, unknown> {
  const cwd = descriptorRelativePath(PAYLOAD_DIR_NAME, input.appBundleName);
  const executable = descriptorRelativePath(cwd, "Contents", "MacOS", input.executableName);
  const versionDescriptor = {
    apps: {},
    entry: {
      args: [],
      cwd,
      env: {},
      executable,
    },
    root: descriptorRelativePath(VERSIONS_DIR_NAME, input.version),
    version: input.version,
  };
  return {
    active: versionDescriptor,
    generation: 0,
    lastSuccessful: versionDescriptor,
    namespace: input.namespace,
    namespaceRoot: ".",
    schemaVersion: 1,
  };
}

function buildPayloadManifest(input: {
  appBundleName: string;
  executableName: string;
  version: string;
}): Record<string, unknown> {
  const cwd = descriptorRelativePath(PAYLOAD_DIR_NAME, input.appBundleName);
  return {
    appBundleName: input.appBundleName,
    entry: {
      cwd,
      executable: descriptorRelativePath(cwd, "Contents", "MacOS", input.executableName),
    },
    payloadRoot: PAYLOAD_DIR_NAME,
    platform: "darwin",
    schemaVersion: 1,
    version: input.version,
  };
}

export async function ensurePackagedMacLauncherBootstrap(
  input: PackagedMacLauncherBootstrapInput,
  options: BootstrapFs = {},
): Promise<PackagedMacLauncherBootstrapResult | null> {
  if ((options.platform ?? process.platform) !== "darwin") return null;
  if (input.appVersion == null) return null;
  const version = normalizeVersionSegment(input.appVersion);
  if (version == null) return null;
  const currentApp = resolveCurrentMacApp(input);
  if (currentApp == null) return null;

  const launcherRoot = resolvePackagedLauncherRoot(input);
  const existingTarget = resolvePackagedLauncherRuntimeTarget(launcherRoot, {
    namespace: input.namespace,
    requireInstallRootMarkers: true,
  });
  if (existingTarget != null) {
    return {
      appBundleName: currentApp.appBundleName,
      executableName: currentApp.executableName,
      launcherRoot,
      payloadAppPath: existingTarget.context.payloadAppPath ?? existingTarget.cwd,
      runtimeConfigPath: existingTarget.context.runtimeConfigPath,
      seeded: false,
      version: existingTarget.version,
    };
  }

  const versionRoot = join(launcherRoot, VERSIONS_DIR_NAME, version);
  const payloadRoot = join(versionRoot, PAYLOAD_DIR_NAME);
  const payloadAppPath = join(payloadRoot, currentApp.appBundleName);
  const runtimeConfigPath = join(launcherRoot, "runtime.json");

  await mkdir(join(launcherRoot, "state"), { recursive: true });
  await mkdir(payloadRoot, { recursive: true });
  await (options.copyAppBundle ?? copyMacAppBundle)(currentApp.appPath, payloadAppPath);
  await writeJson(join(launcherRoot, "install.json"), buildInstallMetadata({
    appBundleName: currentApp.appBundleName,
    executableName: currentApp.executableName,
    namespace: input.namespace,
    version,
  }));
  await writeJson(join(launcherRoot, "launcher.json"), buildLauncherConfig());
  await writeJson(runtimeConfigPath, buildRuntimeConfig({
    appBundleName: currentApp.appBundleName,
    executableName: currentApp.executableName,
    namespace: input.namespace,
    version,
  }));
  await writeJson(join(versionRoot, "manifest.json"), buildPayloadManifest({
    appBundleName: currentApp.appBundleName,
    executableName: currentApp.executableName,
    version,
  }));

  return {
    appBundleName: currentApp.appBundleName,
    executableName: currentApp.executableName,
    launcherRoot,
    payloadAppPath,
    runtimeConfigPath,
    seeded: true,
    version,
  };
}
