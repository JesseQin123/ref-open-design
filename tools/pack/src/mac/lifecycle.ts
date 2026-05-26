import { execFile, type ChildProcess } from "node:child_process";
import { cp, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  APP_KEYS,
  OPEN_DESIGN_SIDECAR_CONTRACT,
  SIDECAR_MESSAGES,
  SIDECAR_MODES,
  SIDECAR_SOURCES,
  type DesktopEvalResult,
  type DesktopScreenshotResult,
  type DesktopStatusSnapshot,
  type DesktopUpdateResult,
  type SidecarStamp,
} from "@open-design/sidecar-proto";
import {
  allocatePort,
  createControlEndpoint,
  createSidecarLaunchEnv,
  readAppControlEndpoint,
  requestJsonControl,
  writeAppControlEndpoint,
} from "@open-design/sidecar";
import {
  collectProcessTreePids,
  createProcessStampArgs,
  isProcessAlive,
  listProcessSnapshots,
  matchesStampedProcess,
  readLogTail,
  spawnLoggedProcess,
  stopProcesses,
} from "@open-design/platform";
import type { ToolPackConfig } from "../config.js";
import { readRuntimeAppVersion } from "../versions.js";
import { PACKAGED_CONFIG_PATH_ENV, writeLaunchPackagedConfig } from "./app-config.js";
import { DESKTOP_LOG_ECHO_ENV } from "./constants.js";
import { clearQuarantine, pathExists } from "./fs.js";
import { resolveMacInstallIdentity } from "./identity.js";
import {
  buildMacInstallMetadata,
  buildMacLauncherConfig,
  buildMacPayloadManifest,
  buildMacRuntimeConfig,
  resolveMacLauncherInstallLayout,
} from "./launcher-layout.js";
import { desktopIdentityPath, desktopLogPath, macAppExecutablePath, resolveMacPaths } from "./paths.js";
import type { DesktopRootIdentityFallback, DesktopRootIdentityMarker, MacCleanupResult, MacInspectResult, MacInstallResult, MacStartResult, MacStartSource, MacStopResult, MacUninstallResult } from "./types.js";

const execFileAsync = promisify(execFile);
const UPDATE_ACTION_TIMEOUT_MS = 10 * 60 * 1000;
const PACKAGED_LAUNCHER_ROOT_ENV = "OD_PACKAGED_LAUNCHER_ROOT";

async function desktopStamp(config: ToolPackConfig): Promise<SidecarStamp> {
  const endpoint = createControlEndpoint(
    (await allocatePort({
      host: OPEN_DESIGN_SIDECAR_CONTRACT.defaults.host,
      label: "desktop control",
    })).port,
    OPEN_DESIGN_SIDECAR_CONTRACT.defaults.host,
  );
  const stamp = {
    app: APP_KEYS.DESKTOP,
    endpoint,
    mode: SIDECAR_MODES.RUNTIME,
    namespace: config.namespace,
    source: SIDECAR_SOURCES.TOOLS_PACK,
  };
  await writeAppControlEndpoint({
    app: APP_KEYS.DESKTOP,
    contract: OPEN_DESIGN_SIDECAR_CONTRACT,
    endpoint,
    namespaceRoot: config.roots.runtime.namespaceRoot,
  });
  return stamp;
}

