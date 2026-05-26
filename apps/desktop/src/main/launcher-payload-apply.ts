import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { buildRuntimeConfig, type RuntimeConfig, type RuntimeVersionDescriptor } from "@open-design/launcher-proto";

const CLEANUP_MARKER_SCHEMA_VERSION = 1;
const INSTALL_LOCK_OWNER_SCHEMA_VERSION = 1;
const INSTALL_METADATA_SCHEMA_VERSION = 1;
const LAUNCHER_CONFIG_SCHEMA_VERSION = 1;
const LAUNCHER_OPERATION_OBSERVATION_KIND = "launcher_operation_observation";
const LAUNCHER_OPERATION_OBSERVATION_SCHEMA_VERSION = 1;
const LAUNCHER_DIR_NAME = "launcher";
const PAYLOAD_DIR_NAME = "payload";
const PRODUCT_EXE_NAME = "Open Design.exe";
const ATTEMPT_RELATIVE_PATH = "state/attempt.json";
const RUNTIME_RELATIVE_PATH = "runtime.json";
const RUNTIME_NAMESPACE_ROOT = ".";
const SEVEN_ZIP_DIR_NAME = "7z";
const SEVEN_ZIP_RELATIVE_PATH = "lib/7z/7z.exe";
const SEVEN_ZIP_DLL_RELATIVE_PATH = "lib/7z/7z.dll";
const VERSIONS_DIR_NAME = "versions";
const INSTALL_ROOT_LAYER_VERSION_ENTRY_NAMES = new Set([
  "install.json",
  "launcher.json",
  "runtime.json",
  "state",
  "logs",
  "lib",
  "versions",
]);
const execFileAsync = promisify(execFile);

type LauncherOperation = "cleanup" | "launcher-self-update" | "payload-apply" | "ready" | "reconcile";
type LauncherOperationStatus = "failed" | "ok" | "skipped";
type ProcessWithNoAsar = NodeJS.Process & { noAsar?: boolean };
type LauncherPayloadPlatform = "darwin" | "win32";

type LauncherPayloadLayout = {
  appBundleName?: string;
  entryCwd: string;
  entryExecutable: string;
  executableName?: string;
  payloadExecutableInApp?: string;
  platform: LauncherPayloadPlatform;
  selfUpdateExecutableName?: string;
};

type LauncherPayloadManifest = {
  appBundleName?: string;
  entry: {
    cwd: string;
    executable: string;
  };
  payloadRoot: string;
  platform?: LauncherPayloadPlatform;
  schemaVersion: 1;
  version: string;
};

type LauncherInstallMetadata = Record<string, unknown> & {
  currentVersion?: string;
  displayName?: string;
  exeName?: string;
  helpers?: Record<string, unknown> & {
    sevenZip?: string;
    sevenZipDll?: string;
  };
  launcher?: Record<string, unknown> & {
    appBundleName?: string;
    executable?: string;
    executableName?: string;
    rootDiscovery?: string;
  };
  namespace?: string;
  runtimePath?: string;
  schemaVersion?: number;
  versionsRoot?: string;
};

type LauncherConfig = Record<string, unknown> & {
  attemptPath?: string;
  runtimePath?: string;
  schemaVersion?: number;
};

type LauncherCleanupMarker = {
  createdAt?: string;
  namespace: string;
  readyVersion: string;
  schemaVersion: typeof CLEANUP_MARKER_SCHEMA_VERSION;
  strategy: "lazyQuickDelete";
  versions: Array<{
    root: string;
    version: string;
  }>;
};

export type LauncherPayloadApplyInput = {
  archivePath: string;
  extractor?: LauncherPayloadExtractor;
  launcherConfigPath: string;
  installMetadataPath: string;
  installRoot: string;
  lockPath: string;
  namespace: string;
  now?: () => Date;
  platform?: string;
  runtimeConfigPath: string;
  sevenZipPath?: string;
  updateRoot: string;
  version: string;
};

export type LauncherPayloadExtractor = (input: {
  archivePath: string;
  destinationRoot: string;
  platform: string;
  sevenZipPath?: string;
}) => Promise<void>;

export type LauncherPayloadApplyResult = {
  appliedAt: string;
  installMetadataPath: string;
  launcherConfigPath: string;
  latestSummaryPath?: string;
  launcherSelfUpdateCandidatePath?: string;
  launcherSelfUpdateTargetPath?: string;
  payloadRoot: string;
  previousVersion?: string;
  promoted: boolean;
  runtimeConfigPath: string;
  summaryPath?: string;
  version: string;
  versionRoot: string;
};

export type LauncherPayloadReadyInput = {
  cleanupMarkerPath: string;
  installRoot: string;
  lockPath: string;
  namespace: string;
  now?: () => Date;
  runtimeConfigPath: string;
  version: string;
};

export type LauncherCleanupInput = {
  cleanupMarkerPath: string;
  installRoot: string;
  lockPath: string;
  namespace: string;
  now?: () => Date;
  runtimeConfigPath: string;
};

export type LauncherPayloadReadyResult =
  | {
    advancedLastSuccessful: boolean;
    attemptMarkerPath: string;
    cleanupMarkerPath?: string;
    deletedAttemptMarker: boolean;
    deleteVersions: string[];
    latestSummaryPath?: string;
    ok: true;
    readyVersion: string;
    runtimeConfigPath: string;
    summaryPath?: string;
  }
  | {
    activeVersion?: string;
    latestSummaryPath?: string;
    ok: false;
    readyVersion: string;
    reason: "active-version-mismatch";
    runtimeConfigPath: string;
    summaryPath?: string;
  };

export type LauncherCleanupResult =
  | {
    cleanupMarkerPath: string;
    deletedVersions: string[];
    failedVersions: Array<{ error: string; version: string }>;
    latestSummaryPath?: string;
    ok: true;
    protectedVersions: string[];
    remainingVersions: string[];
    summaryPath?: string;
  }
  | {
    cleanupMarkerPath: string;
    ok: false;
    reason: "marker-missing";
  };

export type LauncherOperationObservation = {
  createdAt: string;
  details?: unknown;
  error?: string;
  installRoot: string;
  kind: typeof LAUNCHER_OPERATION_OBSERVATION_KIND;
  namespace: string;
  operation: LauncherOperation;
  schemaVersion: typeof LAUNCHER_OPERATION_OBSERVATION_SCHEMA_VERSION;
  status: LauncherOperationStatus;
};

export type LauncherOperationObservationWrite = {
  latestSummaryPath: string;
  summaryPath: string;
};

function containsPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}

