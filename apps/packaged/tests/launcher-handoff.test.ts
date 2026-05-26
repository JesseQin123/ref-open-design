import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PACKAGED_LAUNCHER_ROOT_ENV,
  resolvePackagedLauncherHandoff,
  spawnPackagedLauncherHandoff,
} from "../src/launcher-handoff.js";
import { PACKAGED_CONFIG_PATH_ENV } from "../src/config.js";

function macRuntimeConfigJson(namespace: string, version = "0.8.0-beta.2"): string {
  return JSON.stringify({
    active: {
      apps: {},
      entry: {
        args: [],
        cwd: "payload/Open Design Beta.app",
        env: {},
        executable: "payload/Open Design Beta.app/Contents/MacOS/Open Design Beta",
      },
      root: `versions/${version}`,
      version,
    },
    generation: 1,
    lastSuccessful: {
      apps: {},
      entry: {
        args: [],
        cwd: "payload/Open Design Beta.app",
        env: {},
        executable: "payload/Open Design Beta.app/Contents/MacOS/Open Design Beta",
      },
      root: `versions/${version}`,
      version,
    },
    namespace,
    namespaceRoot: ".",
    schemaVersion: 1,
  });
}

function macInstallFiles(installRoot: string, namespace = "release-beta", version = "0.8.0-beta.2"): Map<string, string> {
  const executablePath = posix.join(
    installRoot,
    "versions",
    version,
    "payload",
    "Open Design Beta.app",
    "Contents",
    "MacOS",
    "Open Design Beta",
  );
  return new Map([
    [posix.join(installRoot, "install.json"), JSON.stringify({
      appBundleName: "Open Design Beta.app",
      currentVersion: version,
      displayName: "Open Design Beta",
      executableName: "Open Design Beta",
      launcher: {
        appBundleName: "Open Design Beta.app",
        executableName: "Open Design Beta",
        rootDiscovery: "external",
      },
      namespace,
      payload: {
        appBundleName: "Open Design Beta.app",
        executable: "Contents/MacOS/Open Design Beta",
      },
      platform: "darwin",
      runtimePath: "runtime.json",
      schemaVersion: 1,
      versionsRoot: "versions",
    })],
    [posix.join(installRoot, "launcher.json"), JSON.stringify({
      attemptPath: "state/attempt.json",
      runtimePath: "runtime.json",
      schemaVersion: 1,
    })],
    [posix.join(installRoot, "runtime.json"), macRuntimeConfigJson(namespace, version)],
    [executablePath, ""],
  ]);
}

