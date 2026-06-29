import type { ExportFormat, ExportImageFormat } from "@open-design/contracts";

export interface ExportCliRequestOptions {
  fileName: string;
  format: ExportFormat;
  deck?: boolean;
  imageFormat?: ExportImageFormat;
  title?: string;
}

export function buildExportCliRequestBody(options: ExportCliRequestOptions): Record<string, unknown> {
  return {
    fileName: options.fileName,
    // PPTX is deck-only. For PDF/image, omit `deck` unless the caller explicitly
    // opts in so the daemon can still inspect the artifact and choose deck mode.
    ...(options.format === "pptx" ? { deck: true } : options.deck === true ? { deck: true } : {}),
    ...(options.format === "image" && options.imageFormat ? { imageFormat: options.imageFormat } : {}),
    ...(options.title ? { title: options.title } : {}),
  };
}
