// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SketchEditor } from '../../src/components/SketchEditor';
import { emptySketchScene, type ExcalidrawSketchScene } from '../../src/components/sketch-model';

const mockData = vi.hoisted(() => ({
  excalidrawScene: {
    elements: [{ id: 'api-element', type: 'rectangle', isDeleted: false }],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  },
  lastProps: null as Record<string, any> | null,
}));

vi.mock('@excalidraw/excalidraw', async () => {
  const React = await import('react');
  const MainMenu = Object.assign(
    (props: Record<string, any>) => React.createElement('div', null, props.children),
    {
      DefaultItems: {
        SearchMenu: () => null,
        Help: () => null,
        ClearCanvas: () => null,
        ChangeCanvasBackground: () => null,
      },
      Separator: () => null,
    },
  );
  return {
    Excalidraw: (props: Record<string, any>) => {
      mockData.lastProps = props;
      React.useEffect(() => {
        props.excalidrawAPI?.({
          getSceneElementsIncludingDeleted: () => mockData.excalidrawScene.elements,
          getAppState: () => mockData.excalidrawScene.appState,
          getFiles: () => mockData.excalidrawScene.files,
        });
      }, [props.excalidrawAPI]);
      return React.createElement(
        'div',
        {
          'data-testid': 'excalidraw',
          'data-lang': props.langCode,
          'data-theme': props.theme,
        },
        props.renderTopRightUI?.(false, {}),
      );
    },
    MainMenu,
    convertToExcalidrawElements: vi.fn((elements: unknown[]) => elements),
    exportToBlob: vi.fn(async () => new Blob(['mock image'], { type: 'image/png' })),
  };
});

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({
    locale: 'zh-CN',
    t: (key: string) => key,
  }),
}));

beforeAll(() => {
  if (!window.requestAnimationFrame) {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(callback, 0));
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle));
  }
});

afterEach(() => {
  cleanup();
  mockData.lastProps = null;
  mockData.excalidrawScene = {
    elements: [{ id: 'api-element', type: 'rectangle', isDeleted: false }],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  };
  vi.clearAllMocks();
  vi.useRealTimers();
});

const noop = () => {};

function sceneWithElement(): ExcalidrawSketchScene {
  return {
    elements: [{ id: 'scene-element', type: 'rectangle', isDeleted: false }],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  };
}

function renderEditor(overrides: Partial<Parameters<typeof SketchEditor>[0]> = {}) {
  return render(
    <SketchEditor
      scene={emptySketchScene('test.sketch.json')}
      onSceneChange={noop}
      onSave={noop}
      fileName="test.sketch.json"
      {...overrides}
    />,
  );
}

function saveButton(): HTMLButtonElement {
  return document.querySelector('button.primary') as HTMLButtonElement;
}

