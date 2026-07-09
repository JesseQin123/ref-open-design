// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OpenDesignHostUpdaterStatusListener, OpenDesignHostUpdaterStatusSnapshot } from '@open-design/host';
import { installMockOpenDesignHost } from '@open-design/host/testing';

import { UpdaterPopup } from '../../src/components/UpdaterPopup';
import { I18nProvider } from '../../src/i18n';

function idleStatus(): OpenDesignHostUpdaterStatusSnapshot {
  return {
    arch: 'arm64',
    capabilities: {
      canApplyInPlace: false,
      canDownload: true,
      canOpenInstaller: true,
      requiresManualInstall: true,
    },
    channel: 'beta',
    currentVersion: '1.2.3-beta.3',
    enabled: true,
    mode: 'package-launcher',
    platform: 'darwin',
    state: 'idle',
    supported: true,
  };
}

function downloadedStatus(overrides: Partial<OpenDesignHostUpdaterStatusSnapshot> = {}): OpenDesignHostUpdaterStatusSnapshot {
  return {
    ...idleStatus(),
    availableVersion: '1.2.3-beta.4',
    downloadPath: '/tmp/open-design-updater/Open Design Beta.dmg',
    state: 'downloaded',
    ...overrides,
  };
}

function payloadDownloadedStatus(overrides: Partial<OpenDesignHostUpdaterStatusSnapshot> = {}): OpenDesignHostUpdaterStatusSnapshot {
  return downloadedStatus({
    artifact: {
      name: 'open-design-1.2.3-beta.4-mac-arm64-payload.zip',
      platformKey: 'mac',
      size: 1024,
      type: 'payload',
      url: 'https://example.test/payload.zip',
    },
    capabilities: {
      canApplyInPlace: true,
      canDownload: true,
      canOpenInstaller: false,
      requiresManualInstall: false,
    },
    downloadPath: '/tmp/open-design-updater/open-design-1.2.3-beta.4-mac-arm64-payload.zip',
    ...overrides,
  });
}