function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function withAsarFileSystemDisabled<T>(callback: () => Promise<T>): Promise<T> {
  const electronProcess = process as ProcessWithNoAsar;
  const previous = electronProcess.noAsar;
  electronProcess.noAsar = true;
  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(electronProcess, "noAsar");
    } else {
      electronProcess.noAsar = previous;
    }
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "update";
}

function normalizeVersionSegment(value: string): string {
  const version = value.trim();
  if (version.length === 0) throw new Error("launcher payload version must not be empty");
  if (
    version !== value ||
    /[<>:"/\\|?*\x00-\x1f\s]/.test(version) ||
    version === "." ||
    version === ".." ||
    version.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(version)
  ) {
    throw new Error(`launcher payload version must be a safe path segment: ${value}`);
  }
  return version;
}

function assertAbsolutePath(path: string, label: string): string {
  if (path.includes("\0")) throw new Error(`${label} must not contain null bytes`);
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute: ${path}`);
  return resolve(path);
}

function expectedLauncherSevenZipPath(installRoot: string): string {
  return resolve(installRoot, "lib", SEVEN_ZIP_DIR_NAME, "7z.exe");
}

function expectedLauncherSevenZipDllPath(installRoot: string): string {
  return resolve(installRoot, "lib", SEVEN_ZIP_DIR_NAME, "7z.dll");
}

function expectedInstallRootPath(installRoot: string, ...segments: string[]): string {
  return resolve(installRoot, ...segments);
}

function assertExpectedInstallRootPath(actualPath: string, expectedPath: string, label: string): void {
  if (actualPath !== expectedPath) {
    throw new Error(`${label} must be the install-root path ${expectedPath}: ${actualPath}`);
  }
}

async function writeJsonAtomic(filePath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = join(dirname(filePath), `.${filePath.split(/[\\/]/).at(-1)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function observationFileTimestamp(date: Date): string {
  return date.toISOString().replace(/[^0-9A-Za-z._-]+/g, "-");
}

export async function writeLauncherOperationObservation(input: {
  details?: unknown;
  error?: string;
  installRoot: string;
  namespace: string;
  now?: () => Date;
  operation: LauncherOperation;
  status: LauncherOperationStatus;
}): Promise<LauncherOperationObservationWrite> {
  const now = input.now ?? (() => new Date());
  const createdAtDate = now();
  const installRoot = assertAbsolutePath(input.installRoot, "launcher install root");
  const observationRoot = join(installRoot, "logs", "updater");
  const summaryPath = join(
    observationRoot,
    `${observationFileTimestamp(createdAtDate)}-${input.operation}-${process.pid}-${randomUUID()}.json`,
  );
  const latestSummaryPath = join(observationRoot, `latest-${input.operation}.json`);
  if (!containsPath(installRoot, summaryPath)) throw new Error(`launcher observation path escaped install root: ${summaryPath}`);
  if (!containsPath(installRoot, latestSummaryPath)) throw new Error(`launcher latest observation path escaped install root: ${latestSummaryPath}`);
  const observation: LauncherOperationObservation = {
    createdAt: createdAtDate.toISOString(),
    ...(input.details === undefined ? {} : { details: input.details }),
    ...(input.error == null ? {} : { error: input.error }),
    installRoot,
    kind: LAUNCHER_OPERATION_OBSERVATION_KIND,
    namespace: input.namespace,
    operation: input.operation,
    schemaVersion: LAUNCHER_OPERATION_OBSERVATION_SCHEMA_VERSION,
    status: input.status,
  };
  await writeJsonAtomic(summaryPath, observation);
  await writeJsonAtomic(latestSummaryPath, observation);
  return { latestSummaryPath, summaryPath };
}

async function writeLauncherOperationObservationBestEffort(input: Parameters<typeof writeLauncherOperationObservation>[0]): Promise<LauncherOperationObservationWrite | null> {
  return await writeLauncherOperationObservation(input).catch(() => null);
}

async function extractWithSevenZip(input: {
  archivePath: string;
  destinationRoot: string;
  sevenZipPath: string;
}): Promise<void> {
  await execFileAsync(
    input.sevenZipPath,
    ["x", "-y", input.archivePath, `-o${input.destinationRoot}`],
    {
      cwd: dirname(input.sevenZipPath),
      windowsHide: true,
    },
  );
}

async function extractWithDitto(input: {
  archivePath: string;
  destinationRoot: string;
}): Promise<void> {
  await execFileAsync("ditto", ["-x", "-k", input.archivePath, input.destinationRoot], {
    windowsHide: true,
  });
}

async function copyLauncherVersionRoot(input: {
  destinationRoot: string;
  platform: string;
  sourceRoot: string;
}): Promise<void> {
  if (input.platform === "darwin" && process.platform === "darwin") {
    await execFileAsync("ditto", [input.sourceRoot, input.destinationRoot], {
      windowsHide: true,
    });
    return;
  }
  await cp(input.sourceRoot, input.destinationRoot, { recursive: true, verbatimSymlinks: true });
}

async function extractLauncherPayload(input: {
  archivePath: string;
  destinationRoot: string;
  platform: string;
  sevenZipPath?: string;
}): Promise<void> {
  if (input.platform === "win32") {
    if (input.sevenZipPath == null) throw new Error("launcher 7z path is required for Windows payload extraction");
    await extractWithSevenZip({
      archivePath: input.archivePath,
      destinationRoot: input.destinationRoot,
      sevenZipPath: input.sevenZipPath,
    });
    return;
  }
  if (input.platform === "darwin") {
    await extractWithDitto(input);
    return;
  }
  throw new Error(`launcher payload extraction is not supported on ${input.platform}`);
}

async function assertNormalFile(path: string, label: string): Promise<void> {
  const entry = await lstat(path).catch(() => null);
  if (entry == null || !entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`${label} is missing: ${path}`);
  }
}

async function assertStableSevenZipHelperClosure(input: {
  installRoot: string;
  sevenZipPath: string;
}): Promise<void> {
  await assertNormalFile(input.sevenZipPath, "launcher 7z helper");
  await assertNormalFile(expectedLauncherSevenZipDllPath(input.installRoot), "launcher 7z helper DLL");
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function windowsPayloadLayout(metadata: LauncherInstallMetadata): LauncherPayloadLayout {
  return {
    entryCwd: PAYLOAD_DIR_NAME,
    entryExecutable: `${PAYLOAD_DIR_NAME}/${PRODUCT_EXE_NAME}`,
    platform: "win32",
    selfUpdateExecutableName: launcherExecutableName(metadata),
  };
}

function macPayloadLayout(metadata: LauncherInstallMetadata): LauncherPayloadLayout {
  if (metadata.platform !== "darwin") throw new Error("mac launcher install metadata must declare platform darwin");
  const appBundleName = safeMacAppBundleName(stringField(metadata, "appBundleName") ?? "", "mac payload appBundleName");
  const executableName = safeMacPathSegment(stringField(metadata, "executableName") ?? "", "mac payload executableName");
  if (!isRecord(metadata.payload)) throw new Error("mac launcher install metadata is missing payload descriptor");
  if (metadata.payload.appBundleName !== appBundleName) {
    throw new Error("mac launcher install metadata payload appBundleName mismatch");
  }
  const payloadExecutableInApp = `Contents/MacOS/${executableName}`;
  if (metadata.payload.executable !== payloadExecutableInApp) {
    throw new Error("mac launcher install metadata payload executable mismatch");
  }
  return {
    appBundleName,
    entryCwd: `${PAYLOAD_DIR_NAME}/${appBundleName}`,
    entryExecutable: `${PAYLOAD_DIR_NAME}/${appBundleName}/${payloadExecutableInApp}`,
    executableName,
    payloadExecutableInApp,
    platform: "darwin",
  };
}

function payloadLayoutForApply(metadata: LauncherInstallMetadata, platform: string): LauncherPayloadLayout {
  if (platform === "darwin") return macPayloadLayout(metadata);
  return windowsPayloadLayout(metadata);
}

function launcherVersionDescriptor(version: string, layout: LauncherPayloadLayout): RuntimeVersionDescriptor {
  return {
    apps: {},
    entry: {
      args: [],
      cwd: layout.entryCwd,
      env: {},
      executable: layout.entryExecutable,
    },
    root: `${VERSIONS_DIR_NAME}/${version}`,
    version,
  };
}

function isMacRuntimeVersionDescriptorEntry(value: RuntimeVersionDescriptor): boolean {
  if (typeof value.entry.cwd !== "string") return false;
  const match = /^payload\/([^/]+\.app)\/Contents\/MacOS\/([^/]+)$/.exec(value.entry.executable);
  if (match?.[1] == null || match[2] == null) return false;
  try {
    const appBundleName = safeMacAppBundleName(match[1], "mac runtime appBundleName");
    safeMacPathSegment(match[2], "mac runtime executableName");
    return value.entry.cwd === `${PAYLOAD_DIR_NAME}/${appBundleName}`;
  } catch {
    return false;
  }
}

function isRuntimeVersionDescriptor(
  value: unknown,
  expectedLayout?: Pick<LauncherPayloadLayout, "entryCwd" | "entryExecutable">,
): value is RuntimeVersionDescriptor {
  if (!isRecord(value)) return false;
  if (typeof value.version !== "string" || value.version.length === 0) return false;
  if (typeof value.root !== "string" || value.root.length === 0) return false;
  if (!isRecord(value.entry)) return false;
  if (typeof value.entry.executable !== "string" || value.entry.executable.length === 0) return false;
  if (!Array.isArray(value.entry.args)) return false;
  if (!isRecord(value.entry.env)) return false;
  if (!isRecord(value.apps)) return false;
  try {
    const version = normalizeVersionSegment(value.version);
    if (value.root !== `${VERSIONS_DIR_NAME}/${version}`) return false;
    if (expectedLayout != null) {
      if (value.entry.executable !== expectedLayout.entryExecutable) return false;
      if (value.entry.cwd !== expectedLayout.entryCwd) return false;
      return true;
    }
    if (value.entry.executable === `${PAYLOAD_DIR_NAME}/${PRODUCT_EXE_NAME}` && value.entry.cwd === PAYLOAD_DIR_NAME) {
      return true;
    }
    return isMacRuntimeVersionDescriptorEntry(value as RuntimeVersionDescriptor);
  } catch {
    return false;
  }
}

function isRuntimeConfig(value: unknown, expectedLayout?: Pick<LauncherPayloadLayout, "entryCwd" | "entryExecutable">): value is RuntimeConfig {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 0) return false;
  if (typeof value.namespace !== "string" || value.namespace.length === 0) return false;
  if (value.namespaceRoot !== RUNTIME_NAMESPACE_ROOT) return false;
  return isRuntimeVersionDescriptor(value.active, expectedLayout) && isRuntimeVersionDescriptor(value.lastSuccessful, expectedLayout);
}

function isLauncherConfig(value: unknown): value is LauncherConfig {
  if (!isRecord(value) || value.schemaVersion !== LAUNCHER_CONFIG_SCHEMA_VERSION) return false;
  if (value.runtimePath !== RUNTIME_RELATIVE_PATH) return false;
  if (value.attemptPath != null && value.attemptPath !== ATTEMPT_RELATIVE_PATH) return false;
  return true;
}

function isCleanupMarker(value: unknown): value is LauncherCleanupMarker {
  if (!isRecord(value) || value.schemaVersion !== CLEANUP_MARKER_SCHEMA_VERSION) return false;
  if (value.strategy !== "lazyQuickDelete") return false;
  if (typeof value.namespace !== "string" || value.namespace.length === 0) return false;
  if (typeof value.readyVersion !== "string" || value.readyVersion.length === 0) return false;
  if (!Array.isArray(value.versions)) return false;
  return value.versions.every((entry) => (
    isRecord(entry) &&
    typeof entry.root === "string" &&
    entry.root.length > 0 &&
    typeof entry.version === "string" &&
    entry.version.length > 0
  ));
}

function payloadManifest(version: string, layout: LauncherPayloadLayout): LauncherPayloadManifest {
  return {
    ...(layout.appBundleName == null ? {} : { appBundleName: layout.appBundleName }),
    entry: {
      cwd: layout.entryCwd,
      executable: layout.entryExecutable,
    },
    payloadRoot: PAYLOAD_DIR_NAME,
    ...(layout.platform === "win32" ? {} : { platform: layout.platform }),
    schemaVersion: 1,
    version,
  };
}

async function assertVersionPayload(versionRoot: string, layout: LauncherPayloadLayout): Promise<void> {
  const payloadRoot = join(versionRoot, PAYLOAD_DIR_NAME);
  const executablePath = join(versionRoot, ...layout.entryExecutable.split("/"));
  const payload = await lstat(payloadRoot).catch(() => null);
  if (payload == null || !payload.isDirectory() || payload.isSymbolicLink()) {
    throw new Error(`launcher payload archive is missing ${PAYLOAD_DIR_NAME}/`);
  }
  const executable = await lstat(executablePath).catch(() => null);
  if (executable == null || !executable.isFile() || executable.isSymbolicLink()) {
    throw new Error(`launcher payload archive is missing ${layout.entryExecutable}`);
  }
}

async function assertNoVersionScopedSevenZip(versionRoot: string): Promise<void> {
  const entries = await readdir(versionRoot, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(versionRoot, entry.name);
    const lowerName = entry.name.toLowerCase();
    if (lowerName === "7z.exe" || lowerName === "7z.dll") {
      throw new Error(`launcher payload archive must not contain version-scoped 7z helper: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      await assertNoVersionScopedSevenZip(entryPath);
    }
  }
}

async function assertNoInstallRootLayerEntries(versionRoot: string): Promise<void> {
  const entries = await readdir(versionRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (INSTALL_ROOT_LAYER_VERSION_ENTRY_NAMES.has(entry.name.toLowerCase())) {
      throw new Error(`launcher payload archive must not contain install-root layer entry under version root: ${join(versionRoot, entry.name)}`);
    }
  }
}

async function assertSafePayloadSymlinks(root: string, platform: string, scanRoot = root): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      if (platform !== "darwin") throw new Error(`launcher payload archive must not contain symlinks: ${entryPath}`);
      const target = await readlink(entryPath);
      if (target.includes("\0") || isAbsolute(target)) {
        throw new Error(`mac launcher payload symlink must be relative: ${entryPath}`);
      }
      const resolvedTarget = resolve(dirname(entryPath), target);
      if (!containsPath(scanRoot, resolvedTarget)) {
        throw new Error(`mac launcher payload symlink escaped version root: ${entryPath}`);
      }
      const targetEntry = await lstat(resolvedTarget).catch(() => null);
      if (targetEntry == null) throw new Error(`mac launcher payload symlink target is missing: ${entryPath}`);
      continue;
    }
    if (entry.isDirectory()) await assertSafePayloadSymlinks(entryPath, platform, scanRoot);
  }
}

async function resolveExtractedVersionRoot(stagingRoot: string, version: string): Promise<string> {
  const candidates = [
    stagingRoot,
    join(stagingRoot, VERSIONS_DIR_NAME, version),
    join(stagingRoot, version),
  ];
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (!containsPath(stagingRoot, resolved)) continue;
    if (await pathExists(join(resolved, PAYLOAD_DIR_NAME))) return resolved;
  }
  throw new Error(`launcher payload archive must contain ${PAYLOAD_DIR_NAME}/ or ${VERSIONS_DIR_NAME}/${version}/${PAYLOAD_DIR_NAME}/`);
}

async function withInstallRootLock<T>(
  lockPath: string,
  owner: Record<string, unknown>,
  callback: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error(`launcher install root lock is already held at ${lockPath}`);
    throw error;
  }

  try {
    await writeJsonAtomic(join(lockPath, "owner.json"), owner);
    return await callback();
  } finally {
    await rm(lockPath, { force: true, recursive: true });
  }
}

async function assertInstallRootLockAvailable(lockPath: string): Promise<void> {
  try {
    await lstat(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw error;
  }
  throw new Error(`launcher install root lock is already held at ${lockPath}`);
}

async function removeAttemptMarker(attemptMarkerPath: string): Promise<boolean> {
  const existed = await pathExists(attemptMarkerPath);
  await rm(attemptMarkerPath, { force: true }).catch(() => undefined);
  return existed;
}

async function promoteVersionRoot(input: {
  finalVersionRoot: string;
  installRoot: string;
  layout: LauncherPayloadLayout;
  sourceVersionRoot: string;
  version: string;
  versionsRoot: string;
}): Promise<{ promoted: boolean; versionRoot: string }> {
  await mkdir(input.versionsRoot, { recursive: true });
  const existingFinal = await lstat(input.finalVersionRoot).catch(() => null);
  if (existingFinal != null) {
    if (!existingFinal.isDirectory() || existingFinal.isSymbolicLink()) {
      throw new Error(`launcher version target is not a directory: ${input.finalVersionRoot}`);
    }
    await assertSafePayloadSymlinks(input.finalVersionRoot, input.layout.platform);
    await assertNoInstallRootLayerEntries(input.finalVersionRoot);
    await assertVersionPayload(input.finalVersionRoot, input.layout);
    if (input.layout.platform === "win32") await assertNoVersionScopedSevenZip(input.finalVersionRoot);
    return { promoted: false, versionRoot: input.finalVersionRoot };
  }

  const temporaryVersionRoot = join(
    input.versionsRoot,
    `.incoming-${sanitizePathSegment(input.version)}-${process.pid}-${randomUUID()}`,
  );
  if (!containsPath(input.installRoot, temporaryVersionRoot)) {
    throw new Error(`temporary launcher version path escaped install root: ${temporaryVersionRoot}`);
  }
  try {
    await copyLauncherVersionRoot({
      destinationRoot: temporaryVersionRoot,
      platform: input.layout.platform,
      sourceRoot: input.sourceVersionRoot,
    });
    await rename(temporaryVersionRoot, input.finalVersionRoot);
    return { promoted: true, versionRoot: input.finalVersionRoot };
  } finally {
    await rm(temporaryVersionRoot, { force: true, recursive: true }).catch(() => undefined);
  }
}

async function updateRuntimeConfig(input: {
  currentRuntime: RuntimeConfig;
  layout: LauncherPayloadLayout;
  namespace: string;
  runtimeConfigPath: string;
  version: string;
}): Promise<{ previousVersion?: string }> {
  const active = launcherVersionDescriptor(input.version, input.layout);
  const nextRuntime = buildRuntimeConfig({
    active,
    generation: input.currentRuntime.generation + 1,
    lastSuccessful: input.currentRuntime.lastSuccessful,
    namespace: input.namespace,
    namespaceRoot: RUNTIME_NAMESPACE_ROOT,
  });
  await writeJsonAtomic(input.runtimeConfigPath, nextRuntime);
  return {
    previousVersion: input.currentRuntime.active.version,
  };
}

async function readInstallMetadata(installMetadataPath: string): Promise<LauncherInstallMetadata> {
  const existingMetadata = await readJson<unknown>(installMetadataPath);
  if (!isRecord(existingMetadata) || existingMetadata.schemaVersion !== INSTALL_METADATA_SCHEMA_VERSION) {
    throw new Error(`launcher install metadata is missing or invalid: ${installMetadataPath}`);
  }
  if (typeof existingMetadata.displayName !== "string" || existingMetadata.displayName.trim().length === 0) {
    throw new Error(`launcher install metadata is missing displayName: ${installMetadataPath}`);
  }
  return existingMetadata;
}

async function readRuntimeConfigForApply(input: {
  layout: LauncherPayloadLayout;
  namespace: string;
  runtimeConfigPath: string;
}): Promise<RuntimeConfig> {
  const existingRuntime = await readJson<unknown>(input.runtimeConfigPath);
  if (!isRuntimeConfig(existingRuntime, input.layout)) {
    throw new Error(`launcher runtime config is missing or invalid: ${input.runtimeConfigPath}`);
  }
  if (existingRuntime.namespace !== input.namespace) {
    throw new Error(`launcher runtime namespace mismatch: expected ${input.namespace}, got ${existingRuntime.namespace}`);
  }
  return existingRuntime;
}

async function readLauncherConfigForApply(launcherConfigPath: string): Promise<LauncherConfig> {
  const existingConfig = await readJson<unknown>(launcherConfigPath);
  if (!isLauncherConfig(existingConfig)) {
    throw new Error(`launcher config is missing or invalid: ${launcherConfigPath}`);
  }
  return existingConfig;
}

function assertInstallMetadataNamespace(input: {
  installMetadata: LauncherInstallMetadata;
  namespace: string;
}): void {
  if (typeof input.installMetadata.namespace === "string" && input.installMetadata.namespace !== input.namespace) {
    throw new Error(`launcher install metadata namespace mismatch: expected ${input.namespace}, got ${input.installMetadata.namespace}`);
  }
}

async function readLauncherApplyState(input: {
  installMetadataPath: string;
  launcherConfigPath: string;
  namespace: string;
  platform: string;
  runtimeConfigPath: string;
}): Promise<{
  currentRuntime: RuntimeConfig;
  installMetadata: LauncherInstallMetadata;
  launcherConfig: LauncherConfig;
  layout: LauncherPayloadLayout;
}> {
  const installMetadata = await readInstallMetadata(input.installMetadataPath);
  assertInstallMetadataNamespace({
    installMetadata,
    namespace: input.namespace,
  });
  const layout = payloadLayoutForApply(installMetadata, input.platform);
  const launcherConfig = await readLauncherConfigForApply(input.launcherConfigPath);
  return {
    currentRuntime: await readRuntimeConfigForApply({
      layout,
      namespace: input.namespace,
      runtimeConfigPath: input.runtimeConfigPath,
    }),
    installMetadata,
    launcherConfig,
    layout,
  };
}

function safeFileName(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} must not be empty`);
  if (
    trimmed !== value ||
    /[<>:"/\\|?*\x00-\x1f]/.test(trimmed) ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(trimmed)
  ) {
    throw new Error(`${label} must be a safe Windows file name: ${value}`);
  }
  return trimmed;
}

function safeMacPathSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} must not be empty`);
  if (trimmed !== value || /[/\\\x00-\x1f]/.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new Error(`${label} must be a safe mac path segment: ${value}`);
  }
  return trimmed;
}

function safeMacAppBundleName(value: string, label: string): string {
  const safe = safeMacPathSegment(value, label);
  if (!safe.endsWith(".app")) throw new Error(`${label} must be a mac .app bundle name: ${value}`);
  return safe;
}

function launcherExecutableName(metadata: LauncherInstallMetadata): string {
  if (typeof metadata.displayName === "string") {
    return safeFileName(`${metadata.displayName.trim()}.exe`, "launcher displayName");
  }
  throw new Error("launcher install metadata is missing displayName");
}

function normalizeInstallMetadataForApply(input: {
  existingMetadata: LauncherInstallMetadata;
  layout: LauncherPayloadLayout;
  namespace: string;
  version: string;
}): LauncherInstallMetadata {
  if (input.layout.platform === "darwin") {
    const launcher = isRecord(input.existingMetadata.launcher) ? { ...input.existingMetadata.launcher } : {};
    const payload = isRecord(input.existingMetadata.payload) ? { ...input.existingMetadata.payload } : {};
    return {
      ...input.existingMetadata,
      appBundleName: input.layout.appBundleName,
      currentVersion: input.version,
      executableName: input.layout.executableName,
      launcher: {
        ...launcher,
        appBundleName: input.layout.appBundleName,
        executableName: input.layout.executableName,
        rootDiscovery: "external",
      },
      namespace: typeof input.existingMetadata.namespace === "string" ? input.existingMetadata.namespace : input.namespace,
      payload: {
        ...payload,
        appBundleName: input.layout.appBundleName,
        executable: input.layout.payloadExecutableInApp,
      },
      platform: "darwin",
      runtimePath: RUNTIME_RELATIVE_PATH,
      schemaVersion: INSTALL_METADATA_SCHEMA_VERSION,
      versionsRoot: VERSIONS_DIR_NAME,
    };
  }
  const launcherName = input.layout.selfUpdateExecutableName ?? launcherExecutableName(input.existingMetadata);
  const helpers = isRecord(input.existingMetadata.helpers) ? { ...input.existingMetadata.helpers } : {};
  const launcher = isRecord(input.existingMetadata.launcher) ? { ...input.existingMetadata.launcher } : {};
  return {
    ...input.existingMetadata,
    currentVersion: input.version,
    exeName: launcherName,
    helpers: {
      ...helpers,
      sevenZip: SEVEN_ZIP_RELATIVE_PATH,
      sevenZipDll: SEVEN_ZIP_DLL_RELATIVE_PATH,
    },
    launcher: {
      ...launcher,
      executable: launcherName,
    },
    namespace: typeof input.existingMetadata.namespace === "string" ? input.existingMetadata.namespace : input.namespace,
    runtimePath: RUNTIME_RELATIVE_PATH,
    schemaVersion: INSTALL_METADATA_SCHEMA_VERSION,
    versionsRoot: VERSIONS_DIR_NAME,
  };
}

async function writeInstallMetadata(input: {
  existingMetadata: LauncherInstallMetadata;
  installMetadataPath: string;
  layout: LauncherPayloadLayout;
  namespace: string;
  version: string;
}): Promise<void> {
  await writeJsonAtomic(input.installMetadataPath, normalizeInstallMetadataForApply(input));
}

async function assertLauncherSelfUpdateCandidateShape(input: {
  executableName: string;
  versionRoot: string;
}): Promise<void> {
  const candidatePath = join(input.versionRoot, LAUNCHER_DIR_NAME, input.executableName);
  if (!containsPath(input.versionRoot, candidatePath)) {
    throw new Error(`launcher self-update candidate escaped version root: ${candidatePath}`);
  }
  const candidate = await lstat(candidatePath).catch(() => null);
  if (candidate == null) return;
  if (!candidate.isFile() || candidate.isSymbolicLink()) {
    throw new Error(`launcher self-update candidate is not a normal file: ${candidatePath}`);
  }
}

async function resolvePromotedLauncherSelfUpdate(input: {
  executableName: string;
  installRoot: string;
  versionRoot: string;
}): Promise<Pick<LauncherPayloadApplyResult, "launcherSelfUpdateCandidatePath" | "launcherSelfUpdateTargetPath">> {
  const candidatePath = join(input.versionRoot, LAUNCHER_DIR_NAME, input.executableName);
  const candidate = await lstat(candidatePath).catch(() => null);
  if (candidate == null) return {};
  if (!containsPath(input.installRoot, candidatePath)) {
    throw new Error(`launcher self-update candidate escaped install root: ${candidatePath}`);
  }
  if (!candidate.isFile() || candidate.isSymbolicLink()) {
    throw new Error(`launcher self-update candidate is not a normal file: ${candidatePath}`);
  }
  const targetPath = join(input.installRoot, input.executableName);
  if (!containsPath(input.installRoot, targetPath)) {
    throw new Error(`launcher self-update target escaped install root: ${targetPath}`);
  }
  return {
    launcherSelfUpdateCandidatePath: candidatePath,
    launcherSelfUpdateTargetPath: targetPath,
  };
}

export async function applyLauncherPayloadArchive(input: LauncherPayloadApplyInput): Promise<LauncherPayloadApplyResult> {
  const now = input.now ?? (() => new Date());
  const platform = input.platform ?? "win32";
  const version = normalizeVersionSegment(input.version);
  const installRoot = assertAbsolutePath(input.installRoot, "launcher install root");
  const updateRoot = assertAbsolutePath(input.updateRoot, "update root");
  const archivePath = assertAbsolutePath(input.archivePath, "launcher payload archive path");
  const lockPath = assertAbsolutePath(input.lockPath, "launcher install lock path");
  const runtimeConfigPath = assertAbsolutePath(input.runtimeConfigPath, "launcher runtime config path");
  const sevenZipPath = input.sevenZipPath == null ? null : assertAbsolutePath(input.sevenZipPath, "launcher 7z path");
  const installMetadataPath = assertAbsolutePath(input.installMetadataPath, "launcher install metadata path");
  const launcherConfigPath = assertAbsolutePath(input.launcherConfigPath, "launcher config path");

  if (!containsPath(updateRoot, archivePath)) throw new Error(`launcher payload archive escaped update root: ${archivePath}`);
  if (!containsPath(installRoot, lockPath)) throw new Error(`launcher lock path escaped install root: ${lockPath}`);
  if (!containsPath(installRoot, runtimeConfigPath)) throw new Error(`launcher runtime config path escaped install root: ${runtimeConfigPath}`);
  if (sevenZipPath != null && !containsPath(installRoot, sevenZipPath)) throw new Error(`launcher 7z path escaped install root: ${sevenZipPath}`);
  if (!containsPath(installRoot, installMetadataPath)) throw new Error(`launcher install metadata path escaped install root: ${installMetadataPath}`);
  if (!containsPath(installRoot, launcherConfigPath)) throw new Error(`launcher config path escaped install root: ${launcherConfigPath}`);
  assertExpectedInstallRootPath(lockPath, expectedInstallRootPath(installRoot, "state", "lock"), "launcher lock path");
  assertExpectedInstallRootPath(runtimeConfigPath, expectedInstallRootPath(installRoot, RUNTIME_RELATIVE_PATH), "launcher runtime config path");
  assertExpectedInstallRootPath(installMetadataPath, expectedInstallRootPath(installRoot, "install.json"), "launcher install metadata path");
  assertExpectedInstallRootPath(launcherConfigPath, expectedInstallRootPath(installRoot, "launcher.json"), "launcher config path");
  if (platform === "win32" && sevenZipPath == null) throw new Error("launcher 7z path is required for Windows payload apply");
  if (platform === "win32" && sevenZipPath != null) {
    const expectedSevenZipPath = expectedLauncherSevenZipPath(installRoot);
    if (sevenZipPath !== expectedSevenZipPath) {
      throw new Error(`launcher 7z path must be the stable launcher helper at ${expectedSevenZipPath}: ${sevenZipPath}`);
    }
  }
  if (platform === "win32" && input.extractor == null && sevenZipPath != null) {
    await assertStableSevenZipHelperClosure({ installRoot, sevenZipPath });
  }

  await assertInstallRootLockAvailable(lockPath);
  const initialApplyState = await readLauncherApplyState({
    installMetadataPath,
    launcherConfigPath,
    namespace: input.namespace,
    platform,
    runtimeConfigPath,
  });

  const stagingRoot = join(updateRoot, "staging", `launcher-apply-${sanitizePathSegment(version)}-${process.pid}-${randomUUID()}`);
  if (!containsPath(updateRoot, stagingRoot)) throw new Error(`launcher apply staging path escaped update root: ${stagingRoot}`);

  return await withAsarFileSystemDisabled(async () => {
    try {
      await mkdir(stagingRoot, { recursive: true });
      await (input.extractor ?? extractLauncherPayload)({
        archivePath,
        destinationRoot: stagingRoot,
        platform,
        ...(sevenZipPath == null ? {} : { sevenZipPath }),
      });
      const extractedVersionRoot = await resolveExtractedVersionRoot(stagingRoot, version);
      await assertSafePayloadSymlinks(extractedVersionRoot, initialApplyState.layout.platform);
      await assertNoInstallRootLayerEntries(extractedVersionRoot);
      await assertVersionPayload(extractedVersionRoot, initialApplyState.layout);
      if (initialApplyState.layout.platform === "win32") await assertNoVersionScopedSevenZip(extractedVersionRoot);

      const versionsRoot = join(installRoot, VERSIONS_DIR_NAME);
      const finalVersionRoot = join(versionsRoot, version);
      if (!containsPath(installRoot, finalVersionRoot)) {
        throw new Error(`launcher version path escaped install root: ${finalVersionRoot}`);
      }
      const appliedAt = now().toISOString();
      const result = await withInstallRootLock(lockPath, {
        namespace: input.namespace,
        operation: "apply-update",
        pid: process.pid,
        schemaVersion: INSTALL_LOCK_OWNER_SCHEMA_VERSION,
        startedAt: appliedAt,
      }, async () => {
        const {
          currentRuntime,
          installMetadata: existingInstallMetadata,
          layout,
        } = await readLauncherApplyState({
          installMetadataPath,
          launcherConfigPath,
          namespace: input.namespace,
          platform,
          runtimeConfigPath,
        });
        await assertVersionPayload(extractedVersionRoot, layout);
        await assertSafePayloadSymlinks(extractedVersionRoot, layout.platform);
        if (layout.platform === "win32") await assertNoVersionScopedSevenZip(extractedVersionRoot);
        await writeJsonAtomic(join(extractedVersionRoot, "manifest.json"), payloadManifest(version, layout));
        if (layout.selfUpdateExecutableName != null) {
          await assertLauncherSelfUpdateCandidateShape({
            executableName: layout.selfUpdateExecutableName,
            versionRoot: extractedVersionRoot,
          });
        }
        const promoted = await promoteVersionRoot({
          finalVersionRoot,
          installRoot,
          layout,
          sourceVersionRoot: extractedVersionRoot,
          version,
          versionsRoot,
        });
        const launcherSelfUpdate = layout.selfUpdateExecutableName == null
          ? {}
          : await resolvePromotedLauncherSelfUpdate({
            executableName: layout.selfUpdateExecutableName,
            installRoot,
            versionRoot: promoted.versionRoot,
          });
        const runtime = await updateRuntimeConfig({
          currentRuntime,
          layout,
          namespace: input.namespace,
          runtimeConfigPath,
          version,
        });
        await writeInstallMetadata({
          existingMetadata: existingInstallMetadata,
          installMetadataPath,
          layout,
          namespace: input.namespace,
          version,
        });
        return {
          appliedAt,
          installMetadataPath,
          launcherConfigPath,
          ...launcherSelfUpdate,
          payloadRoot: join(promoted.versionRoot, PAYLOAD_DIR_NAME),
          ...(runtime.previousVersion == null ? {} : { previousVersion: runtime.previousVersion }),
          promoted: promoted.promoted,
          runtimeConfigPath,
          version,
          versionRoot: promoted.versionRoot,
        };
      });
      const observation = await writeLauncherOperationObservationBestEffort({
        details: {
          archivePath,
          installMetadataPath: result.installMetadataPath,
          launcherConfigPath: result.launcherConfigPath,
          ...(result.launcherSelfUpdateCandidatePath == null ? {} : {
            launcherSelfUpdateCandidatePath: result.launcherSelfUpdateCandidatePath,
            launcherSelfUpdateTargetPath: result.launcherSelfUpdateTargetPath,
          }),
          promoted: result.promoted,
          runtimeConfigPath: result.runtimeConfigPath,
          version: result.version,
          versionRoot: result.versionRoot,
        },
        installRoot,
        namespace: input.namespace,
        now,
        operation: "payload-apply",
        status: "ok",
      });
      return {
        ...result,
        ...(observation == null ? {} : observation),
      };
    } finally {
      await rm(stagingRoot, { force: true, recursive: true }).catch(() => undefined);
    }
  });
}

export function buildReadyCleanupMarker(input: {
  deleteVersions: readonly string[];
  namespace: string;
  readyVersion: string;
}, now = new Date()): Record<string, unknown> {
  const readyVersion = normalizeVersionSegment(input.readyVersion);
  const versions = [
    ...new Set(
      input.deleteVersions
        .filter((version) => version.trim().length > 0)
        .map((version) => normalizeVersionSegment(version)),
    ),
  ];
  if (versions.includes(readyVersion)) {
    throw new Error(`cleanup marker must not delete the ready version: ${readyVersion}`);
  }
  return {
    createdAt: now.toISOString(),
    namespace: input.namespace,
    readyVersion,
    schemaVersion: CLEANUP_MARKER_SCHEMA_VERSION,
    strategy: "lazyQuickDelete",
    versions: versions.map((version) => ({
      root: `${VERSIONS_DIR_NAME}/${version}`,
      version,
    })),
  };
}

async function collectReadyCleanupVersions(input: {
  installRoot: string;
  readyVersion: string;
}): Promise<string[]> {
  const versionsRoot = join(input.installRoot, VERSIONS_DIR_NAME);
  const entries = await readdir(versionsRoot, { withFileTypes: true }).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  });
  const readyVersion = normalizeVersionSegment(input.readyVersion);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => normalizeVersionSegment(entry.name))
    .filter((version) => version !== readyVersion)
    .sort((left, right) => left.localeCompare(right));
}

export async function confirmLauncherPayloadReady(input: LauncherPayloadReadyInput): Promise<LauncherPayloadReadyResult> {
  const now = input.now ?? (() => new Date());
  const readyVersion = normalizeVersionSegment(input.version);
  const installRoot = assertAbsolutePath(input.installRoot, "launcher install root");
  const lockPath = assertAbsolutePath(input.lockPath, "launcher install lock path");
  const runtimeConfigPath = assertAbsolutePath(input.runtimeConfigPath, "launcher runtime config path");
  const cleanupMarkerPath = assertAbsolutePath(input.cleanupMarkerPath, "launcher cleanup marker path");
  const attemptMarkerPath = join(installRoot, "state", "attempt.json");

  if (!containsPath(installRoot, lockPath)) throw new Error(`launcher lock path escaped install root: ${lockPath}`);
  if (!containsPath(installRoot, runtimeConfigPath)) throw new Error(`launcher runtime config path escaped install root: ${runtimeConfigPath}`);
  if (!containsPath(installRoot, cleanupMarkerPath)) throw new Error(`launcher cleanup marker path escaped install root: ${cleanupMarkerPath}`);
  if (!containsPath(installRoot, attemptMarkerPath)) throw new Error(`launcher attempt marker path escaped install root: ${attemptMarkerPath}`);
  assertExpectedInstallRootPath(lockPath, expectedInstallRootPath(installRoot, "state", "lock"), "launcher lock path");
  assertExpectedInstallRootPath(runtimeConfigPath, expectedInstallRootPath(installRoot, RUNTIME_RELATIVE_PATH), "launcher runtime config path");
  assertExpectedInstallRootPath(cleanupMarkerPath, expectedInstallRootPath(installRoot, "state", "cleanup.json"), "launcher cleanup marker path");

  const confirmedAt = now().toISOString();
  const result = await withInstallRootLock<LauncherPayloadReadyResult>(lockPath, {
    namespace: input.namespace,
    operation: "ready",
    pid: process.pid,
    schemaVersion: INSTALL_LOCK_OWNER_SCHEMA_VERSION,
    startedAt: confirmedAt,
  }, async () => {
    const existingRuntime = await readJson<unknown>(runtimeConfigPath);
    if (!isRuntimeConfig(existingRuntime)) {
      throw new Error(`launcher runtime config is missing or invalid: ${runtimeConfigPath}`);
    }
    if (existingRuntime.namespace !== input.namespace) {
      throw new Error(`launcher runtime namespace mismatch: expected ${input.namespace}, got ${existingRuntime.namespace}`);
    }
    if (existingRuntime.active.version !== readyVersion) {
      return {
        ...(existingRuntime.active.version.length === 0 ? {} : { activeVersion: existingRuntime.active.version }),
        ok: false,
        readyVersion,
        reason: "active-version-mismatch",
        runtimeConfigPath,
      };
    }

    const deleteVersions = await collectReadyCleanupVersions({
      installRoot,
      readyVersion,
    });
    const advancedLastSuccessful = existingRuntime.lastSuccessful.version !== readyVersion;
    if (advancedLastSuccessful) {
      await writeJsonAtomic(runtimeConfigPath, buildRuntimeConfig({
        active: existingRuntime.active,
        generation: existingRuntime.generation,
        lastSuccessful: existingRuntime.active,
        namespace: existingRuntime.namespace,
        namespaceRoot: RUNTIME_NAMESPACE_ROOT,
      }));
    }
    const deletedAttemptMarker = await removeAttemptMarker(attemptMarkerPath);

    if (deleteVersions.length > 0) {
      await writeJsonAtomic(
        cleanupMarkerPath,
        buildReadyCleanupMarker({
          deleteVersions,
          namespace: input.namespace,
          readyVersion,
        }, now()),
      );
    }

    return {
      advancedLastSuccessful,
      attemptMarkerPath,
      ...(deleteVersions.length === 0 ? {} : { cleanupMarkerPath }),
      deletedAttemptMarker,
      deleteVersions,
      ok: true,
      readyVersion,
      runtimeConfigPath,
    };
  });
  const observation = await writeLauncherOperationObservationBestEffort({
    details: result,
    installRoot,
    namespace: input.namespace,
    now,
    operation: "ready",
    status: result.ok ? "ok" : "skipped",
  });
  return {
    ...result,
    ...(observation == null ? {} : observation),
  };
}

export async function runLauncherCleanupMarker(input: LauncherCleanupInput): Promise<LauncherCleanupResult> {
  const now = input.now ?? (() => new Date());
  const installRoot = assertAbsolutePath(input.installRoot, "launcher install root");
  const lockPath = assertAbsolutePath(input.lockPath, "launcher install lock path");
  const runtimeConfigPath = assertAbsolutePath(input.runtimeConfigPath, "launcher runtime config path");
  const cleanupMarkerPath = assertAbsolutePath(input.cleanupMarkerPath, "launcher cleanup marker path");

  if (!containsPath(installRoot, lockPath)) throw new Error(`launcher lock path escaped install root: ${lockPath}`);
  if (!containsPath(installRoot, runtimeConfigPath)) throw new Error(`launcher runtime config path escaped install root: ${runtimeConfigPath}`);
  if (!containsPath(installRoot, cleanupMarkerPath)) throw new Error(`launcher cleanup marker path escaped install root: ${cleanupMarkerPath}`);
  assertExpectedInstallRootPath(lockPath, expectedInstallRootPath(installRoot, "state", "lock"), "launcher lock path");
  assertExpectedInstallRootPath(runtimeConfigPath, expectedInstallRootPath(installRoot, RUNTIME_RELATIVE_PATH), "launcher runtime config path");
  assertExpectedInstallRootPath(cleanupMarkerPath, expectedInstallRootPath(installRoot, "state", "cleanup.json"), "launcher cleanup marker path");
  return await withAsarFileSystemDisabled(async () => {
    if (!(await pathExists(cleanupMarkerPath))) {
      return {
        cleanupMarkerPath,
        ok: false,
        reason: "marker-missing",
      };
    }

    const startedAt = now().toISOString();
    const result = await withInstallRootLock<Extract<LauncherCleanupResult, { ok: true }>>(lockPath, {
      namespace: input.namespace,
      operation: "cleanup",
      pid: process.pid,
      schemaVersion: INSTALL_LOCK_OWNER_SCHEMA_VERSION,
      startedAt,
    }, async () => {
      const marker = await readJson<unknown>(cleanupMarkerPath);
      if (!isCleanupMarker(marker)) {
        throw new Error(`launcher cleanup marker is missing or invalid: ${cleanupMarkerPath}`);
      }
      if (marker.namespace !== input.namespace) {
        throw new Error(`launcher cleanup marker namespace mismatch: expected ${input.namespace}, got ${marker.namespace}`);
      }
      const existingRuntime = await readJson<unknown>(runtimeConfigPath);
      if (!isRuntimeConfig(existingRuntime)) {
        throw new Error(`launcher runtime config is missing or invalid: ${runtimeConfigPath}`);
      }
      if (existingRuntime.namespace !== input.namespace) {
        throw new Error(`launcher runtime namespace mismatch: expected ${input.namespace}, got ${existingRuntime.namespace}`);
      }

      const readyVersion = normalizeVersionSegment(marker.readyVersion);
      const protectedVersionSet = new Set([
        existingRuntime.active.version,
        existingRuntime.lastSuccessful.version,
        readyVersion,
      ]);
      const deletedVersions: string[] = [];
      const failedVersions: Array<{ error: string; version: string }> = [];
      const protectedVersions: string[] = [];
      const remainingVersions: string[] = [];
      const seen = new Set<string>();

      for (const entry of marker.versions) {
        const version = normalizeVersionSegment(entry.version);
        if (seen.has(version)) continue;
        seen.add(version);
        const expectedRoot = `${VERSIONS_DIR_NAME}/${version}`;
        if (entry.root !== expectedRoot) {
          throw new Error(`launcher cleanup marker root mismatch for ${version}: expected ${expectedRoot}, got ${entry.root}`);
        }
        if (protectedVersionSet.has(version)) {
          protectedVersions.push(version);
          remainingVersions.push(version);
          continue;
        }

        const versionRoot = resolve(installRoot, expectedRoot);
        if (!containsPath(installRoot, versionRoot)) {
          throw new Error(`launcher cleanup version path escaped install root: ${versionRoot}`);
        }
        const existingRoot = await lstat(versionRoot).catch(() => null);
        if (existingRoot != null && (!existingRoot.isDirectory() || existingRoot.isSymbolicLink())) {
          failedVersions.push({ error: `version root is not a normal directory: ${versionRoot}`, version });
          remainingVersions.push(version);
          continue;
        }
        try {
          await rm(versionRoot, { force: true, recursive: true });
          deletedVersions.push(version);
        } catch (cleanupError) {
          failedVersions.push({ error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError), version });
          remainingVersions.push(version);
        }
      }

      if (remainingVersions.length === 0) {
        await rm(cleanupMarkerPath, { force: true });
      } else {
        await writeJsonAtomic(
          cleanupMarkerPath,
          buildReadyCleanupMarker({
            deleteVersions: remainingVersions,
            namespace: input.namespace,
            readyVersion,
          }, now()),
        );
      }

      return {
        cleanupMarkerPath,
        deletedVersions,
        failedVersions,
        ok: true,
        protectedVersions,
        remainingVersions,
      };
    });
    const observation = await writeLauncherOperationObservationBestEffort({
      details: result,
      installRoot,
      namespace: input.namespace,
      now,
      operation: "cleanup",
      status: result.failedVersions.length > 0 || result.protectedVersions.length > 0 ? "skipped" : "ok",
    });
    return {
      ...result,
      ...(observation == null ? {} : observation),
    };
  });
}
