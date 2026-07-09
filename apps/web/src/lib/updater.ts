import {
  OPEN_DESIGN_HOST_UPDATER_STATES,
  checkHostUpdater,
  downloadHostUpdater,
  getHostUpdaterStatus,
  installHostUpdater,
  isOpenDesignHostAvailable,
  quitHostAfterUpdaterInstallerOpen,
  subscribeHostUpdater,
  type OpenDesignHostActionResult,
  type OpenDesignHostFailure,
  type OpenDesignHostUpdaterActionOptions,
  type OpenDesignHostUpdaterResult,
  type OpenDesignHostUpdaterStatusListener,
  type OpenDesignHostUpdaterStatusSnapshot,
} from '@open-design/host';

export type UpdaterEnvironment = 'desktop' | 'web';

export type UpdaterDownloadProgress = {
  percent: number | null;
  receivedBytes: number;
  totalBytes: number | null;
};

export type UpdaterReleaseNoteFormat = 'html' | 'markdown';

export type UpdaterReleaseNoteCandidate = {
  contentType: string | null;
  format: UpdaterReleaseNoteFormat;
  locale: string;
  url: string;
};

export type UpdaterReleaseNotesJumpTo = {
  kind: 'external';
  url: string;
};

export type UpdaterActionResult =
  | { ok: true; model: UpdaterModel; status: OpenDesignHostUpdaterStatusSnapshot }
  | OpenDesignHostFailure;

export type UpdaterModel = {
  availableVersion: string | null;
  busy: boolean;
  canApplyInPlace: boolean;
  canCheck: boolean;
  canDownload: boolean;
  canOpenInstaller: boolean;
  canQuitAfterInstallerOpen: boolean;
  currentVersion: string | null;
  downloadProgress: UpdaterDownloadProgress | null;
  enabled: boolean;
  environment: UpdaterEnvironment;
  errorMessage: string | null;
  hasDownloadedInstaller: boolean;
  installerOpened: boolean;
  updateKind: 'installer' | 'payload' | 'unknown';
  promptKey: string | null;
  requiresManualInstall: boolean;
  upToDate: boolean;
  shouldShowControl: boolean;
  shouldPrompt: boolean;
  status: OpenDesignHostUpdaterStatusSnapshot | null;
  supported: boolean;
};