async function desktopEndpoint(config: ToolPackConfig): Promise<string | null> {
  return await readAppControlEndpoint({
    app: APP_KEYS.DESKTOP,
    contract: OPEN_DESIGN_SIDECAR_CONTRACT,
    namespaceRoot: config.roots.runtime.namespaceRoot,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function isDesktopRootIdentityMarker(value: unknown): value is DesktopRootIdentityMarker {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.pid === "number" &&
    typeof value.ppid === "number" &&
    typeof value.appPath === "string" &&
    typeof value.executablePath === "string" &&
    typeof value.logPath === "string" &&
    typeof value.namespaceRoot === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.updatedAt === "string" &&
    isRecord(value.stamp)
  );
}

function summarizeDesktopMarker(
  marker: DesktopRootIdentityMarker | null,
): Partial<DesktopRootIdentityMarker> | undefined {
  if (marker == null) return undefined;
  return {
    appPath: marker.appPath,
    executablePath: marker.executablePath,
    logPath: marker.logPath,
    namespaceRoot: marker.namespaceRoot,
    pid: marker.pid,
    ppid: marker.ppid,
    stamp: marker.stamp,
    startedAt: marker.startedAt,
    updatedAt: marker.updatedAt,
    version: marker.version,
  };
}

async function readDesktopRootIdentityMarker(config: ToolPackConfig): Promise<{
  fallback: DesktopRootIdentityFallback;
  marker: DesktopRootIdentityMarker | null;
}> {
  const markerPath = desktopIdentityPath(config);
  let payload: unknown;

  try {
    payload = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    const code = typeof error === "object" && error != null && "code" in error
      ? String((error as { code?: unknown }).code)
      : null;
    return {
      fallback: {
        markerPath,
        reason: code === "ENOENT" ? "marker-not-found" : "marker-read-failed",
      },
      marker: null,
    };
  }

  if (!isDesktopRootIdentityMarker(payload)) {
    return {
      fallback: {
        markerPath,
        reason: "marker-invalid-shape",
      },
      marker: null,
    };
  }

  return {
    fallback: {
      marker: summarizeDesktopMarker(payload),
      markerPath,
      reason: "marker-present",
    },
    marker: payload,
  };
}

function commandMatchesDesktopMarker(
  command: string,
  marker: DesktopRootIdentityMarker,
): boolean {
  return command.includes(marker.executablePath) || command.includes(macAppExecutablePath(marker.appPath, basename(marker.executablePath)));
}

async function resolveDesktopRootIdentityFallback(config: ToolPackConfig): Promise<{
  fallback: DesktopRootIdentityFallback;
  rootPid: number | null;
}> {
  const { fallback, marker } = await readDesktopRootIdentityMarker(config);
  if (marker == null) return { fallback, rootPid: null };

  let stamp: SidecarStamp;
  try {
    stamp = OPEN_DESIGN_SIDECAR_CONTRACT.normalizeStamp(marker.stamp);
  } catch {
    return {
      fallback: { ...fallback, reason: "marker-invalid-stamp" },
      rootPid: null,
    };
  }

  if (
    stamp.app !== APP_KEYS.DESKTOP ||
    stamp.mode !== SIDECAR_MODES.RUNTIME ||
    stamp.namespace !== config.namespace ||
    (stamp.source !== SIDECAR_SOURCES.PACKAGED && stamp.source !== SIDECAR_SOURCES.TOOLS_PACK)
  ) {
    return {
      fallback: { ...fallback, reason: "marker-stamp-mismatch" },
      rootPid: null,
    };
  }

  if (marker.namespaceRoot !== config.roots.runtime.namespaceRoot) {
    return {
      fallback: { ...fallback, reason: "marker-namespace-root-mismatch" },
      rootPid: null,
    };
  }

  const processes = await listProcessSnapshots();
  const processInfo = processes.find((entry) => entry.pid === marker.pid) ?? null;
  if (processInfo == null) {
    return {
      fallback: { ...fallback, reason: "marker-pid-not-running" },
      rootPid: null,
    };
  }

  if (!commandMatchesDesktopMarker(processInfo.command, marker)) {
    return {
      fallback: {
        ...fallback,
        processCommand: processInfo.command,
        reason: "marker-command-mismatch",
      },
      rootPid: null,
    };
  }

  return {
    fallback: {
      ...fallback,
      processCommand: processInfo.command,
      reason: "marker-matched",
    },
    rootPid: marker.pid,
  };
}

function isUnmanagedDesktopFallback(fallback: DesktopRootIdentityFallback | undefined): boolean {
  return fallback != null && ![
    "marker-matched",
    "marker-not-found",
    "marker-pid-not-running",
  ].includes(fallback.reason);
}

function containsPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}

function safeLauncherRelativePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
  if (isAbsolute(value)) return null;
  const resolved = resolve("/", value);
  if (resolved === "/" || !containsPath("/", resolved)) return null;
  return value;
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function copyMacAppBundle(sourceAppPath: string, destinationAppPath: string): Promise<void> {
  if (process.platform === "darwin") {
    await execFileAsync("/usr/bin/ditto", [sourceAppPath, destinationAppPath]);
    return;
  }
  await cp(sourceAppPath, destinationAppPath, { recursive: true, verbatimSymlinks: true });
}

async function waitForDesktopStatus(config: ToolPackConfig, timeoutMs = 45_000): Promise<DesktopStatusSnapshot | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const endpoint = await desktopEndpoint(config);
      if (endpoint != null) {
        return await requestJsonControl<DesktopStatusSnapshot>(endpoint, { type: SIDECAR_MESSAGES.STATUS }, { timeoutMs: 1000 });
      }
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  }
  return null;
}

