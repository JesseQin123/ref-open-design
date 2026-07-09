import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { startReleaseStorageFixtureServer } from "../src/release-storage-fixture.js";

type ReleaseStorageFixture = Awaited<ReturnType<typeof startReleaseStorageFixtureServer>>;

function runNode(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(new Error(`node ${args.join(" ")} exited ${String(code)}\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function putFixtureJson(server: ReleaseStorageFixture, objectKey: string, value: unknown): Promise<void> {
  const response = await fetch(`${server.info.endpointUrl}/${server.info.bucket}/${objectKey}`, {
    body: JSON.stringify(value),
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    method: "PUT",
  });
  if (!response.ok) {
    throw new Error(`fixture PUT ${objectKey} failed with HTTP ${response.status}: ${await response.text()}`);
  }
}

describe("shared release metadata publisher", () => {
  it("publishes complete beta, prerelease, preview, and stable metadata through the release storage fixture", async () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const root = await mkdtemp(join(tmpdir(), "od-release-metadata-publish-"));
    const server = await startReleaseStorageFixtureServer();
    try {
      for (const [channel, version] of [
        ["beta", "1.2.3-beta.4"],
        ["prerelease", "1.2.3-prerelease.4"],
        ["preview", "1.2.3-preview.4"],
        ["stable", "1.2.3"],
      ] as const) {
        const changelogRoot = join(root, channel, "CHANGELOG");
        const manifestDir = join(root, channel, "manifests");
        const metadataDir = join(root, channel, "metadata");
        const releaseNotesDir = join(changelogRoot, `v${version}`);
        await mkdir(manifestDir, { recursive: true });
        await mkdir(releaseNotesDir, { recursive: true });
        await writeFile(join(releaseNotesDir, "en.md"), `# Open Design ${version}\n\nEnglish notes.\n`, "utf8");
        await writeFile(join(releaseNotesDir, "zh-CN.md"), `# Open Design ${version}\n\n中文说明。\n`, "utf8");
        await writeFile(join(releaseNotesDir, "en.html"), `<h1>Open Design ${version}</h1>\n`, "utf8");
        await writeFile(
          join(releaseNotesDir, "meta.json"),
          JSON.stringify({ jumpTo: { url: `https://releases.example.test/${channel}/${version}` } }, null, 2),
          "utf8",
        );
        const base = {
          channel,
          enabled: true,
          github: { commit: "abc123", runId: 42 },
          r2: { versionPrefix: `${channel}/versions/${version}` },
          releaseVersion: version,
          status: "published",
          version: 1,
        };
        await writeFile(
          join(manifestDir, "mac_arm64.json"),
          JSON.stringify(
            {
              ...base,
              arch: "arm64",
              artifacts: { dmg: { url: "https://example.test/dmg" }, payload: { url: "https://example.test/mac-payload" } },
              feed: null,
              legacyPlatformKey: "mac",
              platformKey: "mac_arm64",
              releaseTarget: "mac_arm64",
              signed: true,
            },
            null,
            2,
          ),
          "utf8",
        );
        await writeFile(
          join(manifestDir, "win_x64.json"),
          JSON.stringify(
            {
              ...base,
              arch: "x64",
              artifacts: { installer: { url: "https://example.test/exe" }, payload: { url: "https://example.test/win-payload" } },
              feed: null,
              legacyPlatformKey: "win",
              platformKey: "win_x64",
              releaseTarget: "win_x64",
              signed: false,
            },
            null,
            2,
          ),
          "utf8",
        );

        const env = {
          ...process.env,
          BASE_VERSION: "1.2.3",
          ENABLE_LINUX_X64: "false",
          ENABLE_MAC_ARM64: "true",
          ENABLE_MAC_X64: "false",
          ENABLE_WIN_X64: "true",
          MAC_ARM64_RESULT: "success",
          OPEN_DESIGN_RELEASE_NOTES_ROOT: changelogRoot,
          RELEASE_ASSET_SUFFIX: "",
          RELEASE_CHANNEL: channel,
          RELEASE_COMMIT: "abc123",
          RELEASE_MANIFEST_DIR: manifestDir,
          RELEASE_METADATA_DIR: metadataDir,
          RELEASE_OUTPUTS_PATH: join(metadataDir, "outputs.json"),
          RELEASE_PUBLIC_ORIGIN: "https://releases.example.test",
          RELEASE_RUN_ID: "42",
          RELEASE_SIGNED: "true",
          RELEASE_STORAGE_ACCESS_KEY_ID: "ak",
          RELEASE_STORAGE_BUCKET: server.info.bucket,
          RELEASE_STORAGE_ENDPOINT: server.info.endpointUrl,
          RELEASE_STORAGE_REGION: "auto",
          RELEASE_STORAGE_SECRET_ACCESS_KEY: "sk",
          RELEASE_VERSION: version,
          STATE_SOURCE: "local-tools-serve",
          WIN_X64_RESULT: "success",
          ...(channel === "beta" ? { RELEASE_LATEST_CAS_REQUIRED: "true" } : {}),
        };
        await runNode(["--experimental-strip-types", "tools/release/src/storage/publish-metadata.ts"], {
          cwd: repoRoot,
          env,
        });

        const metadata = JSON.parse(await readFile(join(metadataDir, "metadata.json"), "utf8")) as {
          channel?: string;
          releaseState?: string;
          releaseTargets?: {
            mac_arm64?: { artifacts?: { payload?: { url?: string } } };
            win_x64?: { artifacts?: { payload?: { url?: string } } };
          };
          releaseNotes?: {
            files?: Record<string, {
              html?: { contentType?: string; url?: string };
              markdown?: { contentType?: string; url?: string };
            }>;
            jumpTo?: { kind?: string; url?: string };
          };
          allReadyTargetsSigned?: boolean;
          signed?: boolean;
          stableVersion?: string;
          github?: { commit?: string };
        };
        expect(metadata.channel).toBe(channel);
        expect(metadata.releaseState).toBe("complete");
        expect(metadata.signed).toBe(true);
        expect(metadata.allReadyTargetsSigned).toBe(false);
        expect(metadata.releaseTargets?.mac_arm64?.artifacts?.payload?.url).toBe("https://example.test/mac-payload");
        expect(metadata.releaseTargets?.win_x64?.artifacts?.payload?.url).toBe("https://example.test/win-payload");
        // github attribution must round-trip from the RELEASE_* env the workflow
        // passes; the stable promotion gate checks metadata.github.commit.
        expect(metadata.github?.commit).toBe("abc123");
        if (channel === "stable") {
          expect(metadata.stableVersion).toBe("1.2.3");
        }
        expect(metadata.releaseNotes?.files?.en?.html?.url).toBe(`https://releases.example.test/${channel}/versions/${version}/release-notes/en.html`);
        expect(metadata.releaseNotes?.files?.en?.markdown?.contentType).toBe("text/markdown; charset=utf-8");
        expect(metadata.releaseNotes?.files?.["zh-CN"]?.markdown?.url).toBe(`https://releases.example.test/${channel}/versions/${version}/release-notes/zh-CN.md`);
        expect(metadata.releaseNotes?.jumpTo).toEqual({
          kind: "external",
          url: `https://releases.example.test/${channel}/${version}`,
        });
        expect(server.getObject(`${channel}/versions/${version}/release-notes/en.md`)).not.toBeNull();
        expect(server.getObject(`${channel}/versions/${version}/release-notes/zh-CN.md`)).not.toBeNull();
        expect(server.getObject(`${channel}/versions/${version}/release-notes/en.html`)).not.toBeNull();
        expect(server.getObject(`${channel}/latest/metadata.json`)).not.toBeNull();
      }
    } finally {
      await server.close();
    }
  });

  it("requires explicit force before moving counted latest metadata backward", async () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const root = await mkdtemp(join(tmpdir(), "od-release-metadata-force-latest-"));
    const server = await startReleaseStorageFixtureServer();
    try {
      const channel = "beta";
      const version = "2.0.0-beta.1";
      const previousVersion = "2.1.0-beta.3";
      const manifestDir = join(root, "manifests");
      const metadataDir = join(root, "metadata");
      await mkdir(manifestDir, { recursive: true });
      await writeFile(
        join(manifestDir, "mac_arm64.json"),
        JSON.stringify(
          {
            arch: "arm64",
            artifacts: { dmg: { url: "https://example.test/dmg" }, payload: { url: "https://example.test/mac-payload" } },
            channel,
            enabled: true,
            feed: null,
            github: { commit: "abc123", runId: 42 },
            legacyPlatformKey: "mac",
            platformKey: "mac_arm64",
            r2: { versionPrefix: `${channel}/versions/${version}` },
            releaseTarget: "mac_arm64",
            releaseVersion: version,
            signed: true,
            status: "published",
            version: 1,
          },
          null,
          2,
        ),
        "utf8",
      );
      await putFixtureJson(server, `${channel}/latest/metadata.json`, {
        baseVersion: "2.1.0",
        channel,
        releaseNumber: 3,
        releaseVersion: previousVersion,
      });

      const env = {
        ...process.env,
        BASE_VERSION: "2.0.0",
        ENABLE_LINUX_X64: "false",
        ENABLE_MAC_ARM64: "true",
        ENABLE_MAC_X64: "false",
        ENABLE_WIN_X64: "false",
        MAC_ARM64_RESULT: "success",
        RELEASE_ASSET_SUFFIX: "",
        RELEASE_CHANNEL: channel,
        RELEASE_COMMIT: "abc123",
        RELEASE_LATEST_CAS_REQUIRED: "true",
        RELEASE_MANIFEST_DIR: manifestDir,
        RELEASE_METADATA_DIR: metadataDir,
        RELEASE_OUTPUTS_PATH: join(metadataDir, "outputs.json"),
        RELEASE_PUBLIC_ORIGIN: "https://releases.example.test",
        RELEASE_RUN_ID: "42",
        RELEASE_SIGNED: "true",
        RELEASE_STORAGE_ACCESS_KEY_ID: "ak",
        RELEASE_STORAGE_BUCKET: server.info.bucket,
        RELEASE_STORAGE_ENDPOINT: server.info.endpointUrl,
        RELEASE_STORAGE_REGION: "auto",
        RELEASE_STORAGE_SECRET_ACCESS_KEY: "sk",
        RELEASE_VERSION: version,
        STATE_SOURCE: "local-tools-serve",
      };

      await expect(
        runNode(["--experimental-strip-types", "tools/release/src/storage/publish-metadata.ts"], {
          cwd: repoRoot,
          env,
        }),
      ).rejects.toThrow(`refusing to move ${channel} latest backward from ${previousVersion} to ${version}`);

      await runNode(["--experimental-strip-types", "tools/release/src/storage/publish-metadata.ts"], {
        cwd: repoRoot,
        env: {
          ...env,
          RELEASE_LATEST_FORCE: "true",
        },
      });

      const latest = server.getObject(`${channel}/latest/metadata.json`);
      expect(latest).not.toBeNull();
      expect(JSON.parse(latest?.toString("utf8") ?? "{}")).toMatchObject({
        channel,
        releaseVersion: version,
      });
    } finally {
      await server.close();
    }
  });

  it("treats non-stable release notes as optional while stable remains required", async () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const root = await mkdtemp(join(tmpdir(), "od-release-metadata-optional-notes-"));
    const server = await startReleaseStorageFixtureServer();
    try {
      for (const [channel, version] of [
        ["beta", "2.0.0-beta.1"],
        ["stable", "2.0.0"],
      ] as const) {
        const changelogRoot = join(root, channel, "CHANGELOG");
        const manifestDir = join(root, channel, "manifests");
        const metadataDir = join(root, channel, "metadata");
        await mkdir(manifestDir, { recursive: true });
        await writeFile(
          join(manifestDir, "mac_arm64.json"),
          JSON.stringify(
            {
              arch: "arm64",
              artifacts: { dmg: { url: "https://example.test/dmg" }, payload: { url: "https://example.test/mac-payload" } },
              channel,
              enabled: true,
              feed: null,
              github: { commit: "abc123", runId: 42 },
              legacyPlatformKey: "mac",
              platformKey: "mac_arm64",
              r2: { versionPrefix: `${channel}/versions/${version}` },
              releaseTarget: "mac_arm64",
              releaseVersion: version,
              signed: true,
              status: "published",
              version: 1,
            },
            null,
            2,
          ),
          "utf8",
        );

        const env = {
          ...process.env,
          BASE_VERSION: "2.0.0",
          ENABLE_LINUX_X64: "false",
          ENABLE_MAC_ARM64: "true",
          ENABLE_MAC_X64: "false",
          ENABLE_WIN_X64: "false",
          MAC_ARM64_RESULT: "success",
          OPEN_DESIGN_RELEASE_NOTES_ROOT: changelogRoot,
          RELEASE_ASSET_SUFFIX: "",
          RELEASE_CHANNEL: channel,
          RELEASE_COMMIT: "abc123",
          RELEASE_MANIFEST_DIR: manifestDir,
          RELEASE_METADATA_DIR: metadataDir,
          RELEASE_OUTPUTS_PATH: join(metadataDir, "outputs.json"),
          RELEASE_PUBLIC_ORIGIN: "https://releases.example.test",
          RELEASE_RUN_ID: "42",
          RELEASE_SIGNED: "true",
          RELEASE_STORAGE_ACCESS_KEY_ID: "ak",
          RELEASE_STORAGE_BUCKET: server.info.bucket,
          RELEASE_STORAGE_ENDPOINT: server.info.endpointUrl,
          RELEASE_STORAGE_REGION: "auto",
          RELEASE_STORAGE_SECRET_ACCESS_KEY: "sk",
          RELEASE_VERSION: version,
          STATE_SOURCE: "local-tools-serve",
        };

        const publish = runNode(["--experimental-strip-types", "tools/release/src/storage/publish-metadata.ts"], {
          cwd: repoRoot,
          env,
        });
        if (channel === "stable") {
          await expect(publish).rejects.toThrow("stable release notes require en.md, zh-CN.md");
          continue;
        }

        await publish;
        const metadata = JSON.parse(await readFile(join(metadataDir, "metadata.json"), "utf8")) as {
          releaseNotes?: unknown;
          releaseState?: string;
        };
        expect(metadata.releaseState).toBe("complete");
        expect(metadata.releaseNotes).toBeUndefined();
        expect(server.getObject(`${channel}/versions/${version}/metadata.json`)).not.toBeNull();
      }
    } finally {
      await server.close();
    }
  });

  it("fails loudly when release notes jumpTo metadata is not HTTPS", async () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const root = await mkdtemp(join(tmpdir(), "od-release-metadata-invalid-jump-to-"));
    const server = await startReleaseStorageFixtureServer();
    try {
      const channel = "beta";
      const version = "2.1.0-beta.1";
      const changelogRoot = join(root, "CHANGELOG");
      const manifestDir = join(root, "manifests");
      const metadataDir = join(root, "metadata");
      const releaseNotesDir = join(changelogRoot, `v${version}`);
      await mkdir(manifestDir, { recursive: true });
      await mkdir(releaseNotesDir, { recursive: true });
      await writeFile(join(releaseNotesDir, "en.md"), "# Open Design\n", "utf8");
      await writeFile(join(releaseNotesDir, "zh-CN.md"), "# Open Design\n", "utf8");
      await writeFile(
        join(releaseNotesDir, "meta.json"),
        JSON.stringify({ jumpTo: { url: "http://example.test/release-notes" } }, null, 2),
        "utf8",
      );
      await writeFile(
        join(manifestDir, "mac_arm64.json"),
        JSON.stringify(
          {
            arch: "arm64",
            artifacts: { dmg: { url: "https://example.test/dmg" } },
            channel,
            enabled: true,
            feed: null,
            github: { commit: "abc123", runId: 42 },
            legacyPlatformKey: "mac",
            platformKey: "mac_arm64",
            r2: { versionPrefix: `${channel}/versions/${version}` },
            releaseTarget: "mac_arm64",
            releaseVersion: version,
            signed: true,
            status: "published",
            version: 1,
          },
          null,
          2,
        ),
        "utf8",
      );

      await expect(
        runNode(["--experimental-strip-types", "tools/release/src/storage/publish-metadata.ts"], {
          cwd: repoRoot,
          env: {
            ...process.env,
            BASE_VERSION: "2.1.0",
            ENABLE_LINUX_X64: "false",
            ENABLE_MAC_ARM64: "true",
            ENABLE_MAC_X64: "false",
            ENABLE_WIN_X64: "false",
            MAC_ARM64_RESULT: "success",
            OPEN_DESIGN_RELEASE_NOTES_ROOT: changelogRoot,
            RELEASE_ASSET_SUFFIX: "",
            RELEASE_CHANNEL: channel,
            RELEASE_COMMIT: "abc123",
            RELEASE_MANIFEST_DIR: manifestDir,
            RELEASE_METADATA_DIR: metadataDir,
            RELEASE_OUTPUTS_PATH: join(metadataDir, "outputs.json"),
            RELEASE_PUBLIC_ORIGIN: "https://releases.example.test",
            RELEASE_RUN_ID: "42",
            RELEASE_SIGNED: "true",
            RELEASE_STORAGE_ACCESS_KEY_ID: "ak",
            RELEASE_STORAGE_BUCKET: server.info.bucket,
            RELEASE_STORAGE_ENDPOINT: server.info.endpointUrl,
            RELEASE_STORAGE_REGION: "auto",
            RELEASE_STORAGE_SECRET_ACCESS_KEY: "sk",
            RELEASE_VERSION: version,
            STATE_SOURCE: "local-tools-serve",
          },
        }),
      ).rejects.toThrow("release notes jumpTo.url must be an HTTPS URL");
    } finally {
      await server.close();
    }
  });
});
