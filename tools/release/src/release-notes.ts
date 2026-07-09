import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type ReleaseNoteFormat = "html" | "markdown";

export type ReleaseNoteSourceFile = {
  contentType: string;
  extension: "html" | "md";
  format: ReleaseNoteFormat;
  locale: string;
  name: string;
  path: string;
  size: number;
};

export type ReleaseNotePublishedFile = Omit<ReleaseNoteSourceFile, "path"> & {
  url: string;
};

export type ReleaseNotesJumpTo = {
  kind: "external";
  url: string;
};

export type ReleaseNotesMetadata = {
  defaultLocale: "en";
  files: Record<string, Partial<Record<ReleaseNoteFormat, ReleaseNotePublishedFile>>>;
  jumpTo?: ReleaseNotesJumpTo;
  requiredMarkdownLocales: string[];
  version: string;
};

export const RELEASE_NOTES_DEFAULT_LOCALE = "en";
export const RELEASE_NOTES_REQUIRED_MARKDOWN_LOCALES = ["en", "zh-CN"] as const;

function releaseNotesRoot(): string {
  return process.env.OPEN_DESIGN_RELEASE_NOTES_ROOT ?? join(process.cwd(), "docs", "CHANGELOG");
}

export function releaseNotesSourceDir(releaseVersion: string): string {
  return join(releaseNotesRoot(), `v${releaseVersion}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function assertHttpsUrl(value: unknown, label: string, path: string): string {
  const message = `release notes ${label} must be an HTTPS URL: ${path}`;
  if (typeof value !== "string") throw new Error(message);
  const raw = value.trim();
  if (raw.length === 0) throw new Error(message);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(message);
  }
  if (parsed.protocol !== "https:") throw new Error(message);
  return raw;
}

function releaseNoteFormat(extension: string): ReleaseNoteFormat | null {
  if (extension === "html") return "html";
  if (extension === "md") return "markdown";
  return null;
}

function releaseNoteContentType(extension: "html" | "md"): string {
  return extension === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8";
}

function parseReleaseNoteFileName(name: string): { extension: "html" | "md"; format: ReleaseNoteFormat; locale: string } | null {
  const match = /^([A-Za-z][A-Za-z0-9-]*)\.(html|md)$/.exec(name);
  if (match?.[1] == null || match[2] == null) return null;
  const extension = match[2] as "html" | "md";
  const format = releaseNoteFormat(extension);
  if (format == null) return null;
  return {
    extension,
    format,
    locale: match[1],
  };
}

export function discoverReleaseNotes(releaseVersion: string): ReleaseNoteSourceFile[] {
  const sourceDir = releaseNotesSourceDir(releaseVersion);
  if (!existsSync(sourceDir)) {
    return [];
  }
  if (!statSync(sourceDir).isDirectory()) {
    throw new Error(`release notes path must be a directory: ${sourceDir}`);
  }

  const files: ReleaseNoteSourceFile[] = [];
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const parsed = parseReleaseNoteFileName(entry.name);
    if (parsed == null) continue;
    const path = join(sourceDir, entry.name);
    files.push({
      contentType: releaseNoteContentType(parsed.extension),
      extension: parsed.extension,
      format: parsed.format,
      locale: parsed.locale,
      name: entry.name,
      path,
      size: statSync(path).size,
    });
  }

  files.sort((left, right) => left.name.localeCompare(right.name));
  return files;
}

export function readReleaseNotesJumpTo(releaseVersion: string): ReleaseNotesJumpTo | null {
  const metaPath = join(releaseNotesSourceDir(releaseVersion), "meta.json");
  if (!existsSync(metaPath)) return null;

  const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`release notes meta must be a JSON object: ${metaPath}`);
  }
  if (parsed.jumpTo == null) return null;
  if (!isRecord(parsed.jumpTo)) {
    throw new Error(`release notes meta "jumpTo" must be a JSON object: ${metaPath}`);
  }
  return {
    kind: "external",
    url: assertHttpsUrl(parsed.jumpTo.url, "jumpTo.url", metaPath),
  };
}

export function assertStableReleaseNotes(releaseVersion: string): ReleaseNoteSourceFile[] {
  const files = discoverReleaseNotes(releaseVersion);
  const names = new Set(files.map((file) => file.name));
  const missing = RELEASE_NOTES_REQUIRED_MARKDOWN_LOCALES
    .map((locale) => `${locale}.md`)
    .filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `stable release notes require ${missing.join(", ")} under ${releaseNotesSourceDir(releaseVersion)}`,
    );
  }
  return files;
}

export function releaseNotesMetadata(
  releaseVersion: string,
  files: ReleaseNotePublishedFile[],
  jumpTo: ReleaseNotesJumpTo | null = null,
): ReleaseNotesMetadata {
  const byLocale: ReleaseNotesMetadata["files"] = {};
  for (const file of files) {
    byLocale[file.locale] ??= {};
    byLocale[file.locale][file.format] = file;
  }
  return {
    defaultLocale: RELEASE_NOTES_DEFAULT_LOCALE,
    files: byLocale,
    ...(jumpTo == null ? {} : { jumpTo }),
    requiredMarkdownLocales: [...RELEASE_NOTES_REQUIRED_MARKDOWN_LOCALES],
    version: releaseVersion,
  };
}