describe('SketchEditor save', () => {
  it('renders Excalidraw with the current Open Design locale', () => {
    renderEditor({ dirty: true });
    expect(document.querySelector('[data-testid="excalidraw"]')?.getAttribute('data-lang')).toBe('zh-CN');
  });

  it('strips Excalidraw runtime app state before passing initial data back to Excalidraw', () => {
    renderEditor({
      scene: {
        elements: [],
        appState: {
          viewBackgroundColor: '#ffffff',
          collaborators: { stale: true },
          openMenu: 'canvas',
          editingElement: { id: 'editing' },
        },
        files: {},
      },
    });

    const appState = mockData.lastProps?.initialData?.appState;
    expect(appState?.viewBackgroundColor).toBe('#ffffff');
    expect(appState?.collaborators).toBeUndefined();
    expect(appState?.openMenu).toBeUndefined();
    expect(appState?.editingElement).toBeUndefined();
  });

  it('shows the Save label by default', () => {
    renderEditor({ dirty: true });
    expect(saveButton().textContent).toBe('common.save');
  });

  it('shows the saving label when saving', () => {
    renderEditor({ saving: true, dirty: true });
    expect(saveButton().textContent).toBe('sketch.saving');
  });

  it('disables the button while saving', () => {
    renderEditor({ saving: true, dirty: true });
    expect(saveButton().disabled).toBe(true);
  });

  it('disables the button when nothing is editable', () => {
    renderEditor({ scene: emptySketchScene(), dirty: false, hasPreservedRawItems: false });
    expect(saveButton().disabled).toBe(true);
  });

  it('enables the button when the scene has elements', () => {
    renderEditor({ scene: sceneWithElement() });
    expect(saveButton().disabled).toBe(false);
  });

  it('enables the button when dirty', () => {
    renderEditor({ dirty: true });
    expect(saveButton().disabled).toBe(false);
  });

  it('enables the button when there are preserved raw items', () => {
    renderEditor({ hasPreservedRawItems: true });
    expect(saveButton().disabled).toBe(false);
  });

  it('enables the button when legacy items need migration', () => {
    renderEditor({
      legacyItems: [{ kind: 'pen', points: [{ x: 10, y: 20 }], color: '#000', size: 2 }],
    });
    expect(saveButton().disabled).toBe(false);
  });

  it('calls onSave with the latest Excalidraw scene when clicked', () => {
    const onSave = vi.fn();
    renderEditor({ dirty: true, onSave });
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toMatchObject(mockData.excalidrawScene);
  });

  it('strips Excalidraw runtime app state before saving the latest scene', () => {
    mockData.excalidrawScene.appState = {
      viewBackgroundColor: '#ffffff',
      collaborators: new Map([['socket-1', { username: 'stale' }]]),
      openMenu: 'canvas',
      pendingImageElementId: 'image-1',
    };
    const onSave = vi.fn();
    renderEditor({ dirty: true, onSave });
    fireEvent.click(saveButton());

    const savedScene = onSave.mock.calls[0]?.[0] as ExcalidrawSketchScene;
    expect(savedScene.appState?.viewBackgroundColor).toBe('#ffffff');
    expect(savedScene.appState?.collaborators).toBeUndefined();
    expect(savedScene.appState?.openMenu).toBeUndefined();
    expect(savedScene.appState?.pendingImageElementId).toBeUndefined();
  });

  it('does not echo Excalidraw hydration changes back to the parent scene', () => {
    const onSceneChange = vi.fn();
    renderEditor({ onSceneChange });

    act(() => {
      mockData.lastProps?.onChange?.([], { viewBackgroundColor: '#ffffff' }, {});
    });

    expect(onSceneChange).not.toHaveBeenCalled();
  });

  it('reports user scene changes once and ignores duplicate Excalidraw updates', () => {
    const onSceneChange = vi.fn();
    renderEditor({ onSceneChange });

    act(() => {
      mockData.lastProps?.onChange?.([], { viewBackgroundColor: '#ffffff' }, {});
    });

    const elements = [{ id: 'drawn', type: 'rectangle', version: 1, versionNonce: 1, isDeleted: false }];
    act(() => {
      mockData.lastProps?.onChange?.(elements, { viewBackgroundColor: '#ffffff' }, {});
    });

    expect(onSceneChange).toHaveBeenCalledTimes(1);
    expect(onSceneChange.mock.calls[0]?.[1]).toEqual({
      markDirty: true,
      discardLegacyItems: true,
    });

    act(() => {
      mockData.lastProps?.onChange?.(elements, { viewBackgroundColor: '#ffffff' }, {});
    });

    expect(onSceneChange).toHaveBeenCalledTimes(1);
  });

  it('shows the checkmark icon after save completes', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    renderEditor({ dirty: true, onSave });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    const btn = saveButton();
    expect(btn.textContent).not.toBe('common.save');
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.disabled).toBe(false);
  });

  it('reverts to the Save label after the saved indicator expires', async () => {
    vi.useFakeTimers();
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderEditor({ dirty: true, onSave });
    await act(async () => {
      fireEvent.click(saveButton());
    });

    expect(saveButton().textContent).not.toBe('common.save');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(saveButton().textContent).toBe('common.save');
    expect(saveButton().disabled).toBe(false);
  });

  it('does not show the checkmark when save fails', async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    renderEditor({ dirty: true, onSave });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(saveButton().textContent).toBe('common.save');
    expect(saveButton().querySelector('svg')).toBeNull();
  });

  it('hides the checkmark when dirty becomes true after a successful save', async () => {
    vi.useFakeTimers();
    const onSave = vi.fn().mockResolvedValue(true);
    const { rerender } = renderEditor({ dirty: true, onSave });

    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(saveButton().querySelector('svg')).not.toBeNull();

    rerender(
      <SketchEditor
        scene={emptySketchScene('test.sketch.json')}
        onSceneChange={noop}
        onSave={onSave}
        fileName="test.sketch.json"
        dirty={false}
      />,
    );

    rerender(
      <SketchEditor
        scene={emptySketchScene('test.sketch.json')}
        onSceneChange={noop}
        onSave={onSave}
        fileName="test.sketch.json"
        dirty={true}
      />,
    );

    expect(saveButton().textContent).toBe('common.save');
    expect(saveButton().querySelector('svg')).toBeNull();
  });

  it('hides the checkmark when save fails if success indicator is still visible', async () => {
    vi.useFakeTimers();
    const onSave = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    renderEditor({ dirty: true, onSave });

    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(saveButton().textContent).not.toBe('common.save');

    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(saveButton().textContent).toBe('common.save');
    expect(saveButton().querySelector('svg')).toBeNull();
  });

  it('has an aria-label matching the default save state', () => {
    renderEditor();
    expect(saveButton().getAttribute('aria-label')).toBe('common.save');
  });

  it('has an aria-label when dirty is true', () => {
    renderEditor({ dirty: true });
    expect(saveButton().getAttribute('aria-label')).toBe('common.save');
  });

  it('has an aria-label showing saving state while saving', () => {
    renderEditor({ saving: true, dirty: true });
    expect(saveButton().getAttribute('aria-label')).toBe('sketch.saving');
  });

  it('has an aria-label showing saved state after successful save', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    renderEditor({ dirty: true, onSave });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    const btn = saveButton();
    expect(btn.getAttribute('aria-label')).toBe('sketch.saved');
    expect(btn.querySelector('svg')).not.toBeNull();
  });

  it('reverts the aria-label to default after saved indicator expires', async () => {
    vi.useFakeTimers();
    const onSave = vi.fn().mockResolvedValue(true);
    renderEditor({ dirty: true, onSave });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(saveButton().getAttribute('aria-label')).toBe('sketch.saved');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(saveButton().getAttribute('aria-label')).toBe('common.save');
  });

  it('keeps the aria-label as default when save fails', async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    renderEditor({ dirty: true, onSave });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(saveButton().getAttribute('aria-label')).toBe('common.save');
  });

  it('shows the default aria-label when dirty becomes true after a successful save', async () => {
    vi.useFakeTimers();
    const onSave = vi.fn().mockResolvedValue(true);
    const { rerender } = renderEditor({ dirty: true, onSave });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(saveButton().getAttribute('aria-label')).toBe('sketch.saved');
    rerender(
      <SketchEditor
        scene={emptySketchScene('test.sketch.json')}
        onSceneChange={noop}
        onSave={onSave}
        fileName="test.sketch.json"
        dirty={false}
      />,
    );
    rerender(
      <SketchEditor
        scene={emptySketchScene('test.sketch.json')}
        onSceneChange={noop}
        onSave={onSave}
        fileName="test.sketch.json"
        dirty={true}
      />,
    );
    expect(saveButton().getAttribute('aria-label')).toBe('common.save');
    expect(saveButton().querySelector('svg')).toBeNull();
  });
});
