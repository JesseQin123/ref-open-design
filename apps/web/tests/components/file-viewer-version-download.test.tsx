// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectFile } from '../../src/types';
import { readExpandedIndexCss } from '../helpers/read-expanded-css';

const {
  exportArtifactAsPdfMock,
  exportAsHtmlMock,
  exportAsPdfMock,
  exportAsZipMock,
} = vi.hoisted(() => ({
  exportArtifactAsPdfMock: vi.fn(),
  exportAsHtmlMock: vi.fn(),
  exportAsPdfMock: vi.fn(),
  exportAsZipMock: vi.fn(),
}));

vi.mock('../../src/runtime/exports', async () => {
  const actual = await vi.importActual<typeof import('../../src/runtime/exports')>(
    '../../src/runtime/exports',
  );
  return {
    ...actual,
    exportArtifactAsPdf: exportArtifactAsPdfMock,
    exportAsHtml: exportAsHtmlMock,
    exportAsPdf: exportAsPdfMock,
    exportAsZip: exportAsZipMock,
  };
});

import { FileViewer } from '../../src/components/FileViewer';

function htmlFile(): ProjectFile {
  return {
    name: 'index.html',
    path: 'index.html',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    kind: 'html',
    mime: 'text/html',
    artifactManifest: {
      version: 1,
      kind: 'html',
      title: 'Index',
      entry: 'index.html',
      renderer: 'html',
      exports: ['html'],
    },
  };
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  if (!match?.[1]) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1];
}

function cssValue(rule: string, property: string): string {
  const match = new RegExp(`${property}\\s*:\\s*([^;]+);`).exec(rule);
  if (!match?.[1]) throw new Error(`Missing CSS property ${property}`);
  return match[1].trim();
}

function setupVersionFetch(file = htmlFile()) {
  const currentVersion = {
    id: 'v2',
    fileName: 'index.html',
    version: 2,
    label: 'Current checkpoint',
    createdAt: 1_725_000_000_000,
    source: 'manual',
    prompt: 'Current prompt',
    size: 42,
    mime: 'text/html',
    kind: 'html',
    current: true,
  };
  const priorVersion = {
    ...currentVersion,
    id: 'v1',
    version: 1,
    label: 'Prior checkpoint',
    prompt: 'Prior prompt',
    current: false,
  };
  const priorContent =
    '<html><body><main style="background:#d16646;color:white">Prior colored version</main></body></html>';
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/projects/project-1/files/index.html/versions' && method === 'GET') {
      return new Response(JSON.stringify({ file, versions: [currentVersion, priorVersion] }), { status: 200 });
    }
    if (url === '/api/projects/project-1/files/index.html/versions/v1' && method === 'GET') {
      return new Response(JSON.stringify({ version: priorVersion, content: priorContent }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { currentVersion, fetchMock, file, priorContent, priorVersion };
}

async function renderVersionDialog(file = htmlFile()) {
  render(
    <FileViewer
      projectId="project-1"
      projectKind="prototype"
      file={file}
      liveHtml="<html><body><h1>Current</h1></body></html>"
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
  const versionDialog = await screen.findByRole('dialog', { name: 'Versions' });
  fireEvent.click(within(versionDialog).getByRole('option', { name: /Prior prompt/ }));
  await waitFor(() => {
    expect(within(versionDialog).getByRole('button', { name: 'Download Version 1' })).toBeTruthy();
  });
  return versionDialog;
}

function openVersionDownloadMenu(versionDialog: HTMLElement) {
  fireEvent.click(within(versionDialog).getByRole('button', { name: 'Download Version 1' }));
}

describe('FileViewer version download actions', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('exports version PDFs through the artifact screenshot PDF path', async () => {
    exportArtifactAsPdfMock.mockResolvedValueOnce(undefined);
    const { file, priorContent } = setupVersionFetch();
    const versionDialog = await renderVersionDialog(file);

    openVersionDownloadMenu(versionDialog);
    fireEvent.click(within(versionDialog).getByRole('menuitem', { name: 'Export as PDF' }));

    await waitFor(() => {
      expect(exportArtifactAsPdfMock).toHaveBeenCalledWith(
        priorContent,
        'index-v1',
        expect.objectContaining({
          deck: false,
          onProgress: expect.any(Function),
        }),
      );
    });
    expect(exportAsPdfMock).not.toHaveBeenCalled();
  });

  it('opens the version image export dialog from the download menu', async () => {
    const { file } = setupVersionFetch();
    const versionDialog = await renderVersionDialog(file);

    openVersionDownloadMenu(versionDialog);
    fireEvent.click(within(versionDialog).getByRole('menuitem', { name: 'Export as image' }));

    expect(await screen.findByRole('dialog', { name: 'Export as image' })).toBeTruthy();
  });

  it('routes version HTML and ZIP actions through the selected version content', async () => {
    const { file, priorContent } = setupVersionFetch();
    const versionDialog = await renderVersionDialog(file);

    openVersionDownloadMenu(versionDialog);
    fireEvent.click(within(versionDialog).getByRole('menuitem', { name: 'Export as standalone HTML' }));

    await waitFor(() => {
      expect(exportAsHtmlMock).toHaveBeenCalledWith(priorContent, 'index-v1');
    });

    openVersionDownloadMenu(versionDialog);
    fireEvent.click(within(versionDialog).getByRole('menuitem', { name: 'Download as .zip' }));

    await waitFor(() => {
      expect(exportAsZipMock).toHaveBeenCalledWith(priorContent, 'index-v1');
    });
  });

  it('keeps version export popovers and feedback above the preview modal layers', () => {
    const css = readExpandedIndexCss();
    expect(Number(cssValue(cssRule(css, '.file-version-head'), 'z-index'))).toBeGreaterThan(10);
    expect(Number(cssValue(cssRule(css, '.file-version-download-menu.share-menu-popover'), 'z-index'))).toBeGreaterThan(
      Number(cssValue(cssRule(css, '.file-version-preview-overlay'), 'z-index')),
    );
    expect(Number(cssValue(cssRule(css, '.viewer-modal-backdrop.file-version-export-backdrop.modal-backdrop'), 'z-index'))).toBeGreaterThan(
      Number(cssValue(cssRule(css, '.file-version-backdrop.modal-backdrop'), 'z-index')),
    );
    expect(Number(cssValue(cssRule(css, '.od-toast.file-version-export-toast.placement-top'), 'z-index'))).toBeGreaterThan(
      Number(cssValue(cssRule(css, '.file-version-backdrop.modal-backdrop'), 'z-index')),
    );
  });
});
