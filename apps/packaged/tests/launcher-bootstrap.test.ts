import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ensurePackagedMacLauncherBootstrap } from "../src/launcher-bootstrap.js";
import { resolvePackagedLauncherHandoff } from "../src/launcher-handoff.js";

async function makeFakeMacApp(root: string, appBundleName = "Open Design Beta.app", executableName = "Open Design Beta"): Promise<string> {
  const appPath = join(root, appBundleName);
  const executablePath = join(appPath, "Contents", "MacOS", executableName);
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(executablePath, "#!/bin/sh\n", "utf8");
  return executablePath;
}

describe("packaged mac launcher bootstrap", () => {
  it("seeds an external launcher root from the public app on first launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-packaged-bootstrap-"));
    const publicExecutable = await makeFakeMacApp(join(root, "Applications"));
    const namespaceRoot = join(root, "Application Support", "Open Design Beta", "namespaces", "release-beta");
    const copied: Array<{ destination: string; source: string }> = [];

    const result = await ensurePackagedMacLauncherBootstrap({
      appVersion: "0.8.1-beta.7",
      currentExecutablePath: publicExecutable,
      env: {},
      namespace: "release-beta",
      paths: { namespaceRoot },
    }, {
      copyAppBundle: async (source, destination) => {
        copied.push({ destination, source });
        await makeFakeMacApp(join(destination, ".."), "Open Design Beta.app", "Open Design Beta");
      },
      platform: "darwin",
    });

    const launcherRoot = join(namespaceRoot, "launcher");
    const payloadExecutable = join(
      launcherRoot,
      "versions",
      "0.8.1-beta.7",
      "payload",
      "Open Design Beta.app",
      "Contents",
      "MacOS",
      "Open Design Beta",
    );
    expect(result).toMatchObject({
      launcherRoot,
      payloadAppPath: join(launcherRoot, "versions", "0.8.1-beta.7", "payload", "Open Design Beta.app"),
      seeded: true,
      version: "0.8.1-beta.7",
    });
    expect(copied).toEqual([{
      destination: join(launcherRoot, "versions", "0.8.1-beta.7", "payload", "Open Design Beta.app"),
      source: join(root, "Applications", "Open Design Beta.app"),
    }]);
    await expect(stat(payloadExecutable)).resolves.toMatchObject({ size: expect.any(Number) });

    const runtime = JSON.parse(await readFile(join(launcherRoot, "runtime.json"), "utf8")) as {
      active: { entry: { cwd: string; executable: string }; version: string };
      namespace: string;
    };
    expect(runtime).toMatchObject({
      active: {
        entry: {
          cwd: "payload/Open Design Beta.app",
          executable: "payload/Open Design Beta.app/Contents/MacOS/Open Design Beta",
        },
        version: "0.8.1-beta.7",
      },
      namespace: "release-beta",
    });

    const handoff = resolvePackagedLauncherHandoff({
      argv: [publicExecutable, "--od-stamp-app", "desktop"],
      currentExecutablePath: publicExecutable,
      env: {},
      namespace: "release-beta",
      paths: { namespaceRoot },
    });
    expect(handoff).toMatchObject({
      args: ["--od-stamp-app", "desktop"],
      cwd: join(launcherRoot, "versions", "0.8.1-beta.7", "payload", "Open Design Beta.app"),
      executablePath: payloadExecutable,
      launcherRoot,
    });
  });

  it("does not overwrite an existing valid launcher root", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-packaged-bootstrap-existing-"));
    const publicExecutable = await makeFakeMacApp(join(root, "Applications"));
    const namespaceRoot = join(root, "namespaces", "release-beta");
    await ensurePackagedMacLauncherBootstrap({
      appVersion: "0.8.1-beta.7",
      currentExecutablePath: publicExecutable,
      env: {},
      namespace: "release-beta",
      paths: { namespaceRoot },
    }, {
      copyAppBundle: async (_source, destination) => {
        await makeFakeMacApp(join(destination, ".."), "Open Design Beta.app", "Open Design Beta");
      },
      platform: "darwin",
    });

    let copied = 0;
    const result = await ensurePackagedMacLauncherBootstrap({
      appVersion: "0.8.1-beta.8",
      currentExecutablePath: publicExecutable,
      env: {},
      namespace: "release-beta",
      paths: { namespaceRoot },
    }, {
      copyAppBundle: async () => {
        copied += 1;
      },
      platform: "darwin",
    });

    expect(copied).toBe(0);
    expect(result).toMatchObject({ seeded: false, version: "0.8.1-beta.7" });
  });
});