function modelFromHostResult(result: OpenDesignHostUpdaterResult): UpdaterActionResult {
  if (!result.ok) return result;
  return {
    ok: true,
    model: deriveUpdaterModel(result.status, { hostAvailable: true }),
    status: result.status,
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function downloadProgressFromStatus(
  status: OpenDesignHostUpdaterStatusSnapshot | null,
): UpdaterDownloadProgress | null {
  if (status == null) return null;
  if (status.state !== OPEN_DESIGN_HOST_UPDATER_STATES.DOWNLOADING) return null;
  const sourceProgress = status.incoming?.progress ?? status.progress;

  const receivedBytes = Math.max(0, sourceProgress?.receivedBytes ?? 0);
  const totalBytes =
    typeof sourceProgress?.totalBytes === 'number' && sourceProgress.totalBytes > 0
      ? sourceProgress.totalBytes
      : null;
  const percent = totalBytes == null ? null : clampPercent((receivedBytes / totalBytes) * 100);
  return {
    percent,
    receivedBytes,
    totalBytes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function metadataFromStatus(status: OpenDesignHostUpdaterStatusSnapshot | null): Record<string, unknown> | null {
  if (isRecord(status?.active?.metadata)) return status.active.metadata;
  if (isRecord(status?.metadata)) return status.metadata;
  if (isRecord(status?.incoming?.metadata)) return status.incoming.metadata;
  return null;
}

function readHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw.length === 0) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

function readReleaseNoteCandidate(
  files: Record<string, unknown>,
  locale: string,
  format: UpdaterReleaseNoteFormat,
): UpdaterReleaseNoteCandidate | null {
  const localeEntry = files[locale];
  if (!isRecord(localeEntry)) return null;
  const entry = localeEntry[format];
  if (!isRecord(entry)) return null;
  const url = entry.url;
  if (typeof url !== 'string' || url.length === 0) return null;
  const contentType = typeof entry.contentType === 'string' && entry.contentType.length > 0
    ? entry.contentType
    : null;
  return {
    contentType,
    format,
    locale,
    url,
  };
}

export function releaseNoteCandidatesFromStatus(
  status: OpenDesignHostUpdaterStatusSnapshot | null,
  locale: string,
): UpdaterReleaseNoteCandidate[] {
  const metadata = metadataFromStatus(status);
  const releaseNotes = isRecord(metadata?.releaseNotes) ? metadata.releaseNotes : null;
  const files = isRecord(releaseNotes?.files) ? releaseNotes.files : null;
  if (files == null) return [];

  const defaultLocale =
    typeof releaseNotes?.defaultLocale === 'string' && releaseNotes.defaultLocale.length > 0
      ? releaseNotes.defaultLocale
      : 'en';
  const currentLocale = locale.length > 0 ? locale : defaultLocale;
  const ordered: Array<[string, UpdaterReleaseNoteFormat]> = [
    [currentLocale, 'html'],
    [defaultLocale, 'html'],
    [currentLocale, 'markdown'],
    [defaultLocale, 'markdown'],
  ];
  const seen = new Set<string>();
  const candidates: UpdaterReleaseNoteCandidate[] = [];
  for (const [candidateLocale, format] of ordered) {
    const candidate = readReleaseNoteCandidate(files, candidateLocale, format);
    if (candidate == null) continue;
    const key = `${candidate.format}:${candidate.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

export function releaseNotesJumpToFromStatus(
  status: OpenDesignHostUpdaterStatusSnapshot | null,
): UpdaterReleaseNotesJumpTo | null {
  const metadata = metadataFromStatus(status);
  const releaseNotes = isRecord(metadata?.releaseNotes) ? metadata.releaseNotes : null;
  const jumpTo = isRecord(releaseNotes?.jumpTo) ? releaseNotes.jumpTo : null;
  const url = readHttpsUrl(jumpTo?.url);
  if (url == null) return null;
  return { kind: 'external', url };
}

export function deriveUpdaterModel(
  status: OpenDesignHostUpdaterStatusSnapshot | null,
  options: { hostAvailable?: boolean } = {},
): UpdaterModel {
  const hostAvailable = options.hostAvailable ?? isOpenDesignHostAvailable();
  const environment: UpdaterEnvironment = hostAvailable ? 'desktop' : 'web';
  const state = status?.state;
  const busy =
    state === OPEN_DESIGN_HOST_UPDATER_STATES.CHECKING ||
    state === OPEN_DESIGN_HOST_UPDATER_STATES.DOWNLOADING ||
    state === OPEN_DESIGN_HOST_UPDATER_STATES.INSTALLING;
  const canOpenInstaller = Boolean(
    hostAvailable &&
    status?.enabled &&
    status.supported &&
    status.capabilities.canOpenInstaller,
  );
  const canApplyInPlace = Boolean(
    hostAvailable &&
    status?.enabled &&
    status.supported &&
    status.capabilities.canApplyInPlace,
  );
  const canInstallUpdate = canOpenInstaller || canApplyInPlace;
  const hasDownloadedInstaller = Boolean(
    state === OPEN_DESIGN_HOST_UPDATER_STATES.DOWNLOADED &&
    status?.downloadPath,
  );
  const installerOpened = status?.installResult != null;
  const artifactType = status?.artifact?.type ?? status?.incoming?.artifact?.type;
  const updateKind = artifactType === 'payload' ? 'payload' : artifactType === 'dmg' || artifactType === 'installer' ? 'installer' : 'unknown';
  const availableVersion = status?.availableVersion ?? null;
  const currentVersion = status?.currentVersion ?? null;
  const downloadProgress = downloadProgressFromStatus(status);
  const upToDate = state === OPEN_DESIGN_HOST_UPDATER_STATES.NOT_AVAILABLE;
  const promptKey =
    status == null || availableVersion == null
      ? null
      : [
          status.channel,
          currentVersion ?? 'unknown-current',
          availableVersion,
          status.downloadPath ?? status.artifactUrl ?? status.artifact?.url ?? 'unknown-artifact',
        ].join(':');
  const canQuitAfterInstallerOpen = hostAvailable && installerOpened;

  return {
    availableVersion,
    busy,
    canApplyInPlace,
    canCheck: hostAvailable && Boolean(status?.enabled) && !busy,
    canDownload: hostAvailable && Boolean(status?.enabled && status.capabilities.canDownload) && !busy,
    canOpenInstaller,
    canQuitAfterInstallerOpen,
    currentVersion,
    downloadProgress,
    enabled: Boolean(status?.enabled),
    environment,
    errorMessage: status?.error?.message ?? null,
    hasDownloadedInstaller,
    installerOpened,
    updateKind,
    promptKey,
    requiresManualInstall: Boolean(status?.capabilities.requiresManualInstall),
    upToDate,
    shouldShowControl: canInstallUpdate && hasDownloadedInstaller && !installerOpened,
    shouldPrompt: canInstallUpdate && hasDownloadedInstaller && !installerOpened,
    status,
    supported: Boolean(status?.supported),
  };
}

export async function readUpdaterStatus(options?: OpenDesignHostUpdaterActionOptions): Promise<UpdaterActionResult> {
  return modelFromHostResult(await getHostUpdaterStatus(options));
}

export async function checkForUpdaterUpdate(options?: OpenDesignHostUpdaterActionOptions): Promise<UpdaterActionResult> {
  return modelFromHostResult(await checkHostUpdater(options));
}

export async function downloadUpdaterUpdate(options?: OpenDesignHostUpdaterActionOptions): Promise<UpdaterActionResult> {
  return modelFromHostResult(await downloadHostUpdater(options));
}

export async function openUpdaterInstaller(options?: OpenDesignHostUpdaterActionOptions): Promise<UpdaterActionResult> {
  return modelFromHostResult(await installHostUpdater(options));
}

export async function quitAfterUpdaterInstallerOpen(
  options?: OpenDesignHostUpdaterActionOptions,
): Promise<OpenDesignHostActionResult> {
  return await quitHostAfterUpdaterInstallerOpen(options);
}

export function subscribeToUpdaterStatus(listener: OpenDesignHostUpdaterStatusListener): () => void {
  return subscribeHostUpdater(listener);
}
