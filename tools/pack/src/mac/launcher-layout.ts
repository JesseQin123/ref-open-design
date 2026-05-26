import { join } from "node:path";

import {
  buildLauncherConfig,
  buildRuntimeConfig,
  type LauncherConfig,
  type RuntimeConfig,
} from "@open-design/launcher-proto";

import type { ToolPackConfig } from "../config.js";
import { resolveMacInstallIdentity } from "./identity.js";
import type { MacPaths } from "./types.js";

const PAYLOAD_DIR_NAME = "payload";
const VERSIONS_DIR_NAME = "versions";

export type MacLauncherInstallLayout = {
  appBundleName: string;
  attemptRelativePath: string;
  cleanupMarkerPath: string;
  executableName: string;
  installMetadataPath: string;
  launcherConfigPath: string;
  lockPath: string;
  payloadAppPath: string;
  payloadCwdRelativePath: string;
  payloadExecutablePath: string;
  payloadExecutableRelativePath: string;
  payloadManifestPath: string;
  payloadRoot: string;
  payloadRootRelativePath: string;
  publicAppPath: string;
  root: string;
  runtimeConfigPath: string;
  stateRoot: string;
  versionRoot: string;
  versionRootRelativePath: string;
  versionsRoot: string;
};

export type MacInstallMetadata = {
  appBundleName: string;
  currentVersion: string;
  displayName: string;
  executableName: string;
  launcher: {
    appBundleName: string;
    executableName: string;
    rootDiscovery: "external";
  };
  namespace: string;
  payload: {
    appBundleName: string;
    executable: string;
  };
  platform: "darwin";
  runtimePath: string;
  schemaVersion: 1;
  versionsRoot: string;
};

export type MacPayloadManifest = {
  appBundleName: string;
  entry: {
    cwd: string;
    executable: string;
  };
  payloadRoot: string;
  platform: "darwin";
  schemaVersion: 1;
  version: string;
};

function toManifestRelativePath(...segments: string[]): string {
  return segments.join("/");
}

function normalizeVersionSegment(value: string): string {
  const version = value.trim();
  if (version.length === 0) throw new Error("mac launcher packaged version must not be empty");
  if (
    version !== value ||
    /[<>:"/\\|?*\x00-\x1f\s]/.test(version) ||
    version === "." ||
    version === ".." ||
    version.endsWith(".")
  ) {
    throw new Error(`mac launcher packaged version must be a safe path segment: ${value}`);
  }
  return version;
}

export function resolveMacLauncherInstallLayout(
  config: Pick<ToolPackConfig, "namespace" | "roots" | "appVersion">,
  paths: Pick<MacPaths, "installedAppPath">,
  packagedVersion: string,
): MacLauncherInstallLayout {
  const version = normalizeVersionSegment(packagedVersion);
  const identity = resolveMacInstallIdentity(config);
  const root = join(config.roots.runtime.namespaceRoot, "launcher");
  const versionRootRelativePath = toManifestRelativePath(VERSIONS_DIR_NAME, version);
  const payloadRootRelativePath = toManifestRelativePath(versionRootRelativePath, PAYLOAD_DIR_NAME);
  const payloadCwdRelativePath = toManifestRelativePath(PAYLOAD_DIR_NAME, identity.publicAppBundleName);
  const payloadExecutableRelativePath = toManifestRelativePath(
    payloadCwdRelativePath,
    "Contents",
    "MacOS",
    identity.executableName,
  );
  const versionRoot = join(root, VERSIONS_DIR_NAME, version);
  const payloadRoot = join(versionRoot, PAYLOAD_DIR_NAME);
  const payloadAppPath = join(payloadRoot, identity.publicAppBundleName);

  return {
    appBundleName: identity.publicAppBundleName,
    attemptRelativePath: "state/attempt.json",
    cleanupMarkerPath: join(root, "state", "cleanup.json"),
    executableName: identity.executableName,
    installMetadataPath: join(root, "install.json"),
    launcherConfigPath: join(root, "launcher.json"),
    lockPath: join(root, "state", "lock"),
    payloadAppPath,
    payloadCwdRelativePath,
    payloadExecutablePath: join(payloadAppPath, "Contents", "MacOS", identity.executableName),
    payloadExecutableRelativePath,
    payloadManifestPath: join(versionRoot, "manifest.json"),
    payloadRoot,
    payloadRootRelativePath,
    publicAppPath: paths.installedAppPath,
    root,
    runtimeConfigPath: join(root, "runtime.json"),
    stateRoot: join(root, "state"),
    versionRoot,
    versionRootRelativePath,
    versionsRoot: join(root, VERSIONS_DIR_NAME),
  };
}

export function buildMacLauncherConfig(
  layout: Pick<MacLauncherInstallLayout, "attemptRelativePath">,
): LauncherConfig {
  return buildLauncherConfig({
    attemptPath: layout.attemptRelativePath,
    runtimePath: "runtime.json",
  });
}

export function buildMacRuntimeConfig(
  config: Pick<ToolPackConfig, "namespace">,
  layout: Pick<MacLauncherInstallLayout, "payloadCwdRelativePath" | "payloadExecutableRelativePath" | "versionRootRelativePath">,
  packagedVersion: string,
): RuntimeConfig {
  const versionName = normalizeVersionSegment(packagedVersion);
  const version = {
    apps: {},
    entry: {
      args: [],
      cwd: layout.payloadCwdRelativePath,
      env: {},
      executable: layout.payloadExecutableRelativePath,
    },
    root: layout.versionRootRelativePath,
    version: versionName,
  };
  return buildRuntimeConfig({
    active: version,
    generation: 0,
    lastSuccessful: version,
    namespace: config.namespace,
    namespaceRoot: ".",
  });
}

export function buildMacInstallMetadata(
  config: Pick<ToolPackConfig, "namespace">,
  layout: Pick<MacLauncherInstallLayout, "appBundleName" | "executableName">,
  packagedVersion: string,
): MacInstallMetadata {
  const version = normalizeVersionSegment(packagedVersion);
  return {
    appBundleName: layout.appBundleName,
    currentVersion: version,
    displayName: layout.executableName,
    executableName: layout.executableName,
    launcher: {
      appBundleName: layout.appBundleName,
      executableName: layout.executableName,
      rootDiscovery: "external",
    },
    namespace: config.namespace,
    payload: {
      appBundleName: layout.appBundleName,
      executable: toManifestRelativePath("Contents", "MacOS", layout.executableName),
    },
    platform: "darwin",
    runtimePath: "runtime.json",
    schemaVersion: 1,
    versionsRoot: VERSIONS_DIR_NAME,
  };
}

export function buildMacPayloadManifest(
  layout: Pick<MacLauncherInstallLayout, "appBundleName" | "payloadCwdRelativePath" | "payloadExecutableRelativePath">,
  packagedVersion: string,
): MacPayloadManifest {
  const version = normalizeVersionSegment(packagedVersion);
  return {
    appBundleName: layout.appBundleName,
    entry: {
      cwd: layout.payloadCwdRelativePath,
      executable: layout.payloadExecutableRelativePath,
    },
    payloadRoot: PAYLOAD_DIR_NAME,
    platform: "darwin",
    schemaVersion: 1,
    version,
  };
}