describe('UpdaterPopup', () => {
  let restoreHost: (() => void) | null = null;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    cleanup();
    restoreHost?.();
    restoreHost = null;
    globalThis.fetch = originalFetch;
  });

  it('stays hidden for non-installable updater states', async () => {
    for (const status of [
      idleStatus(),
      { ...idleStatus(), state: 'not-available' as const },
      downloadedStatus({
        progress: {
          receivedBytes: 50,
          totalBytes: 100,
        },
        state: 'downloading',
      }),
      downloadedStatus({
        downloadPath: undefined,
        error: {
          code: 'update-store-invalid-shape',
          message: 'update store contains unexpected root entries',
        },
        state: 'error',
      }),
    ]) {
      restoreHost = installMockOpenDesignHost({
        host: {
          updater: {
            status: vi.fn(async () => status),
          },
        },
      });

      const view = render(<UpdaterPopup />);
      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.queryByTestId('entry-nav-updater')).toBeNull();
      expect(screen.queryByTestId('updater-popup')).toBeNull();
      view.unmount();
      restoreHost?.();
      restoreHost = null;
    }
  });

  it('shows only the ready indicator until the user opens the install prompt', async () => {
    restoreHost = installMockOpenDesignHost({
      host: {
        updater: {
          status: vi.fn(async () => downloadedStatus()),
        },
      },
    });

    render(<UpdaterPopup />);

    const button = await screen.findByTestId('entry-nav-updater');
    expect(button.getAttribute('data-tooltip')).toBe('Install update');
    expect(screen.queryByTestId('updater-popup')).toBeNull();

    fireEvent.click(button);

    expect(await screen.findByRole('dialog', { name: 'Update ready' })).toBeTruthy();
    expect(screen.getByText('Open Design 1.2.3-beta.4 is ready. Open Design will close and open the installer.')).toBeTruthy();
    expect(screen.getByTestId('updater-install-button').textContent).toBe('Install update');
    expect(screen.getByTestId('updater-popup').className).toContain('updater-popup--expanded');
  });

  it('can shrink the expanded prompt back to the compact anchored prompt', async () => {
    restoreHost = installMockOpenDesignHost({
      host: {
        updater: {
          status: vi.fn(async () => downloadedStatus()),
        },
      },
    });

    render(<UpdaterPopup />);

    fireEvent.click(await screen.findByTestId('entry-nav-updater'));
    expect(await screen.findByTestId('updater-popup')).toBeTruthy();
    expect(screen.getByTestId('updater-popup').className).toContain('updater-popup--expanded');

    fireEvent.click(screen.getByTestId('updater-popup-size-button'));

    expect(screen.getByTestId('updater-popup').className).toContain('updater-popup--compact');
    expect(screen.getByTestId('updater-popup-size-button').getAttribute('aria-label')).toBe('Expand update details');
  });

  it('uses localized ready prompt copy from the app i18n provider', async () => {
    restoreHost = installMockOpenDesignHost({
      host: {
        updater: {
          status: vi.fn(async () => downloadedStatus()),
        },
      },
    });

    render(
      <I18nProvider initial="zh-CN">
        <UpdaterPopup />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByTestId('entry-nav-updater'));

    expect(await screen.findByRole('dialog', { name: '更新已就绪' })).toBeTruthy();
    expect(screen.getByTestId('updater-install-button').textContent).toBe('安装更新');
    expect(screen.getByText('Open Design 1.2.3-beta.4 已就绪。Open Design 会关闭并打开安装器。')).toBeTruthy();
  });

  it('uses install-and-restart copy for payload updates', async () => {
    restoreHost = installMockOpenDesignHost({
      host: {
        updater: {
          status: vi.fn(async () => payloadDownloadedStatus()),
        },
      },
    });

    render(
      <I18nProvider initial="zh-CN">
        <UpdaterPopup />
      </I18nProvider>,
    );

    const button = await screen.findByTestId('entry-nav-updater');
    expect(button.getAttribute('data-tooltip')).toBe('安装并重启');
    fireEvent.click(button);

    expect(await screen.findByRole('dialog', { name: '更新已就绪' })).toBeTruthy();
    expect(screen.getByTestId('updater-install-button').textContent).toBe('安装并重启');
    expect(screen.getByText('Open Design 1.2.3-beta.4 已就绪。Open Design 会关闭并自动重启。')).toBeTruthy();
  });

  it('renders static release notes without fetching metadata URLs', async () => {
    const openExternal = vi.fn(async () => ({ ok: true as const }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/version') {
        return new Response(JSON.stringify({ version: 'test' }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    restoreHost = installMockOpenDesignHost({
      host: {
        shell: {
          openExternal,
        },
        updater: {
          status: vi.fn(async () => downloadedStatus({
            metadata: {
              releaseNotes: {
                defaultLocale: 'en',
                files: {
                  en: {
                    html: {
                      contentType: 'text/html; charset=utf-8',
                      url: 'https://releases.example.test/stable/versions/1.2.3/release-notes/en.html',
                    },
                    markdown: {
                      contentType: 'text/markdown; charset=utf-8',
                      url: 'https://releases.example.test/stable/versions/1.2.3/release-notes/en.md',
                    },
                  },
                  'zh-CN': {
                    markdown: {
                      contentType: 'text/markdown; charset=utf-8',
                      url: 'https://releases.example.test/stable/versions/1.2.3/release-notes/zh-CN.md',
                    },
                  },
                },
                jumpTo: {
                  kind: 'external',
                  url: 'https://releases.example.test/stable/versions/1.2.3/details',
                },
              },
            },
          })),
        },
      },
    });

    render(
      <I18nProvider initial="en">
        <UpdaterPopup />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByTestId('entry-nav-updater'));

    const releaseNotes = await screen.findByTestId('updater-release-notes');
    expect(releaseNotes.textContent).toContain('Release notes preview');
    expect(releaseNotes.textContent).toContain('local constant text');
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('releases.example.test'))).toBe(false);

    fireEvent.click(screen.getByTestId('updater-release-notes-jump'));
    expect(openExternal).toHaveBeenCalledWith('https://releases.example.test/stable/versions/1.2.3/details');
  });

  it('dismisses the confirmation prompt before installation starts', async () => {
    restoreHost = installMockOpenDesignHost({
      host: {
        updater: {
          status: vi.fn(async () => downloadedStatus()),
        },
      },
    });

    render(<UpdaterPopup />);

    fireEvent.click(await screen.findByTestId('entry-nav-updater'));
    expect(await screen.findByRole('dialog', { name: 'Update ready' })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('updater-popup')).toBeNull();

    fireEvent.click(screen.getByTestId('entry-nav-updater'));
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByTestId('updater-popup')).toBeNull();
  });

  it('keeps the prompt in handoff loading after opening the installer', async () => {
    let status = downloadedStatus();
    let resolveInstall: (status: OpenDesignHostUpdaterStatusSnapshot) => void = () => undefined;
    const install = vi.fn(() => new Promise<OpenDesignHostUpdaterStatusSnapshot>((resolve) => {
      resolveInstall = resolve;
    }));
    const quit = vi.fn(async () => ({ ok: true as const }));
    restoreHost = installMockOpenDesignHost({
      host: {
        updater: {
          install,
          quit,
          status: vi.fn(async () => status),
        },
      },
    });

    render(<UpdaterPopup />);

    fireEvent.click(await screen.findByTestId('entry-nav-updater'));
    fireEvent.click(screen.getByTestId('updater-install-button'));
    fireEvent.click(screen.getByTestId('updater-install-button'));

    expect(install).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Opening installer...' }).getAttribute('disabled')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Later' }).getAttribute('disabled')).not.toBeNull();

    await act(async () => {
      status = downloadedStatus({
        installResult: {
          dryRun: true,
          openedAt: '2026-05-19T00:00:00.000Z',
          path: '/tmp/open-design-updater/Open Design Beta.dmg',
        },
      });
      resolveInstall(status);
      await Promise.resolve();
    });

    await waitFor(() => expect(install).toHaveBeenCalledWith({ payload: { source: 'updater-prompt' } }));
    await waitFor(() => expect(quit).toHaveBeenCalledWith({ payload: { source: 'updater-prompt' } }));
    expect(screen.getByTestId('entry-nav-updater')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Update ready' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Opening installer...' }).getAttribute('disabled')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Later' }).getAttribute('disabled')).not.toBeNull();
  });

  it('recovers the handoff prompt if the app has not closed after the watchdog', async () => {
    const install = vi.fn(async () => downloadedStatus({
      installResult: {
        dryRun: true,
        openedAt: '2026-05-19T00:00:00.000Z',
        path: '/tmp/open-design-updater/Open Design Beta.dmg',
      },
    }));
    const quit = vi.fn(async () => ({ ok: true as const }));
    restoreHost = installMockOpenDesignHost({
      host: {
        updater: {
          install,
          quit,
          status: vi.fn(async () => downloadedStatus()),
        },
      },
    });

    render(<UpdaterPopup />);

    fireEvent.click(await screen.findByTestId('entry-nav-updater'));
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId('updater-install-button'));

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByRole('button', { name: 'Opening installer...' }).getAttribute('disabled')).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(screen.getByRole('dialog', { name: 'Update ready' })).toBeTruthy();
      expect(screen.getByTestId('updater-install-button').textContent).toBe('Install update');
      expect(screen.getByTestId('updater-install-button').getAttribute('disabled')).toBeNull();
      fireEvent.click(screen.getByTestId('updater-install-button'));

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(install).toHaveBeenCalledTimes(2);
      expect(quit).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps install failures internal and leaves the ready prompt usable', async () => {
    const install = vi.fn(async () => downloadedStatus({
      error: {
        code: 'open-installer-failed',
        message: 'fixture open failed',
      },
      state: 'error',
    }));
    restoreHost = installMockOpenDesignHost({
      host: {
        updater: {
          install,
          status: vi.fn(async () => downloadedStatus()),
        },
      },
    });

    render(<UpdaterPopup />);

    fireEvent.click(await screen.findByTestId('entry-nav-updater'));
    fireEvent.click(screen.getByTestId('updater-install-button'));

    await waitFor(() => expect(install).toHaveBeenCalledWith({ payload: { source: 'updater-prompt' } }));
    expect(screen.queryByText('fixture open failed')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Update failed' })).toBeNull();
    expect(await screen.findByRole('dialog', { name: 'Update ready' })).toBeTruthy();
    expect(screen.getByTestId('updater-install-button').getAttribute('disabled')).toBeNull();
  });

  it('reacts to updater subscription events by showing the ready indicator only', async () => {
    const listeners = new Set<OpenDesignHostUpdaterStatusListener>();
    restoreHost = installMockOpenDesignHost({
      host: {
        updater: {
          status: vi.fn(async () => idleStatus()),
          subscribe: vi.fn((listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          }),
        },
      },
    });

    render(<UpdaterPopup />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('entry-nav-updater')).toBeNull();

    act(() => {
      for (const listener of listeners) listener(downloadedStatus());
    });

    expect(await screen.findByTestId('entry-nav-updater')).toBeTruthy();
    expect(screen.queryByTestId('updater-popup')).toBeNull();
  });
});
