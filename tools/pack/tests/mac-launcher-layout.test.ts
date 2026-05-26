import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ToolPackConfig } from "../src/config.js";
import {
  buildMacInstallMetadata,
  buildMacLauncherConfig,
  buildMacPayloadManifest,
  buildMacRuntimeConfig,
  resolveMacLauncherInstallLayout,
} from "../src/mac/launcher-layout.js";
import { resolveMacInstallIdentity } from "../src/mac/identity.js";
import { resolveMacPaths } from "../src/mac/paths.js";

function makeConfig(root: string, namespace = "release-beta"): ToolPackConfig {
  return {
    appVersion: "0.8.0-beta.2",
    containerized: false,
    electronBuilderCliPath: "/x/electron-builder/cli.js",
    electronDistPath: "/x/electron/dist",
    electronVersion: "41.3.0",
    macCompression: "normal",
    namespace,
    platform: "mac",
    portable: false,
    removeData: false,
    removeLogs: false,
    removeProductUserData: false,
    removeSidecars: false,
    roots: {
      cacheRoot: join(root, ".tmp", "tools-pack", "cache"),
      output: {
        appBuilderRoot: join(root, ".tmp", "tools-pack", "out", "mac", "namespaces", namespace, "builder"),
        namespaceRoot: join(root, ".tmp", "tools-pack", "out", "mac", "namespaces", namespace),
        platformRoot: join(root, ".tmp", "tools-pack", "out", "mac"),
        root: join(root, ".tmp", "tools-pack", "out"),
      },
      runtime: {
        namespaceBaseRoot: join(root, ".tmp", "tools-pack", "runtime", "mac", "namespaces"),
        namespaceRoot: join(root, ".tmp", "tools-pack", "runtime", "mac", "namespaces", namespace),
      },
      toolPackRoot: join(root, ".tmp", "tools-pack"),
    },
    signed: false,
    silent: true,
    to: "app",
    webOutputMode: "standalone",
    workspaceRoot: root,
  };
}

