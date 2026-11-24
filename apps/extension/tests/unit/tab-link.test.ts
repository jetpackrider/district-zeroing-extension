/**
 * TabLink.stage(): which link of tab -> content script (relay) -> page hook has answered.
 * The first live run sat on "Connecting" with no way to tell these apart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wrap, type HookToPanel } from '../../src/shared/protocol';

interface FakePort {
  name: string;
  posted: unknown[];
  onMessage: { addListener: (f: (d: unknown) => void) => void };
  onDisconnect: { addListener: (f: () => void) => void };
  postMessage: (m: unknown) => void;
  disconnect: () => void;
  receive: (m: HookToPanel) => void;
  drop: (error?: string) => void;
}

let ports: FakePort[];
let runtimeLastError: { message: string } | undefined;

function fakePort(name: string): FakePort {
  const msg: Array<(d: unknown) => void> = [];
  const disc: Array<() => void> = [];
  return {
    name,
    posted: [],
    onMessage: { addListener: (f) => msg.push(f) },
    onDisconnect: { addListener: (f) => disc.push(f) },
    postMessage(m) { this.posted.push(m); },
    disconnect() {},
    receive: (m) => msg.forEach((f) => f(wrap(m))),
    drop: (error) => {
      runtimeLastError = error ? { message: error } : undefined;
      disc.forEach((f) => f());
      runtimeLastError = undefined;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  ports = [];
  const listeners = { addListener: () => {} };
  (globalThis as any).__ZD_HOST_PATTERNS__ = ['https://davesredistricting.org/*'];
  (globalThis as any).chrome = {
    windows: { getCurrent: async () => ({ id: 1 }) },
    runtime: {
      connect: () => fakePort('life'),
      get lastError() { return runtimeLastError; },
    },
    tabs: {
      onActivated: listeners,
      onUpdated: listeners,
      onRemoved: listeners,
      query: async () => [{ id: 7, url: 'https://davesredistricting.org/maps#viewmap::abc' }],
      get: async () => ({ id: 7, url: 'https://davesredistricting.org/maps#viewmap::abc' }),
      connect: () => {
        const p = fakePort('zd-panel');
        ports.push(p);
        return p;
      },
      reload: vi.fn(),
    },
  };
});
afterEach(() => vi.useRealTimers());

async function start() {
  const { TabLink } = await import('../../src/panel/tab-link');
  const statuses: string[] = [];
  const messages: HookToPanel[] = [];
  const link = new TabLink('sidepanel', null, (m) => messages.push(m), (s) => statuses.push(s.kind));
  await link.start();
  return { link, statuses, messages };
}

describe('TabLink.stage', () => {
  it('reports no-content-script after two attempts that nothing in the tab answered', async () => {
    const { link } = await start();
    expect(link.stage()).toBe('trying');
    ports[0].drop('Could not establish connection. Receiving end does not exist.');
    expect(link.stage()).toBe('trying'); // one failure can be a page that is still loading
    await vi.advanceTimersByTimeAsync(1000);
    ports[1].drop('Could not establish connection. Receiving end does not exist.');
    expect(link.stage()).toBe('no-content-script');
    expect(link.failedAttempts).toBe(2);
    expect(link.lastConnectError).toContain('Receiving end does not exist');
    expect(link.status.kind).toBe('connecting');
  });

  it('reports relay-only when the content script answers but has no hook channel, without calling it connected', async () => {
    const { link, messages } = await start();
    ports[0].receive({ t: 'relay', hookAttached: false, readyState: 'complete', ageMs: 5000 });
    expect(link.stage()).toBe('relay-only');
    expect(link.status.kind).toBe('connecting');
    expect(messages).toEqual([]); // the relay's own status is not a hook message
  });

  it('reports hook once the page hook says it is alive, and forgets everything when the page goes away', async () => {
    const { link, messages } = await start();
    ports[0].receive({ t: 'relay', hookAttached: true, readyState: 'complete', ageMs: 5000 });
    expect(link.stage()).toBe('trying');
    ports[0].receive({ t: 'alive', hookVersion: '1', draPresent: true, planOpen: false, readyState: 'complete', offers: 2 });
    expect(link.stage()).toBe('hook');
    expect(link.status.kind).toBe('connected');
    expect(messages.map((m) => m.t)).toEqual(['alive']);
    ports[0].drop(); // tab reloaded
    expect(link.relay).toBeNull();
    expect(link.alive).toBeNull();
    expect(link.failedAttempts).toBe(0); // it had answered, so this is not a failed attempt
    expect(link.stage()).toBe('trying');
  });
});
