import { lstatSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";

type PathApi = Pick<typeof win32, "basename" | "dirname" | "isAbsolute" | "join" | "relative" | "resolve">;

export type PackagedLauncherInstallContextOptions = {
  pathIsFile?: (path: string) => boolean;
  namespace?: string;
  pathExists?: (path: string) => boolean;
  readTextFile?: (path: string) => string;
  requireInstallRootMarkers?: boolean;
};

export type PackagedLauncherInstallContext = {
  cleanupMarkerPath: string;
  installMetadataPath: string;
  launcherConfigPath: string;
  installRoot: string;
  lockPath: string;
  payloadAppPath?: string;
  payloadRoot: string;
  platform?: "darwin";
  runtimeConfigPath: string;
  sevenZipDllPath?: string;
  sevenZipPath?: string;
  version: string;
  versionRoot: string;
};

export type PackagedLauncherRuntimeSelectionSlot = "active" | "lastSuccessful";

export type PackagedLauncherRuntimeTarget = {
  attemptMarkerPath?: string;
  context: PackagedLauncherInstallContext;
  cwd: string;
  executablePath: string;
  generation: number;
  selection: PackagedLauncherRuntimeSelectionSlot;
  version: string;
};

type LauncherInstallMetadata = {
  currentVersion?: unknown;
  displayName?: unknown;
  exeName?: unknown;
  helpers?: unknown;
  launcher?: unknown;
  namespace?: unknown;
  runtimePath?: unknown;
  schemaVersion?: unknown;
  versionsRoot?: unknown;
};

type LauncherConfig = {
  attemptPath?: unknown;
  runtimePath?: unknown;
  schemaVersion?: unknown;
};

type RuntimeVersionDescriptor = {
  apps: Record<string, unknown>;
  entry: Record<string, unknown>;
  root: string;
  version: string;
};

type RuntimeConfig = {
  active: RuntimeVersionDescriptor;
  generation: number;
  lastSuccessful: RuntimeVersionDescriptor;
  namespace: string;
  namespaceRoot: string;
  schemaVersion: 1;
};

type RuntimeAttempt = {
  generation?: unknown;
  schemaVersion?: unknown;
  version?: unknown;
};

const RUNTIME_ATTEMPT_SCHEMA_VERSION = 1;
const RUNTIME_NAMESPACE_ROOT = ".";
const SEVEN_ZIP_RELATIVE_PATH = "lib/7z/7z.exe";
const SEVEN_ZIP_DLL_RELATIVE_PATH = "lib/7z/7z.dll";
const MAC_PLATFORM = "darwin";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function containsPath(path: PathApi, root: string, target: string): boolean {
  const relativePath = path.relative(root, target);
  return relativePath === "" || (relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function readJsonMarker(path: string, options: PackagedLauncherInstallContextOptions): unknown {
  try {
    const readTextFile = options.readTextFile ?? ((filePath: string) => readFileSync(filePath, "utf8"));
    return JSON.parse(readTextFile(path)) as unknown;
  } catch {
    return null;
  }
}

function defaultPathIsFile(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function installRootMarkerExists(path: string, options: PackagedLauncherInstallContextOptions): boolean {
  if (options.pathIsFile != null) return options.pathIsFile(path);
  if (options.pathExists != null) return options.pathExists(path);
  return defaultPathIsFile(path);
}

function safeFileName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (
    trimmed !== value ||
    /[<>:"/\\|?*\x00-\x1f]/.test(trimmed) ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function safeMacPathSegment(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed !== value || /[/\\\x00-\x1f]/.test(trimmed) || trimmed === "." || trimmed === "..") {
    return null;
  }
  return trimmed;
}

function safeMacAppBundleName(value: string): string | null {
  const safe = safeMacPathSegment(value);
  if (safe == null || !safe.endsWith(".app")) return null;
  return safe;
}

function normalizeVersionSegment(value: string): string | null {
  const version = value.trim();
  if (version.length === 0) return null;
  if (
    version !== value ||
    /[<>:"/\\|?*\x00-\x1f\s]/.test(version) ||
    version === "." ||
    version === ".." ||
    version.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(version)
  ) {
    return null;
  }
  return version;
}

function launcherExecutableName(metadata: LauncherInstallMetadata): string | null {
  if (typeof metadata.displayName === "string") return safeFileName(`${metadata.displayName.trim()}.exe`);
  return null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isExpectedInstallMetadata(value: unknown, options: PackagedLauncherInstallContextOptions): value is LauncherInstallMetadata {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.currentVersion !== "string" || value.currentVersion.length === 0) return false;
  if (typeof value.displayName !== "string" || value.displayName.trim().length === 0) return false;
  if (value.runtimePath !== "runtime.json") return false;
  if (value.versionsRoot !== "versions") return false;
  if (options.namespace != null && value.namespace !== options.namespace) return false;
  if (typeof value.namespace !== "string" || value.namespace.length === 0) return false;
  if (
    !isRecord(value.helpers) ||
    value.helpers.sevenZip !== SEVEN_ZIP_RELATIVE_PATH ||
    value.helpers.sevenZipDll !== SEVEN_ZIP_DLL_RELATIVE_PATH
  ) {
    return false;
  }
  return launcherExecutableName(value) != null;
}

function isExpectedMacInstallMetadata(
  value: unknown,
  options: PackagedLauncherInstallContextOptions,
  payloadAppName: string,
  payloadExecutableName: string,
): value is LauncherInstallMetadata {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.currentVersion !== "string" || value.currentVersion.length === 0) return false;
  if (typeof value.displayName !== "string" || value.displayName.trim().length === 0) return false;
  if (value.runtimePath !== "runtime.json") return false;
  if (value.versionsRoot !== "versions") return false;
  if (value.platform !== MAC_PLATFORM) return false;
  if (options.namespace != null && value.namespace !== options.namespace) return false;
  if (typeof value.namespace !== "string" || value.namespace.length === 0) return false;
  if (stringField(value, "appBundleName") !== payloadAppName) return false;
  if (stringField(value, "executableName") !== payloadExecutableName) return false;
  if (safeMacAppBundleName(payloadAppName) == null) return false;
  if (safeMacPathSegment(payloadExecutableName) == null) return false;
  if (!isRecord(value.payload)) return false;
  if (value.payload.appBundleName !== payloadAppName) return false;
  if (value.payload.executable !== `Contents/MacOS/${payloadExecutableName}`) return false;
  if (!isRecord(value.launcher)) return false;
  if (value.launcher.appBundleName !== payloadAppName) return false;
  if (value.launcher.executableName !== payloadExecutableName) return false;
  if (value.launcher.rootDiscovery !== "external") return false;
  return true;
}

function isExpectedLauncherConfig(value: unknown): value is LauncherConfig {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (value.runtimePath !== "runtime.json") return false;
  if (value.attemptPath != null && value.attemptPath !== "state/attempt.json") return false;
  return true;
}

function isRuntimeVersionDescriptorForEntry(
  value: unknown,
  expectedCwd: string,
  expectedExecutable: string,
): value is RuntimeVersionDescriptor {
  if (!isRecord(value)) return false;
  if (typeof value.version !== "string" || value.version.length === 0) return false;
  if (typeof value.root !== "string" || value.root.length === 0) return false;
  if (!isRecord(value.entry)) return false;
  if (typeof value.entry.executable !== "string" || value.entry.executable.length === 0) return false;
  if (!Array.isArray(value.entry.args)) return false;
  if (!isRecord(value.entry.env)) return false;
  if (!isRecord(value.apps)) return false;
  const version = normalizeVersionSegment(value.version);
  if (version == null) return false;
  return (
    value.root === `versions/${version}` &&
    value.entry.cwd === expectedCwd &&
    value.entry.executable === expectedExecutable
  );
}

function isExpectedRuntimeConfig(
  value: unknown,
  options: PackagedLauncherInstallContextOptions,
  expectedCwd: string,
  expectedExecutable: string,
): value is RuntimeConfig {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 0) return false;
  if (options.namespace != null && value.namespace !== options.namespace) return false;
  if (typeof value.namespace !== "string" || value.namespace.length === 0) return false;
  if (value.namespaceRoot !== RUNTIME_NAMESPACE_ROOT) return false;
  return (
    isRuntimeVersionDescriptorForEntry(value.active, expectedCwd, expectedExecutable) &&
    isRuntimeVersionDescriptorForEntry(value.lastSuccessful, expectedCwd, expectedExecutable)
  );
}

function isRuntimeVersionForContext(
  descriptor: RuntimeVersionDescriptor,
  context: PackagedLauncherInstallContext,
  expectedCwd: string,
  expectedExecutable: string,
): boolean {
  return (
    descriptor.version === context.version &&
    descriptor.root === `versions/${context.version}` &&
    descriptor.entry.executable === expectedExecutable &&
    descriptor.entry.cwd === expectedCwd
  );
}

function cleanRuntimeRelativeParts(path: PathApi, value: unknown): string[] | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith("\\\\")) return null;
  const parts = value.split(/[\\/]/);
  if (parts.length === 0 || parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return parts;
}

function runtimeTargetForDescriptor(
  path: PathApi,
  installRoot: string,
  descriptor: unknown,
  options: PackagedLauncherInstallContextOptions,
  selection: PackagedLauncherRuntimeSelectionSlot,
  runtimeConfig: RuntimeConfig,
  attemptMarkerPath: string | null,
): PackagedLauncherRuntimeTarget | null {
  if (!isRecord(descriptor) || !isRecord(descriptor.entry)) return null;
  const version = typeof descriptor.version === "string" ? normalizeVersionSegment(descriptor.version) : null;
  if (version == null) return null;
  const rootParts = cleanRuntimeRelativeParts(path, descriptor.root);
  const cwdParts = cleanRuntimeRelativeParts(path, descriptor.entry.cwd);
  const executableParts = cleanRuntimeRelativeParts(path, descriptor.entry.executable);
  if (rootParts == null || cwdParts == null || executableParts == null) return null;

  const versionRoot = path.resolve(installRoot, ...rootParts);
  const cwd = path.resolve(versionRoot, ...cwdParts);
  const executablePath = path.resolve(versionRoot, ...executableParts);
  if (!containsPath(path, installRoot, versionRoot) || !containsPath(path, installRoot, cwd) || !containsPath(path, installRoot, executablePath)) {
    return null;
  }

  const context = resolvePackagedLauncherInstallContext(executablePath, options);
  if (context == null || context.installRoot !== installRoot || context.version !== version) return null;
  return {
    ...(attemptMarkerPath == null ? {} : { attemptMarkerPath }),
    context,
    cwd,
    executablePath,
    generation: runtimeConfig.generation,
    selection,
    version,
  };
}

function resolveRuntimeAttemptMarkerPath(path: PathApi, installRoot: string, launcherConfig: LauncherConfig): string | null {
  if (launcherConfig.attemptPath == null) return null;
  const attemptParts = cleanRuntimeRelativeParts(path, launcherConfig.attemptPath);
  if (attemptParts == null) return null;
  const attemptMarkerPath = path.resolve(installRoot, ...attemptParts);
  return containsPath(path, installRoot, attemptMarkerPath) ? attemptMarkerPath : null;
}

function isRuntimeConfig(value: unknown): value is RuntimeConfig {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.generation === "number" &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 0 &&
    isRecord(value.active) &&
    isRecord(value.lastSuccessful)
  );
}

function runtimeAttemptMatchesActive(attempt: unknown, runtimeConfig: RuntimeConfig): boolean {
  return (
    isRecord(attempt) &&
    attempt.schemaVersion === RUNTIME_ATTEMPT_SCHEMA_VERSION &&
    attempt.generation === runtimeConfig.generation &&
    attempt.version === runtimeConfig.active.version
  );
}

export function resolvePackagedLauncherRuntimeTarget(
  installRoot: string,
  options: PackagedLauncherInstallContextOptions = {},
): PackagedLauncherRuntimeTarget | null {
  const path = installRoot.includes("\\") || /^[A-Za-z]:/.test(installRoot) ? win32 : posix;
  const resolvedInstallRoot = path.resolve(installRoot);
  const runtimeConfigPath = path.join(resolvedInstallRoot, "runtime.json");
  const runtimeConfig = readJsonMarker(runtimeConfigPath, options);
  if (!isRuntimeConfig(runtimeConfig)) return null;

  const launcherConfig = readJsonMarker(path.join(resolvedInstallRoot, "launcher.json"), options);
  const attemptMarkerPath = isExpectedLauncherConfig(launcherConfig)
    ? resolveRuntimeAttemptMarkerPath(path, resolvedInstallRoot, launcherConfig)
    : null;
  const attempt = attemptMarkerPath == null ? null : readJsonMarker(attemptMarkerPath, options);
  const activeAlreadyAttempted = runtimeAttemptMatchesActive(attempt, runtimeConfig);

  return (
    (activeAlreadyAttempted ? null : runtimeTargetForDescriptor(
      path,
      resolvedInstallRoot,
      runtimeConfig.active,
      options,
      "active",
      runtimeConfig,
      attemptMarkerPath,
    )) ??
    runtimeTargetForDescriptor(
      path,
      resolvedInstallRoot,
      runtimeConfig.lastSuccessful,
      options,
      "lastSuccessful",
      runtimeConfig,
      attemptMarkerPath,
    )
  );
}

export function shouldRedirectToPackagedLauncherTarget(
  currentExecutablePath: string,
  target: Pick<PackagedLauncherRuntimeTarget, "executablePath"> | null,
): boolean {
  if (target == null) return false;
  const path = currentExecutablePath.includes("\\") || /^[A-Za-z]:/.test(currentExecutablePath) ? win32 : posix;
  return path.resolve(currentExecutablePath) !== path.resolve(target.executablePath);
}

function hasRequiredMacInstallRootMarkers(
  context: PackagedLauncherInstallContext & { payloadAppPath: string; platform: "darwin" },
  options: PackagedLauncherInstallContextOptions,
  payloadExecutableName: string,
): boolean {
  if (options.requireInstallRootMarkers !== true) return true;
  if (![
    context.installMetadataPath,
    context.launcherConfigPath,
    context.runtimeConfigPath,
    posixLikeJoin(context.payloadAppPath, "Contents", "MacOS", payloadExecutableName),
  ].every((markerPath) => installRootMarkerExists(markerPath, options))) {
    return false;
  }

  const payloadAppName = context.payloadAppPath.split(/[\\/]/).at(-1) ?? "";
  const expectedCwd = `payload/${payloadAppName}`;
  const expectedExecutable = `${expectedCwd}/Contents/MacOS/${payloadExecutableName}`;
  const installMetadata = readJsonMarker(context.installMetadataPath, options);
  if (!isExpectedMacInstallMetadata(installMetadata, options, payloadAppName, payloadExecutableName)) return false;
  const launcherConfig = readJsonMarker(context.launcherConfigPath, options);
  if (!isExpectedLauncherConfig(launcherConfig)) return false;
  if (launcherConfig.runtimePath !== installMetadata.runtimePath) return false;
  const runtimeConfig = readJsonMarker(context.runtimeConfigPath, options);
  if (!isExpectedRuntimeConfig(runtimeConfig, options, expectedCwd, expectedExecutable)) return false;
  if (runtimeConfig.namespace !== installMetadata.namespace) return false;
  return (
    isRuntimeVersionForContext(runtimeConfig.active, context, expectedCwd, expectedExecutable) ||
    isRuntimeVersionForContext(runtimeConfig.lastSuccessful, context, expectedCwd, expectedExecutable)
  );
}

function posixLikeJoin(...segments: string[]): string {
  return segments.join("/");
}

function hasRequiredInstallRootMarkers(
  path: PathApi,
  context: PackagedLauncherInstallContext,
  options: PackagedLauncherInstallContextOptions,
  payloadExecutableName: string,
): boolean {
  if (context.platform === "darwin" && context.payloadAppPath != null) {
    return hasRequiredMacInstallRootMarkers({ ...context, payloadAppPath: context.payloadAppPath, platform: "darwin" }, options, payloadExecutableName);
  }
  if (options.requireInstallRootMarkers !== true) return true;
  if (context.sevenZipDllPath == null || context.sevenZipPath == null) return false;
  if (![
    context.installMetadataPath,
    context.launcherConfigPath,
    context.runtimeConfigPath,
    context.sevenZipDllPath,
    context.sevenZipPath,
  ].every((markerPath) => installRootMarkerExists(markerPath, options))) {
    return false;
  }

  const installMetadata = readJsonMarker(context.installMetadataPath, options);
  if (!isExpectedInstallMetadata(installMetadata, options)) return false;
  const launcherConfig = readJsonMarker(context.launcherConfigPath, options);
  if (!isExpectedLauncherConfig(launcherConfig)) return false;
  if (launcherConfig.runtimePath !== installMetadata.runtimePath) return false;
  const runtimeConfig = readJsonMarker(context.runtimeConfigPath, options);
  if (!isExpectedRuntimeConfig(runtimeConfig, options, "payload", `payload/${payloadExecutableName}`)) return false;
  if (runtimeConfig.namespace !== installMetadata.namespace) return false;
  if (
    !isRuntimeVersionForContext(runtimeConfig.active, context, "payload", `payload/${payloadExecutableName}`) &&
    !isRuntimeVersionForContext(runtimeConfig.lastSuccessful, context, "payload", `payload/${payloadExecutableName}`)
  ) {
    return false;
  }

  const launcherName = launcherExecutableName(installMetadata);
  if (launcherName == null) return false;
  return installRootMarkerExists(path.join(context.installRoot, launcherName), options);
}

function resolveMacAppWithPathApi(
  path: PathApi,
  executablePath: string,
  options: PackagedLauncherInstallContextOptions,
): PackagedLauncherInstallContext | null {
  const macOsRoot = path.dirname(executablePath);
  if (path.basename(macOsRoot) !== "MacOS") return null;
  const contentsRoot = path.dirname(macOsRoot);
  if (path.basename(contentsRoot) !== "Contents") return null;
  const payloadAppPath = path.dirname(contentsRoot);
  if (safeMacAppBundleName(path.basename(payloadAppPath)) == null) return null;
  const payloadRoot = path.dirname(payloadAppPath);
  if (path.basename(payloadRoot) !== "payload") return null;
  const payloadExecutableName = path.basename(executablePath);
  if (safeMacPathSegment(payloadExecutableName) == null) return null;
  const versionRoot = path.dirname(payloadRoot);
  const version = path.basename(versionRoot);
  if (normalizeVersionSegment(version) == null) return null;
  const versionsRoot = path.dirname(versionRoot);
  if (path.basename(versionsRoot) !== "versions") return null;
  const installRoot = path.dirname(versionsRoot);
  const context: PackagedLauncherInstallContext = {
    cleanupMarkerPath: path.join(installRoot, "state", "cleanup.json"),
    installMetadataPath: path.join(installRoot, "install.json"),
    launcherConfigPath: path.join(installRoot, "launcher.json"),
    installRoot,
    lockPath: path.join(installRoot, "state", "lock"),
    payloadAppPath,
    payloadRoot,
    platform: MAC_PLATFORM,
    runtimeConfigPath: path.join(installRoot, "runtime.json"),
    version,
    versionRoot,
  };
  return hasRequiredInstallRootMarkers(path, context, options, payloadExecutableName) ? context : null;
}

function resolveWithPathApi(
  path: PathApi,
  executablePath: string,
  options: PackagedLauncherInstallContextOptions,
): PackagedLauncherInstallContext | null {
  const payloadRoot = path.dirname(executablePath);
  if (path.basename(payloadRoot) !== "payload") return null;
  const payloadExecutableName = path.basename(executablePath);
  const versionRoot = path.dirname(payloadRoot);
  const version = path.basename(versionRoot);
  if (normalizeVersionSegment(version) == null) return null;
  const versionsRoot = path.dirname(versionRoot);
  if (path.basename(versionsRoot) !== "versions") return null;
  const installRoot = path.dirname(versionsRoot);
  const context = {
    cleanupMarkerPath: path.join(installRoot, "state", "cleanup.json"),
    installMetadataPath: path.join(installRoot, "install.json"),
    launcherConfigPath: path.join(installRoot, "launcher.json"),
    installRoot,
    lockPath: path.join(installRoot, "state", "lock"),
    payloadRoot,
    runtimeConfigPath: path.join(installRoot, "runtime.json"),
    sevenZipDllPath: path.join(installRoot, "lib", "7z", "7z.dll"),
    sevenZipPath: path.join(installRoot, "lib", "7z", "7z.exe"),
    version,
    versionRoot,
  };
  return hasRequiredInstallRootMarkers(path, context, options, payloadExecutableName) ? context : null;
}

export function resolvePackagedLauncherInstallContext(
  executablePath: string,
  options: PackagedLauncherInstallContextOptions = {},
): PackagedLauncherInstallContext | null {
  if (executablePath.includes("\\") || /^[A-Za-z]:/.test(executablePath)) {
    return resolveWithPathApi(win32, executablePath, options);
  }
  const macContext = resolveMacAppWithPathApi(posix, executablePath, options);
  if (macContext != null) return macContext;
  return resolveWithPathApi(posix, executablePath, options);
}