describe("mac launcher layout", () => {
  it("resolves an external launcher install root and versioned payload app paths", () => {
    const config = makeConfig("/work");
    const paths = resolveMacPaths(config);
    const identity = resolveMacInstallIdentity(config);
    const layout = resolveMacLauncherInstallLayout(config, paths, "0.8.0-beta.2");

    expect(identity).toMatchObject({
      executableName: "Open Design Beta",
      publicAppBundleName: "Open Design Beta.app",
    });
    expect(layout.root).toBe(join(config.roots.runtime.namespaceRoot, "launcher"));
    expect(layout.publicAppPath).toBe(paths.installedAppPath);
    expect(layout.installMetadataPath).toBe(join(layout.root, "install.json"));
    expect(layout.launcherConfigPath).toBe(join(layout.root, "launcher.json"));
    expect(layout.runtimeConfigPath).toBe(join(layout.root, "runtime.json"));
    expect(layout.cleanupMarkerPath).toBe(join(layout.root, "state", "cleanup.json"));
    expect(layout.lockPath).toBe(join(layout.root, "state", "lock"));
    expect(layout.versionRoot).toBe(join(layout.root, "versions", "0.8.0-beta.2"));
    expect(layout.payloadRoot).toBe(join(layout.versionRoot, "payload"));
    expect(layout.payloadAppPath).toBe(join(layout.payloadRoot, "Open Design Beta.app"));
    expect(layout.payloadExecutablePath).toBe(
      join(layout.payloadAppPath, "Contents", "MacOS", "Open Design Beta"),
    );
    expect(layout.payloadExecutableRelativePath).toBe(
      "payload/Open Design Beta.app/Contents/MacOS/Open Design Beta",
    );
    expect(layout.payloadCwdRelativePath).toBe("payload/Open Design Beta.app");
  });

  it("builds launcher and runtime descriptors for a full payload app bundle", () => {
    const config = makeConfig("/work");
    const paths = resolveMacPaths(config);
    const layout = resolveMacLauncherInstallLayout(config, paths, "0.8.0-beta.2");

    expect(buildMacLauncherConfig(layout)).toEqual({
      attemptPath: "state/attempt.json",
      runtimePath: "runtime.json",
      schemaVersion: 1,
    });
    expect(buildMacRuntimeConfig(config, layout, "0.8.0-beta.2")).toEqual({
      active: {
        apps: {},
        entry: {
          args: [],
          cwd: "payload/Open Design Beta.app",
          env: {},
          executable: "payload/Open Design Beta.app/Contents/MacOS/Open Design Beta",
        },
        root: "versions/0.8.0-beta.2",
        version: "0.8.0-beta.2",
      },
      generation: 0,
      lastSuccessful: {
        apps: {},
        entry: {
          args: [],
          cwd: "payload/Open Design Beta.app",
          env: {},
          executable: "payload/Open Design Beta.app/Contents/MacOS/Open Design Beta",
        },
        root: "versions/0.8.0-beta.2",
        version: "0.8.0-beta.2",
      },
      namespace: "release-beta",
      namespaceRoot: ".",
      schemaVersion: 1,
    });
  });

  it("uses mac-specific install metadata without Windows helper assumptions", () => {
    const config = makeConfig("/work");
    const paths = resolveMacPaths(config);
    const layout = resolveMacLauncherInstallLayout(config, paths, "0.8.0-beta.2");

    expect(buildMacInstallMetadata(config, layout, "0.8.0-beta.2")).toEqual({
      appBundleName: "Open Design Beta.app",
      currentVersion: "0.8.0-beta.2",
      displayName: "Open Design Beta",
      executableName: "Open Design Beta",
      launcher: {
        appBundleName: "Open Design Beta.app",
        executableName: "Open Design Beta",
        rootDiscovery: "external",
      },
      namespace: "release-beta",
      payload: {
        appBundleName: "Open Design Beta.app",
        executable: "Contents/MacOS/Open Design Beta",
      },
      platform: "darwin",
      runtimePath: "runtime.json",
      schemaVersion: 1,
      versionsRoot: "versions",
    });
    expect(JSON.stringify(buildMacInstallMetadata(config, layout, "0.8.0-beta.2"))).not.toContain("7z");
    expect(JSON.stringify(buildMacInstallMetadata(config, layout, "0.8.0-beta.2"))).not.toContain(".exe");
  });

  it("describes update payloads as version-root archives containing a payload app", () => {
    const config = makeConfig("/work");
    const paths = resolveMacPaths(config);
    const layout = resolveMacLauncherInstallLayout(config, paths, "0.8.0-beta.2");

    expect(buildMacPayloadManifest(layout, "0.8.0-beta.2")).toEqual({
      appBundleName: "Open Design Beta.app",
      entry: {
        cwd: "payload/Open Design Beta.app",
        executable: "payload/Open Design Beta.app/Contents/MacOS/Open Design Beta",
      },
      payloadRoot: "payload",
      platform: "darwin",
      schemaVersion: 1,
      version: "0.8.0-beta.2",
    });
  });

  it("rejects unsafe packaged version path segments", () => {
    const config = makeConfig("/work");
    const paths = resolveMacPaths(config);

    expect(() => resolveMacLauncherInstallLayout(config, paths, "0.8.0-beta.2/escaped")).toThrow(
      /safe path segment/,
    );
    expect(() => resolveMacLauncherInstallLayout(config, paths, " 0.8.0-beta.2")).toThrow(
      /safe path segment/,
    );
    expect(() => resolveMacLauncherInstallLayout(config, paths, "0.8.0-beta.2:ads")).toThrow(
      /safe path segment/,
    );
    expect(() => resolveMacLauncherInstallLayout(config, paths, "0.8.0-beta.2.")).toThrow(
      /safe path segment/,
    );
    expect(() => resolveMacLauncherInstallLayout(config, paths, "..")).toThrow(/safe path segment/);
  });
});