describe("packaged launcher handoff", () => {
  it("redirects a public mac app launch to the external launcher payload target", () => {
    const namespaceRoot = "/Users/ada/Library/Application Support/Open Design Beta/namespaces/release-beta";
    const launcherRoot = posix.join(namespaceRoot, "launcher");
    const files = macInstallFiles(launcherRoot);

    const handoff = resolvePackagedLauncherHandoff({
      argv: [
        "/Applications/Open Design Beta.app/Contents/MacOS/Open Design Beta",
        "--od-stamp-app",
        "desktop",
      ],
      currentExecutablePath: "/Applications/Open Design Beta.app/Contents/MacOS/Open Design Beta",
      env: {
        [PACKAGED_CONFIG_PATH_ENV]: "/tmp/public-app-launch-config.json",
        OD_UPDATE_ENABLED: "1",
      },
      namespace: "release-beta",
      paths: { namespaceRoot },
    }, {
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
    });

    expect(handoff).toMatchObject({
      args: ["--od-stamp-app", "desktop"],
      attempt: {
        generation: 1,
        markerPath: posix.join(launcherRoot, "state", "attempt.json"),
        version: "0.8.0-beta.2",
      },
      cwd: posix.join(launcherRoot, "versions", "0.8.0-beta.2", "payload", "Open Design Beta.app"),
      executablePath: posix.join(launcherRoot, "versions", "0.8.0-beta.2", "payload", "Open Design Beta.app", "Contents", "MacOS", "Open Design Beta"),
      launcherRoot,
    });
    expect(handoff?.env[PACKAGED_LAUNCHER_ROOT_ENV]).toBe(launcherRoot);
    expect(handoff?.env[PACKAGED_CONFIG_PATH_ENV]).toBeUndefined();
    expect(handoff?.env.OD_UPDATE_ENABLED).toBe("1");
  });

  it("does not redirect when already running inside the selected payload app", () => {
    const namespaceRoot = "/Users/ada/Library/Application Support/Open Design Beta/namespaces/release-beta";
    const launcherRoot = posix.join(namespaceRoot, "launcher");
    const executablePath = posix.join(launcherRoot, "versions", "0.8.0-beta.2", "payload", "Open Design Beta.app", "Contents", "MacOS", "Open Design Beta");
    const files = macInstallFiles(launcherRoot);

    expect(resolvePackagedLauncherHandoff({
      argv: [executablePath],
      currentExecutablePath: executablePath,
      env: {},
      namespace: "release-beta",
      paths: { namespaceRoot },
    }, {
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
    })).toBeNull();
  });

  it("does not redirect an active payload back to lastSuccessful while its attempt is pending", () => {
    const namespace = "release-beta";
    const namespaceRoot = "/Users/ada/Library/Application Support/Open Design Beta/namespaces/release-beta";
    const launcherRoot = posix.join(namespaceRoot, "launcher");
    const activeVersion = "0.8.0-beta.3";
    const readyVersion = "0.8.0-beta.2";
    const executablePath = posix.join(
      launcherRoot,
      "versions",
      activeVersion,
      "payload",
      "Open Design Beta.app",
      "Contents",
      "MacOS",
      "Open Design Beta",
    );
    const readyExecutablePath = posix.join(
      launcherRoot,
      "versions",
      readyVersion,
      "payload",
      "Open Design Beta.app",
      "Contents",
      "MacOS",
      "Open Design Beta",
    );
    const files = macInstallFiles(launcherRoot, namespace, activeVersion);
    files.set(posix.join(launcherRoot, "runtime.json"), JSON.stringify({
      active: {
        apps: {},
        entry: {
          args: [],
          cwd: "payload/Open Design Beta.app",
          env: {},
          executable: "payload/Open Design Beta.app/Contents/MacOS/Open Design Beta",
        },
        root: `versions/${activeVersion}`,
        version: activeVersion,
      },
      generation: 7,
      lastSuccessful: {
        apps: {},
        entry: {
          args: [],
          cwd: "payload/Open Design Beta.app",
          env: {},
          executable: "payload/Open Design Beta.app/Contents/MacOS/Open Design Beta",
        },
        root: `versions/${readyVersion}`,
        version: readyVersion,
      },
      namespace,
      namespaceRoot: ".",
      schemaVersion: 1,
    }));
    files.set(posix.join(launcherRoot, "state", "attempt.json"), JSON.stringify({
      generation: 7,
      schemaVersion: 1,
      version: activeVersion,
    }));
    files.set(readyExecutablePath, "");

    expect(resolvePackagedLauncherHandoff({
      argv: [executablePath],
      currentExecutablePath: executablePath,
      env: {},
      namespace,
      paths: { namespaceRoot },
    }, {
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
    })).toBeNull();
  });

  it("supports an explicit launcher root override for future native shims", () => {
    const namespaceRoot = "/ignored/namespaces/release-beta";
    const launcherRoot = "/Users/ada/Library/Application Support/Open Design Beta/custom-launcher";
    const files = macInstallFiles(launcherRoot);

    expect(resolvePackagedLauncherHandoff({
      argv: ["/Applications/Open Design Beta.app/Contents/MacOS/Open Design Beta"],
      currentExecutablePath: "/Applications/Open Design Beta.app/Contents/MacOS/Open Design Beta",
      env: { [PACKAGED_LAUNCHER_ROOT_ENV]: launcherRoot },
      namespace: "release-beta",
      paths: { namespaceRoot },
    }, {
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
    })?.launcherRoot).toBe(launcherRoot);
  });

  it("spawns the selected payload detached", () => {
    const spawnProcess = vi.fn(() => ({ unref: vi.fn() }));
    const handoff = {
      args: ["--flag"],
      cwd: "/payload/Open Design Beta.app",
      env: { OD_PACKAGED_LAUNCHER_ROOT: "/launcher" },
      executablePath: "/payload/Open Design Beta.app/Contents/MacOS/Open Design Beta",
      launcherRoot: "/launcher",
    };

    spawnPackagedLauncherHandoff(handoff, spawnProcess, { platform: "win32" });

    expect(spawnProcess).toHaveBeenCalledWith(handoff.executablePath, ["--flag"], {
      cwd: handoff.cwd,
      detached: true,
      env: handoff.env,
      stdio: "ignore",
    });
    expect(spawnProcess.mock.results[0]?.value.unref).toHaveBeenCalled();
  });

  it("writes the active runtime attempt marker before spawning", () => {
    const root = join(tmpdir(), `od-launcher-handoff-${process.pid}-${Date.now()}`);
    const markerPath = join(root, "state", "attempt.json");
    const spawnProcess = vi.fn(() => ({ unref: vi.fn() }));
    const handoff = {
      args: ["--flag"],
      attempt: {
        generation: 3,
        markerPath,
        version: "0.8.1-beta.903",
      },
      cwd: "/payload/Open Design Beta.app",
      env: { OD_PACKAGED_LAUNCHER_ROOT: "/launcher" },
      executablePath: "/payload/Open Design Beta.app/Contents/MacOS/Open Design Beta",
      launcherRoot: "/launcher",
    };

    try {
      spawnPackagedLauncherHandoff(handoff, spawnProcess, { platform: "win32" });

      expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual({
        generation: 3,
        schemaVersion: 1,
        version: "0.8.1-beta.903",
      });
      expect(spawnProcess).toHaveBeenCalled();
    } finally {
      if (existsSync(root)) rmSync(root, { force: true, recursive: true });
    }
  });

  it("defers mac payload spawn until the public app process exits", () => {
    const spawnProcess = vi.fn(() => ({ unref: vi.fn() }));
    const handoff = {
      args: ["--flag", "value with spaces"],
      cwd: "/payload/Open Design Beta.app",
      env: { OD_PACKAGED_LAUNCHER_ROOT: "/launcher" },
      executablePath: "/payload/Open Design Beta.app/Contents/MacOS/Open Design Beta",
      launcherRoot: "/launcher",
    };

    spawnPackagedLauncherHandoff(handoff, spawnProcess, { parentPid: 12345, platform: "darwin" });

    expect(spawnProcess).toHaveBeenCalledWith("/bin/sh", [
      "-c",
      expect.stringContaining("while kill -0 12345"),
      "open-design-launcher-handoff",
      handoff.executablePath,
      "--flag",
      "value with spaces",
    ], {
      cwd: handoff.cwd,
      detached: true,
      env: handoff.env,
      stdio: "ignore",
    });
    expect(spawnProcess.mock.results[0]?.value.unref).toHaveBeenCalled();
  });
});
