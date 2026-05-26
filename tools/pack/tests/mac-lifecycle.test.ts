import { chmod, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ToolPackConfig } from "../src/config.js";
import { resolveMacLauncherInstallLayout } from "../src/mac/launcher-layout.js";
import { resolveMacPaths } from "../src/mac/paths.js";

const requestJsonControl = vi.fn(async (): Promise<{ pid?: number; state: string }> => ({ state: "running" }));
const createSidecarLaunchEnv = vi.fn(({ extraEnv }: { base: string; extraEnv: NodeJS.ProcessEnv }) => extraEnv);
const endpoint = "tcp://127.0.0.1:17401";
let nextSpawnExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
const spawnLoggedProcess = vi.fn(async ({ env }: { cwd?: string; env: NodeJS.ProcessEnv }) => {
  const child = Object.assign(new EventEmitter(), {
    env,
    pid: 1234,
    unref: vi.fn(),
  }) as unknown as ChildProcess & { env: NodeJS.ProcessEnv };
  const exit = nextSpawnExit;
  if (exit != null) {
    setTimeout(() => child.emit("exit", exit.code, exit.signal), 0);
  }
  return child;
});

vi.mock("@open-design/sidecar", () => ({
  allocatePort: vi.fn(async () => ({ port: 17401, source: "dynamic" })),
  createControlEndpoint: vi.fn(() => endpoint),
  createSidecarLaunchEnv,
  readAppControlEndpoint: vi.fn(async () => endpoint),
  requestJsonControl,
  writeAppControlEndpoint: vi.fn(async () => undefined),
}));

vi.mock("@open-design/platform", () => ({
  collectProcessTreePids: vi.fn(),
  createProcessStampArgs: vi.fn(() => []),
  isProcessAlive: vi.fn(() => true),
  listProcessSnapshots: vi.fn(async () => []),
  matchesStampedProcess: vi.fn(() => false),
  readLogTail: vi.fn(async () => []),
  spawnLoggedProcess,
  stopProcesses: vi.fn(async () => []),
}));

const { materializeMacLauncherInstall, startPackedMacApp } = await import("../src/mac/lifecycle.js");

function makeConfig(root: string, overrides: Partial<ToolPackConfig> = {}): ToolPackConfig {
  return {
    containerized: false,
    electronBuilderCliPath: "/x/electron-builder/cli.js",
    electronDistPath: "/x/electron/dist",
    electronVersion: "41.3.0",
    macCompression: "normal",
    namespace: "local-test",
    appVersion: "1.2.3",
    platform: "mac",
    portable: true,
    removeData: false,
    removeLogs: false,
    removeProductUserData: false,
    removeSidecars: false,
    roots: {
      output: {
        appBuilderRoot: join(root, ".tmp", "tools-pack", "out", "mac", "namespaces", "local-test", "builder"),
        namespaceRoot: join(root, ".tmp", "tools-pack", "out", "mac", "namespaces", "local-test"),
        platformRoot: join(root, ".tmp", "tools-pack", "out", "mac"),
        root: join(root, ".tmp", "tools-pack", "out"),
      },
      runtime: {
        namespaceBaseRoot: join(root, ".tmp", "tools-pack", "runtime", "mac", "namespaces"),
        namespaceRoot: join(root, ".tmp", "tools-pack", "runtime", "mac", "namespaces", "local-test"),
      },
      cacheRoot: join(root, ".tmp", "tools-pack", "cache"),
      toolPackRoot: join(root, ".tmp", "tools-pack"),
    },
    silent: true,
    signed: false,
    to: "app",
    webOutputMode: "standalone",
    workspaceRoot: root,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  nextSpawnExit = null;
  requestJsonControl.mockResolvedValue({ state: "running" });
});

