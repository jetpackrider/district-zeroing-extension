import { mountPanel } from '../../adapters/panel-ui';
import { cleanSavedAreas } from '../../panel/area';
import { ExtensionController } from '../../panel/controller';
import { createMiniMap } from '../../panel/minimap';
import type { PanelHost } from '../../shared/panel-host';

const params = new URLSearchParams(location.search);
const host = (params.get('host') as PanelHost) || 'sidepanel';
const tabIdParam = params.get('tabId');

/** `extension:<path>` (the local build's embedded data) -> this extension's own URL for <path>. */
function resolveDataUrl(url: string): string {
  return url.startsWith('extension:') ? chrome.runtime.getURL(url.slice('extension:'.length)) : url;
}

async function main() {
  const settings = await chrome.storage.local.get(['dataBaseUrl', 'miniMapTiles', 'autoPaint', 'districtLocks', 'areas']);
  const dataBaseUrl = resolveDataUrl((settings.dataBaseUrl as string) || __ZD_DATA_URL__);
  // The fallback mini-map draws the blocks on a plain background. A basemap is opt-in (the
  // `miniMapTiles` setting), so the extension makes no third-party requests on its own.
  const tiles = typeof settings.miniMapTiles === 'string' ? settings.miniMapTiles : '';

  const controller = new ExtensionController({
    host,
    tabId: tabIdParam ? Number(tabIdParam) : null,
    dataBaseUrl,
    // "Paint the step for me": off unless the user turned it on (stored as exactly `true`).
    autoPaint: { enabled: settings.autoPaint === true, save: (enabled) => void chrome.storage.local.set({ autoPaint: enabled }) },
    // District locks, remembered per map.
    locks: {
      saved: settings.districtLocks && typeof settings.districtLocks === 'object' ? (settings.districtLocks as Record<string, number[]>) : {},
      save: (all) => void chrome.storage.local.set({ districtLocks: all }),
    },
    // The area to prefer for the swap, remembered per map like the locks.
    areas: {
      saved: cleanSavedAreas(settings.areas),
      save: (all) => void chrome.storage.local.set({ areas: all }),
    },
  });
  const root = document.getElementById('root')!;
  mountPanel(root, controller, {
    renderMiniMap: (container) => {
      const mm = createMiniMap(container, { tiles });
      controller.attachMiniSink(mm.sink, mm.area, mm.clusters);
      return () => {
        controller.attachMiniSink(null);
        mm.destroy();
      };
    },
  });
  controller.start();
  mountDiagnostics(controller);

  // CSV drag-and-drop anywhere on the panel (the panel UI may also offer its own drop zone).
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      depth++;
      document.body.classList.add('zd-dragging');
    }
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('zd-dragging');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    depth = 0;
    document.body.classList.remove('zd-dragging');
    if (e.defaultPrevented) return;
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) controller.dispatch({ type: 'load-csv', text: await file.text(), fileName: file.name });
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && controller.getState().walkthrough) controller.dispatch({ type: 'walkthrough-end' });
  });

  if (__ZD_TEST__) (window as unknown as { __zd: unknown }).__zd = controller;
}

/**
 * Diagnostics footer (outside the React panel, so it needs no panel-ui slot): a collapsed
 * <details> at the bottom of the panel page with the self-check, the hook version, the dataset
 * field and target read, the bundle's data version and any bundle/DRA population mismatch, plus a
 * Copy button. The same text goes to this page's console whenever it changes. Local only.
 */
function mountDiagnostics(controller: ExtensionController) {
  const box = document.getElementById('zd-diagnostics') as HTMLDetailsElement | null;
  const pre = document.getElementById('zd-diagnostics-text');
  const copy = document.getElementById('zd-diagnostics-copy');
  const summary = document.getElementById('zd-diagnostics-summary');
  if (!box || !pre || !copy || !summary) return;
  let last = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const render = () => {
    timer = null;
    const text = controller.diagnostics();
    const input = controller.diagnosticsInput();
    const bad = input.check && !input.check.ok ? 'hook check failed' : input.popCheck && input.popCheck.rows.some((r) => r.dra !== r.bundle) ? 'population mismatch' : '';
    summary.textContent = `Diagnostics${bad ? ` (${bad})` : ''}`;
    box.dataset.state = bad ? 'warn' : 'ok';
    if (text === last) return;
    pre.textContent = text;
    // Log only meaningful changes (not every timing tick).
    const key = text.replace(/^timings ms:.*$/m, '');
    if (key !== last.replace(/^timings ms:.*$/m, '')) console.info(`[zd] diagnostics\n${text}`);
    last = text;
  };
  controller.onDiagnosticsChange(() => {
    if (!timer) timer = setTimeout(render, 250);
  });
  copy.addEventListener('click', async () => {
    const text = controller.diagnostics();
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'Copied';
    } catch {
      // Clipboard can be refused (no focus); select the text so Cmd/Ctrl+C works.
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      copy.textContent = 'Selected: press Cmd/Ctrl+C';
    }
    setTimeout(() => (copy.textContent = 'Copy'), 2000);
  });
  render();
}

void main();