type ProcessExit = { code: number | null; signal: NodeJS.Signals | null };

function watchProcessExit(child: ChildProcess): {
  current(): ProcessExit | null;
  wait(timeoutMs: number): Promise<ProcessExit | null>;
} {
  let exit: ProcessExit | null = null;
  const waiters = new Set<(value: ProcessExit) => void>();

  child.once("exit", (code, signal) => {
    exit = { code, signal };
    for (const resolveWait of waiters) resolveWait(exit);
    waiters.clear();
  });

  return {
    current() {
      return exit;
    },
    async wait(timeoutMs: number): Promise<ProcessExit | null> {
      if (exit != null) return exit;
      return await new Promise((resolveWait) => {
        const timer = setTimeout(() => {
          waiters.delete(onExit);
          resolveWait(null);
        }, timeoutMs);
        const onExit = (value: ProcessExit) => {
          clearTimeout(timer);
          resolveWait(value);
        };
        waiters.add(onExit);
      });
    },
  };
}

function formatExit(exit: ProcessExit): string {
  return `code=${exit.code ?? "null"} signal=${exit.signal ?? "null"}`;
}

function isExpectedLauncherHandoffExit(
  target: { source: MacStartSource },
  exit: ProcessExit,
): boolean {
  return target.source === "launcher-entry" && exit.code === 0 && exit.signal == null;
}

function nonEmptyLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

function tailLines(lines: string[], maxLines: number): string[] {
  return lines.slice(Math.max(0, lines.length - maxLines));
}