describe("materializeMacLauncherInstall", () => {
  it("copies a full app payload into the external launcher version store", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-tools-pack-mac-lifecycle-"));
    try {
      const config = makeConfig(root, { namespace: "release-beta" });
      const paths = resolveMacPaths(config);
      const sourceAppPath = join(root, "Open Design Beta.app");
      const executablePath = join(sourceAppPath, "Contents", "MacOS", "Open Design Beta");

      await mkdir(join(sourceAppPath, "Contents", "MacOS"), { recursive: true });
      await writeFile(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(executablePath, 0o755);

      const layout = await materializeMacLauncherInstall(config, sourceAppPath);

      expect(layout.root).toBe(join(config.roots.runtime.namespaceRoot, "launcher"));
      await expect(readFile(join(layout.payloadAppPath, "Contents", "MacOS", "Open Design Beta"), "utf8")).resolves.toContain("exit 0");
      await expect(readFile(layout.installMetadataPath, "utf8")).resolves.toContain('"platform": "darwin"');
      await expect(readFile(layout.installMetadataPath, "utf8")).resolves.not.toContain("7z");
      await expect(readFile(layout.runtimeConfigPath, "utf8")).resolves.toContain(
        '"executable": "payload/Open Design Beta.app/Contents/MacOS/Open Design Beta"',
      );
      expect(layout.publicAppPath).toBe(paths.installedAppPath);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("preserves framework-relative symlinks when materializing an app payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-tools-pack-mac-lifecycle-"));
    try {
      const config = makeConfig(root);
      const sourceAppPath = join(root, "Open Design.app");
      const executablePath = join(sourceAppPath, "Contents", "MacOS", "Open Design");
      const frameworkRoot = join(sourceAppPath, "Contents", "Frameworks", "Test.framework");

      await mkdir(join(sourceAppPath, "Contents", "MacOS"), { recursive: true });
      await writeFile(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(executablePath, 0o755);
      await mkdir(join(frameworkRoot, "Versions", "A", "Resources"), { recursive: true });
      await writeFile(join(frameworkRoot, "Versions", "A", "Resources", "Info.plist"), "plist", "utf8");
      await symlink("A", join(frameworkRoot, "Versions", "Current"));
      await symlink("Versions/Current/Resources", join(frameworkRoot, "Resources"));

      const layout = await materializeMacLauncherInstall(config, sourceAppPath);

      await expect(readlink(join(layout.payloadAppPath, "Contents", "Frameworks", "Test.framework", "Resources"))).resolves.toBe(
        "Versions/Current/Resources",
      );
      await expect(readlink(join(layout.payloadAppPath, "Contents", "Frameworks", "Test.framework", "Versions", "Current"))).resolves.toBe(
        "A",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("startPackedMacApp", () => {
  it("prefers the stable installed app as the launcher entry when runtime descriptors are present", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-tools-pack-mac-lifecycle-"));
    try {
      const config = makeConfig(root, { namespace: "release-beta" });
      const paths = resolveMacPaths(config);
      const identityExecutablePath = join(paths.installedAppPath, "Contents", "MacOS", "Open Design Beta");
      const layout = resolveMacLauncherInstallLayout(config, paths, "1.2.3");

      await mkdir(join(paths.installedAppPath, "Contents", "MacOS"), { recursive: true });
      await writeFile(identityExecutablePath, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(identityExecutablePath, 0o755);
      await materializeMacLauncherInstall(config, paths.installedAppPath);

      const result = await startPackedMacApp(config);
      const launchEnv = spawnLoggedProcess.mock.calls[0]?.[0]?.env as NodeJS.ProcessEnv | undefined;

      expect(result.source).toBe("launcher-entry");
      expect(result.appPath).toBe(paths.installedAppPath);
      expect(result.executablePath).toBe(identityExecutablePath);
      expect(spawnLoggedProcess.mock.calls[0]?.[0]?.cwd).toBe(paths.installedAppPath);
      expect(launchEnv?.OD_PACKAGED_CONFIG_PATH).toBe(join(config.roots.runtime.namespaceRoot, "runtime", "open-design-config.json"));
      expect(launchEnv?.OD_PACKAGED_LAUNCHER_ROOT).toBe(layout.root);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("allows the public launcher entry to exit cleanly after handing off to the payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-tools-pack-mac-lifecycle-"));
    try {
      const config = makeConfig(root, { namespace: "release-beta" });
      const paths = resolveMacPaths(config);
      const identityExecutablePath = join(paths.installedAppPath, "Contents", "MacOS", "Open Design Beta");

      await mkdir(join(paths.installedAppPath, "Contents", "MacOS"), { recursive: true });
      await writeFile(identityExecutablePath, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(identityExecutablePath, 0o755);
      await materializeMacLauncherInstall(config, paths.installedAppPath);

      nextSpawnExit = { code: 0, signal: null };
      requestJsonControl.mockResolvedValueOnce({ pid: 5678, state: "running" });

      const result = await startPackedMacApp(config);

      expect(result.source).toBe("launcher-entry");
      expect(result.pid).toBe(5678);
      expect(result.status?.state).toBe("running");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("writes a launch override when the bundled config is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-tools-pack-mac-lifecycle-"));
    try {
      const config = makeConfig(root);
      const paths = resolveMacPaths(config);
      const executablePath = join(paths.installedAppPath, "Contents", "MacOS", "Open Design");

      await mkdir(join(paths.installedAppPath, "Contents", "MacOS"), { recursive: true });
      await writeFile(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(executablePath, 0o755);

      const result = await startPackedMacApp(config);
      const launchConfigPath = join(config.roots.runtime.namespaceRoot, "runtime", "open-design-config.json");
      const launchEnv = spawnLoggedProcess.mock.calls[0]?.[0]?.env as NodeJS.ProcessEnv | undefined;

      expect(result.source).toBe("installed");
      expect(result.status?.state).toBe("running");
      expect(createSidecarLaunchEnv.mock.calls[0]?.[0]?.base).toBe(config.roots.runtime.namespaceBaseRoot);
      expect(launchEnv?.OD_PACKAGED_CONFIG_PATH).toBe(launchConfigPath);
      await expect(readFile(launchConfigPath, "utf8")).resolves.toContain(
        `"namespaceBaseRoot": ${JSON.stringify(config.roots.runtime.namespaceBaseRoot)}`,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("passes a launch override config path for portable mac starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-tools-pack-mac-lifecycle-"));
    try {
      const config = makeConfig(root);
      const paths = resolveMacPaths(config);
      const executablePath = join(paths.installedAppPath, "Contents", "MacOS", "Open Design");
      const bundledConfigPath = join(paths.installedAppPath, "Contents", "Resources", "open-design-config.json");

      await mkdir(join(paths.installedAppPath, "Contents", "MacOS"), { recursive: true });
      await mkdir(join(paths.installedAppPath, "Contents", "Resources"), { recursive: true });
      await writeFile(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(executablePath, 0o755);
      await writeFile(
        bundledConfigPath,
        `${JSON.stringify({
          appVersion: "1.2.3",
          daemonCliEntryRelative: "open-design/bin/od",
          namespace: config.namespace,
          nodeCommandRelative: "open-design/bin/node",
        }, null, 2)}\n`,
        "utf8",
      );

      const result = await startPackedMacApp(config);
      const launchConfigPath = join(config.roots.runtime.namespaceRoot, "runtime", "open-design-config.json");
      const launchEnv = spawnLoggedProcess.mock.calls[0]?.[0]?.env as NodeJS.ProcessEnv | undefined;

      expect(result.source).toBe("installed");
      expect(result.status?.state).toBe("running");
      expect(launchEnv?.OD_PACKAGED_CONFIG_PATH).toBe(launchConfigPath);
      await expect(readFile(launchConfigPath, "utf8")).resolves.toContain(
        `"namespaceBaseRoot": ${JSON.stringify(config.roots.runtime.namespaceBaseRoot)}`,
      );
      await expect(readFile(launchConfigPath, "utf8")).resolves.toContain('"appVersion": "1.2.3"');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uses the preview executable name for preview release namespaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-tools-pack-mac-lifecycle-"));
    try {
      const config = makeConfig(root, { namespace: "release-preview" });
      const paths = resolveMacPaths(config);
      const executablePath = join(paths.installedAppPath, "Contents", "MacOS", "Open Design Preview");

      await mkdir(join(paths.installedAppPath, "Contents", "MacOS"), { recursive: true });
      await writeFile(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(executablePath, 0o755);

      const result = await startPackedMacApp(config);

      expect(result.source).toBe("installed");
      expect(result.executablePath).toBe(executablePath);
      expect(result.status?.state).toBe("running");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