function truncateLine(line: string, maxLength = 260): string {
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 3)}...`;
}

async function collectLaunchAssessment(appPath: string): Promise<string[]> {
  const commands: Array<{ args: string[]; label: string }> = [
    { args: ["--verify", "--deep", "--strict", "--verbose=2", appPath], label: "codesign" },
    { args: ["--assess", "--type", "execute", "--verbose=4", appPath], label: "spctl" },
  ];
  const lines: string[] = [];

  for (const command of commands) {
    try {
      const result = await execFileAsync(command.label, command.args, { maxBuffer: 1024 * 1024 });
      lines.push(`[${command.label}] ok`);
      if (result.stdout.trim().length > 0) lines.push(result.stdout.trim());
      if (result.stderr.trim().length > 0) lines.push(result.stderr.trim());
    } catch (error) {
      lines.push(`[${command.label}] failed`);
      if (isRecord(error) && typeof error.stdout === "string" && error.stdout.trim().length > 0) {
        lines.push(error.stdout.trim());
      }
      if (isRecord(error) && typeof error.stderr === "string" && error.stderr.trim().length > 0) {
        lines.push(error.stderr.trim());
      }
      if (error instanceof Error && lines.at(-1) !== error.message) {
        lines.push(error.message);
      }
    }
  }

  return lines;
}

async function collectLaunchXattrSummary(appPath: string): Promise<string[]> {
  try {
    const result = await execFileAsync("xattr", ["-lr", appPath], { maxBuffer: 2 * 1024 * 1024 });
    const lines = nonEmptyLines(result.stdout);
    const quarantine = lines.filter((line) => line.includes("com.apple.quarantine"));
    const provenance = lines.filter((line) => line.includes("com.apple.provenance"));
    const matched = [...quarantine, ...provenance];
    return [
      `quarantine entries: ${quarantine.length}`,
      `provenance entries: ${provenance.length}`,
      ...(matched.length === 0 ? [] : tailLines(matched, 8).map((line) => truncateLine(line))),
    ];
  } catch (error) {
    if (isRecord(error) && typeof error.stdout === "string") {
      const lines = nonEmptyLines(error.stdout);
      if (lines.length > 0) return tailLines(lines, 40);
    }
    return [error instanceof Error ? error.message : String(error)];
  }
}

function isRelevantSystemPolicyLine(line: string): boolean {
  return [
    "Malware rejection",
    "lack of matching active rule",
    "notarization daemon",
    "code signature",
    "Gatekeeper",
    "proc_exit",
  ].some((keyword) => line.includes(keyword)) || /\b(crash|exited|exit|fault|killed|terminated|termination)\b/i.test(line);
}

function compactSystemPolicyLines(lines: string[]): string[] {
  const relevant = lines.filter(isRelevantSystemPolicyLine);
  if (relevant.length === 0) return tailLines(lines, 24).map((line) => truncateLine(line));

  const malware = relevant.filter((line) => line.includes("Malware rejection"));
  const missingRule = relevant.filter((line) => line.includes("lack of matching active rule"));
  const notarization = relevant.filter((line) => line.includes("notarization daemon"));
  const other = relevant.filter((line) =>
    !line.includes("Malware rejection") &&
    !line.includes("lack of matching active rule") &&
    !line.includes("notarization daemon")
  );
  const samples = [
    ...tailLines(malware, 5),
    ...tailLines(notarization, 5),
    ...tailLines(missingRule, 5),
    ...tailLines(other, 8),
  ];

  return [
    `matching entries: ${relevant.length}`,
    `malware rejection entries: ${malware.length}`,
    `missing active rule entries: ${missingRule.length}`,
    `notarization daemon entries: ${notarization.length}`,
    ...[...new Set(samples)].map((line) => truncateLine(line)),
  ];
}

async function collectSystemPolicyLog(target: { appPath: string; executablePath: string }): Promise<string[]> {
  const appName = basename(target.appPath, ".app");
  const executableName = basename(target.executablePath);
  const predicate = [...new Set([
    `process == "${appName}"`,
    `process == "${executableName}"`,
    `process == "amfid"`,
    `eventMessage CONTAINS[c] "${appName}"`,
    `eventMessage CONTAINS[c] "${executableName}"`,
    'eventMessage CONTAINS[c] "Malware rejection"',
    'eventMessage CONTAINS[c] "lack of matching active rule"',
    'eventMessage CONTAINS[c] "notarization daemon"',
    'eventMessage CONTAINS[c] "code signature"',
    'eventMessage CONTAINS[c] "Gatekeeper"',
  ])].join(" OR ");

  try {
    const result = await execFileAsync("/usr/bin/log", [
      "show",
      "--style",
      "compact",
      "--last",
      "3m",
      "--predicate",
      predicate,
    ], { maxBuffer: 2 * 1024 * 1024 });
    const lines = nonEmptyLines([result.stdout, result.stderr].join("\n"));
    return compactSystemPolicyLines(lines);
  } catch (error) {
    const lines = [
      ...(isRecord(error) && typeof error.stdout === "string" ? nonEmptyLines(error.stdout) : []),
      ...(isRecord(error) && typeof error.stderr === "string" ? nonEmptyLines(error.stderr) : []),
    ];
    if (lines.length > 0) {
      return compactSystemPolicyLines(lines);
    }
    return [error instanceof Error ? error.message : String(error)];
  }
}

export async function materializeMacLauncherInstall(
  config: ToolPackConfig,
  sourceAppPath: string,
): Promise<ReturnType<typeof resolveMacLauncherInstallLayout>> {
  const paths = resolveMacPaths(config);
  const version = await readRuntimeAppVersion(config);
  const layout = resolveMacLauncherInstallLayout(config, paths, version);

  await rm(layout.versionRoot, { force: true, recursive: true });
  await mkdir(layout.stateRoot, { recursive: true });
  await mkdir(layout.payloadRoot, { recursive: true });
  await copyMacAppBundle(sourceAppPath, layout.payloadAppPath);
  await writeFile(layout.installMetadataPath, `${JSON.stringify(buildMacInstallMetadata(config, layout, version), null, 2)}\n`, "utf8");
  await writeFile(layout.launcherConfigPath, `${JSON.stringify(buildMacLauncherConfig(layout), null, 2)}\n`, "utf8");
  await writeFile(layout.runtimeConfigPath, `${JSON.stringify(buildMacRuntimeConfig(config, layout, version), null, 2)}\n`, "utf8");
  await writeFile(layout.payloadManifestPath, `${JSON.stringify(buildMacPayloadManifest(layout, version), null, 2)}\n`, "utf8");
  return layout;
}

async function resolveMacLauncherPayloadStartTarget(config: ToolPackConfig): Promise<{
  appPath: string;
  executablePath: string;
  launcherRoot?: string;
  source: MacStartSource;
} | null> {
  const paths = resolveMacPaths(config);
  const version = await readRuntimeAppVersion(config);
  const layout = resolveMacLauncherInstallLayout(config, paths, version);
  const runtimeConfig = await readJsonFile(layout.runtimeConfigPath);
  if (!isRecord(runtimeConfig) || !isRecord(runtimeConfig.active)) return null;
  const rootRelativePath = safeLauncherRelativePath(runtimeConfig.active.root);
  if (rootRelativePath == null || !isRecord(runtimeConfig.active.entry)) return null;
  const cwdRelativePath = safeLauncherRelativePath(runtimeConfig.active.entry.cwd);
  const executableRelativePath = safeLauncherRelativePath(runtimeConfig.active.entry.executable);
  if (cwdRelativePath == null || executableRelativePath == null) return null;
  const versionRoot = resolve(layout.root, rootRelativePath);
  const appPath = resolve(versionRoot, cwdRelativePath);
  const executablePath = resolve(versionRoot, executableRelativePath);
  if (!containsPath(layout.root, versionRoot) || !containsPath(layout.root, appPath) || !containsPath(layout.root, executablePath)) {
    return null;
  }
  if (!(await pathExists(executablePath))) return null;
  return {
    appPath,
    executablePath,
    launcherRoot: layout.root,
    source: "launcher-payload",
  };
}

async function createLaunchFailureMessage(
  config: ToolPackConfig,
  target: { appPath: string; executablePath: string; launcherRoot?: string; source: MacStartSource },
  details: { pid: number; reason: string },
): Promise<string> {
  const logPath = desktopLogPath(config);
  const logLines = await readLogTail(logPath, 80).catch(() => []);
  const assessment = await collectLaunchAssessment(target.appPath);
  const xattrs = await collectLaunchXattrSummary(target.appPath);
  const systemPolicyLog = await collectSystemPolicyLog(target);
  return [
    `mac desktop failed to become healthy (${details.reason})`,
    `namespace: ${config.namespace}`,
    `source: ${target.source}`,
    `pid: ${details.pid}`,
    `appPath: ${target.appPath}`,
    `executablePath: ${target.executablePath}`,
    `logPath: ${logPath}`,
    "launch assessment:",
    ...(assessment.length === 0 ? ["(no assessment output)"] : assessment),
    "launch xattrs:",
    ...(xattrs.length === 0 ? ["(no xattr output)"] : xattrs),
    "macOS system policy log:",
    ...(systemPolicyLog.length === 0 ? ["(no matching system log lines)"] : systemPolicyLog),
    "desktop log tail:",
    ...(logLines.length === 0 ? ["(no log lines)"] : logLines),
  ].join("\n");
}

async function resolvePackedMacStartTarget(config: ToolPackConfig): Promise<{
  appPath: string;
  executablePath: string;
  launcherRoot?: string;
  source: MacStartSource;
}> {
  const launcherTarget = await resolveMacLauncherPayloadStartTarget(config);

  const paths = resolveMacPaths(config);
  const identity = resolveMacInstallIdentity(config);
  if (launcherTarget != null) {
    const executablePath = macAppExecutablePath(paths.installedAppPath, identity.executableName);
    if (await pathExists(executablePath)) {
      return {
        appPath: paths.installedAppPath,
        executablePath,
        launcherRoot: launcherTarget.launcherRoot,
        source: "launcher-entry",
      };
    }
  }

  const candidates: Array<{ appPath: string; source: MacStartSource }> = [
    { appPath: paths.installedAppPath, source: "installed" },
    { appPath: paths.userApplicationsAppPath, source: "user-applications" },
    { appPath: paths.systemApplicationsAppPath, source: "system-applications" },
    { appPath: paths.appPath, source: "built" },
  ];

  for (const candidate of candidates) {
    const executablePath = macAppExecutablePath(candidate.appPath, identity.executableName);
    if (await pathExists(executablePath)) {
      return { ...candidate, executablePath };
    }
  }

  if (launcherTarget != null) return launcherTarget;

  throw new Error(
    `no mac .app executable found for namespace=${config.namespace}; run tools-pack mac build --to all and tools-pack mac install first`,
  );
}

async function detachMount(mountPoint: string): Promise<boolean> {
  try {
    await execFileAsync("hdiutil", ["detach", mountPoint, "-quiet"]);
    return true;
  } catch {
    try {
      await execFileAsync("hdiutil", ["detach", mountPoint, "-force", "-quiet"]);
      return true;
    } catch {
      return false;
    }
  }
}

export async function installPackedMacDmg(config: ToolPackConfig): Promise<MacInstallResult> {
  const paths = resolveMacPaths(config);
  const identity = resolveMacInstallIdentity(config);
  if (!(await pathExists(paths.dmgPath))) {
    throw new Error(`no mac dmg found at ${paths.dmgPath}; run tools-pack mac build --to all first`);
  }

  await rm(paths.mountPoint, { force: true, recursive: true });
  await mkdir(paths.mountPoint, { recursive: true });
  await rm(paths.installedAppPath, { force: true, recursive: true });
  await mkdir(paths.installApplicationsRoot, { recursive: true });

  let detached = false;
  try {
    await execFileAsync("hdiutil", [
      "attach",
      paths.dmgPath,
      "-mountpoint",
      paths.mountPoint,
      "-nobrowse",
      "-quiet",
    ]);
    await execFileAsync("ditto", [join(paths.mountPoint, identity.publicAppBundleName), paths.installedAppPath]);
    await clearQuarantine(paths.installedAppPath);
    await materializeMacLauncherInstall(config, paths.installedAppPath);
  } finally {
    detached = await detachMount(paths.mountPoint);
  }

  return {
    detached,
    dmgPath: paths.dmgPath,
    installedAppPath: paths.installedAppPath,
    mountPoint: paths.mountPoint,
    namespace: config.namespace,
  };
}

export async function startPackedMacApp(config: ToolPackConfig): Promise<MacStartResult> {
  const target = await resolvePackedMacStartTarget(config);
  const stamp = await desktopStamp(config);
  const logPath = desktopLogPath(config);
  const launchConfigPath = await writeLaunchPackagedConfig(config, target.appPath);
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, "", "utf8");

  const logHandle = await open(logPath, "a");
  let child: ChildProcess;
  try {
    child = await spawnLoggedProcess({
      args: createProcessStampArgs(stamp, OPEN_DESIGN_SIDECAR_CONTRACT),
      command: target.executablePath,
      cwd: target.appPath,
      detached: true,
      env: createSidecarLaunchEnv({
        base: config.roots.runtime.namespaceBaseRoot,
        contract: OPEN_DESIGN_SIDECAR_CONTRACT,
        extraEnv: {
          ...process.env,
          [DESKTOP_LOG_ECHO_ENV]: "0",
          [PACKAGED_CONFIG_PATH_ENV]: launchConfigPath,
          ...(target.launcherRoot == null ? {} : { [PACKAGED_LAUNCHER_ROOT_ENV]: target.launcherRoot }),
        },
        stamp,
      }),
      logFd: logHandle.fd,
    });
  } finally {
    await logHandle.close().catch(() => undefined);
  }
  const pid = child.pid ?? 0;
  const exit = watchProcessExit(child);
  const earlyExit = await exit.wait(1500);
  child.unref();
  if (earlyExit != null && !isExpectedLauncherHandoffExit(target, earlyExit)) {
    throw new Error(await createLaunchFailureMessage(config, target, {
      pid,
      reason: `process exited early ${formatExit(earlyExit)}`,
    }));
  }

  const status = await waitForDesktopStatus(config);
  const delayedExit = exit.current();
  if (status == null && delayedExit != null) {
    throw new Error(await createLaunchFailureMessage(config, target, {
      pid,
      reason: isExpectedLauncherHandoffExit(target, delayedExit)
        ? `launcher entry exited after handoff but desktop control endpoint was not available ${formatExit(delayedExit)}`
        : `process exited before desktop control endpoint was available ${formatExit(delayedExit)}`,
    }));
  }
  if (status == null && !isProcessAlive(pid)) {
    throw new Error(await createLaunchFailureMessage(config, target, {
      pid,
      reason: "process exited before desktop control endpoint was available without an observed exit event",
    }));
  }
  return {
    appPath: target.appPath,
    executablePath: target.executablePath,
    logPath,
    namespace: config.namespace,
    pid: typeof status?.pid === "number" ? status.pid : pid,
    source: target.source,
    status,
  };
}

async function findManagedDesktopProcessTree(config: ToolPackConfig): Promise<{
  fallback?: DesktopRootIdentityFallback;
  pids: number[];
}> {
  const processes = await listProcessSnapshots();
  const stampedRootPids = processes
    .filter((processInfo) =>
      matchesStampedProcess(processInfo, {
        mode: SIDECAR_MODES.RUNTIME,
        namespace: config.namespace,
        source: SIDECAR_SOURCES.TOOLS_PACK,
      }, OPEN_DESIGN_SIDECAR_CONTRACT),
    )
    .map((processInfo) => processInfo.pid);
  const identity = await resolveDesktopRootIdentityFallback(config);
  const pids = collectProcessTreePids(processes, [
    ...stampedRootPids,
    identity.rootPid,
  ]);
  return { fallback: identity.fallback, pids };
}

async function waitForNoManagedDesktopProcesses(
  config: ToolPackConfig,
  timeoutMs = 6000,
): Promise<{ fallback?: DesktopRootIdentityFallback; pids: number[] }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = await findManagedDesktopProcessTree(config);
    if (current.pids.length === 0) return current;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  return await findManagedDesktopProcessTree(config);
}

export async function stopPackedMacApp(config: ToolPackConfig): Promise<MacStopResult> {
  const before = await findManagedDesktopProcessTree(config);
  let gracefulRequested = false;

  try {
    const endpoint = await desktopEndpoint(config);
    if (endpoint != null) {
      await requestJsonControl(endpoint, { type: SIDECAR_MESSAGES.SHUTDOWN }, { timeoutMs: 1500 });
      gracefulRequested = true;
    }
  } catch {
    gracefulRequested = false;
  }

  const remainingAfterGraceful = gracefulRequested ? await waitForNoManagedDesktopProcesses(config) : before;
  if (remainingAfterGraceful.pids.length === 0) {
    const unmanaged = !gracefulRequested && before.pids.length === 0 && isUnmanagedDesktopFallback(before.fallback);
    if (!unmanaged) {
      await rm(desktopIdentityPath(config), { force: true }).catch(() => undefined);
    }
    return {
      ...(before.fallback == null ? {} : { fallback: before.fallback }),
      gracefulRequested,
      namespace: config.namespace,
      remainingPids: [],
      status: unmanaged ? "unmanaged" : before.pids.length === 0 ? "not-running" : "stopped",
      stoppedPids: before.pids,
    };
  }

  const stopped = await stopProcesses(remainingAfterGraceful.pids);
  if (stopped.remainingPids.length === 0) {
    await rm(desktopIdentityPath(config), { force: true }).catch(() => undefined);
  }
  return {
    ...(remainingAfterGraceful.fallback == null ? {} : { fallback: remainingAfterGraceful.fallback }),
    gracefulRequested,
    namespace: config.namespace,
    remainingPids: stopped.remainingPids,
    status: stopped.remainingPids.length === 0 ? "stopped" : "partial",
    stoppedPids: stopped.stoppedPids,
  };
}

export async function readPackedMacLogs(config: ToolPackConfig) {
  const entries = await Promise.all(
    [APP_KEYS.DESKTOP, APP_KEYS.WEB, APP_KEYS.DAEMON].map(async (app) => {
      const logPath = join(config.roots.runtime.namespaceRoot, "logs", app, "latest.log");
      return [app, { lines: await readLogTail(logPath, 200), logPath }] as const;
    }),
  );

  return {
    logs: Object.fromEntries(entries),
    namespace: config.namespace,
  };
}

function resolveUpdateAction(value: string | undefined): "status" | "check" | "download" | "install" | null {
  if (value == null) return null;
  if (value === "status" || value === "check" || value === "download" || value === "install") return value;
  throw new Error("--update-action must be status, check, download, or install");
}

export async function inspectPackedMacApp(config: ToolPackConfig, options: { expr?: string; path?: string; updateAction?: string }): Promise<MacInspectResult> {
  const endpoint = await desktopEndpoint(config);
  const requireEndpoint = (): string => {
    if (endpoint == null) throw new Error("desktop control endpoint is not available");
    return endpoint;
  };
  const status = endpoint == null
    ? null
    : await requestJsonControl<DesktopStatusSnapshot>(
      endpoint,
      { type: SIDECAR_MESSAGES.STATUS },
      { timeoutMs: 2000 },
    ).catch(() => null);
  const updateAction = resolveUpdateAction(options.updateAction);

  return {
    ...(options.expr == null ? {} : {
      eval: await requestJsonControl<DesktopEvalResult>(
        requireEndpoint(),
        { input: { expression: options.expr }, type: SIDECAR_MESSAGES.EVAL },
        { timeoutMs: 5000 },
      ),
    }),
    ...(options.path == null ? {} : {
      screenshot: await requestJsonControl<DesktopScreenshotResult>(
        requireEndpoint(),
        { input: { path: options.path }, type: SIDECAR_MESSAGES.SCREENSHOT },
        { timeoutMs: 10000 },
      ),
    }),
    ...(updateAction == null ? {} : {
      update: await requestJsonControl<DesktopUpdateResult>(
        requireEndpoint(),
        { input: { action: updateAction }, type: SIDECAR_MESSAGES.UPDATE },
        { timeoutMs: UPDATE_ACTION_TIMEOUT_MS },
      ),
    }),
    status,
  };
}

export async function uninstallPackedMacApp(config: ToolPackConfig): Promise<MacUninstallResult> {
  const paths = resolveMacPaths(config);
  const stop = await stopPackedMacApp(config);
  const removed = await pathExists(paths.installedAppPath);
  await rm(paths.installedAppPath, { force: true, recursive: true });

  return {
    installedAppPath: paths.installedAppPath,
    namespace: config.namespace,
    removed,
    stop,
  };
}

export async function cleanupPackedMacNamespace(config: ToolPackConfig): Promise<MacCleanupResult> {
  const paths = resolveMacPaths(config);
  const stop = await stopPackedMacApp(config);
  const detachedMount = await detachMount(paths.mountPoint);
  const removedOutputRoot = await pathExists(config.roots.output.namespaceRoot);
  const removedRuntimeNamespaceRoot = await pathExists(config.roots.runtime.namespaceRoot);

  await rm(config.roots.output.namespaceRoot, { force: true, recursive: true });
  await rm(config.roots.runtime.namespaceRoot, { force: true, recursive: true });

  return {
    detachedMount,
    namespace: config.namespace,
    outputRoot: config.roots.output.namespaceRoot,
    removedOutputRoot,
    removedRuntimeNamespaceRoot,
    runtimeNamespaceRoot: config.roots.runtime.namespaceRoot,
    stop,
  };
}
