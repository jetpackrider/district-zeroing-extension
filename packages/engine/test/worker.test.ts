import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { borderReachability, borderSolver, solveDistrict } from '../src/index';
import { verifySolution } from '../src/verify';
import { synthetic } from '../scripts/synthetic';

function findChromium(): { bin: string; extraArgs: string[] } {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return { bin: process.env.CHROME_PATH, extraArgs: ['--headless=new'] };
  }
  const cacheDir = join(homedir(), 'Library/Caches/ms-playwright');
  if (existsSync(cacheDir)) {
    const shells = readdirSync(cacheDir).filter(d => d.startsWith('chromium_headless_shell-')).sort().reverse();
    for (const dir of shells) {
      for (const sub of [
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
        'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-linux/headless_shell',
      ]) {
        const candidate = join(cacheDir, dir, sub);
        if (existsSync(candidate)) return { bin: candidate, extraArgs: [] };
      }
    }
  }
  for (const bin of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ]) {
    if (existsSync(bin)) return { bin, extraArgs: ['--headless=new'] };
  }
  throw new Error('No Chromium binary found. Set CHROME_PATH to a Chrome/Chromium executable.');
}

async function launchChromium(): Promise<{ wsUrl: string; close: () => Promise<void> }> {
  const { bin, extraArgs } = findChromium();
  const profile = mkdtempSync(join(tmpdir(), 'zd-worker-test-'));
  const proc: ChildProcess = spawn(bin, [
    ...extraArgs,
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const wsUrl = await new Promise<string>((res, rej) => {
    let stderr = '';
    const timer = setTimeout(() => rej(new Error(`Timed out launching Chromium. stderr:\n${stderr}`)), 15_000);
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        res(match[1]);
      }
    });
    proc.on('error', err => { clearTimeout(timer); rej(err); });
    proc.on('exit', code => { clearTimeout(timer); rej(new Error(`Chromium exited (${code}). stderr:\n${stderr}`)); });
  });

  return {
    wsUrl,
    close: async () => {
      if (proc.exitCode === null) {
        proc.kill('SIGTERM');
        await new Promise<void>(r => {
          const t = setTimeout(() => { proc.kill('SIGKILL'); r(); }, 3000);
          proc.once('exit', () => { clearTimeout(t); r(); });
        });
      }
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

class CdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true });
      ws.addEventListener('error', () => rej(new Error(`CDP WebSocket error connecting to ${url}`)), { once: true });
    });
    return new CdpClient(ws);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    this.ws.close();
  }
}

function serializeSolve(res: ReturnType<typeof solveDistrict>) {
  return {
    status: res.status,
    message: res.message,
    solutions: res.solutions.map(s => ({
      ...s,
      transfers: s.transfers.map(t => ({ ...t, blocks: Array.from(t.blocks) })),
    })),
  };
}

function serializeScored(list: ReturnType<typeof borderSolver.solveScored>) {
  return list.map(({ transfer, stats }) => ({
    transfer: { ...transfer, blocks: Array.from(transfer.blocks) },
    stats,
  }));
}

describe('Web Worker in headless Chromium', () => {
  it('bundles with platform=browser, runs in a dedicated Worker, and matches Node output', async () => {
    const entry = resolve(import.meta.dirname, '../src/index.ts');
    const bundled = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
    });
    const engineBundle = bundled.outputFiles[0].text;

    const req = synthetic(487, 16913);
    const locked = new Uint8Array(req.graph.n);
    locked[0] = 1;

    // Reference Node results
    const nodeDistrict = solveDistrict(req);
    const nodeCap = borderSolver.capacity({ graph: req.graph, assignment: req.assignment, from: 1, to: 2, locked });
    const nodeBorder = borderSolver.solveScored({
      graph: req.graph, assignment: req.assignment, from: 1, to: 2, accept: [243], maxOptions: 3, locked,
    });
    const nodeReach = borderReachability({
      graph: req.graph, assignment: req.assignment, from: 1, to: 2, maxPeople: 250, locked,
    });

    const workerCode = `
import { solveDistrict, borderSolver, borderReachability } from '/engine.js';
self.onmessage = (ev) => {
  try {
    const { graph, assignment, targets, district, locked } = ev.data;
    const isDedicatedWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
    const noDom = typeof window === 'undefined' && typeof document === 'undefined';
    const districtRes = solveDistrict({ graph, assignment, targets, district });
    const capRes = borderSolver.capacity({ graph, assignment, from: 1, to: 2, locked });
    const borderRes = borderSolver.solveScored({ graph, assignment, from: 1, to: 2, accept: [243], maxOptions: 3, locked });
    const reachRes = borderReachability({ graph, assignment, from: 1, to: 2, maxPeople: 250, locked });
    // Also verify determinism across repeated calls on the same cached graph inside the Worker
    const districtRes2 = solveDistrict({ graph, assignment, targets, district });
    self.postMessage({
      ok: true,
      env: { isDedicatedWorker, noDom },
      districtElapsedMs: districtRes.elapsedMs,
      district: {
        status: districtRes.status,
        message: districtRes.message,
        solutions: districtRes.solutions.map(s => ({
          ...s,
          transfers: s.transfers.map(t => ({ ...t, blocks: Array.from(t.blocks) })),
        })),
      },
      district2: {
        status: districtRes2.status,
        message: districtRes2.message,
        solutions: districtRes2.solutions.map(s => ({
          ...s,
          transfers: s.transfers.map(t => ({ ...t, blocks: Array.from(t.blocks) })),
        })),
      },
      capacity: capRes,
      border: borderRes.map(({ transfer, stats }) => ({
        transfer: { ...transfer, blocks: Array.from(transfer.blocks) },
        stats,
      })),
      reach: {
        minReachable: reachRes.minReachable,
        maxReachable: reachRes.maxReachable,
        denseRange: reachRes.denseRange,
        gaps: reachRes.gaps,
        nearest200: reachRes.nearest(200),
      },
    });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.stack || err.message : String(err) });
  }
};
`;

    // Pack the synthetic fixture into a binary payload so the page reconstructs exact TypedArrays
    // and passes them to the Worker via postMessage (same as the real extension).
    const payload = {
      n: req.graph.n,
      targets: req.targets,
      district: req.district,
      pop: Array.from(req.graph.pop),
      countyOf: Array.from(req.graph.countyOf),
      precinctOf: Array.from(req.graph.precinctOf),
      adjOffsets: Array.from(req.graph.adjOffsets),
      adjTargets: Array.from(req.graph.adjTargets),
      adjLen: Array.from(req.graph.adjLen),
      outerLen: Array.from(req.graph.outerLen),
      areaM2: Array.from(req.graph.areaM2),
      assignment: Array.from(req.assignment),
      locked: Array.from(locked),
    };
    const payloadJson = JSON.stringify(payload);

    const html = `<!doctype html><html><body><script type="module">
window.__run = async () => {
  const data = await (await fetch('/fixture.json')).json();
  const graph = {
    n: data.n,
    pop: Int32Array.from(data.pop),
    countyOf: Uint16Array.from(data.countyOf),
    precinctOf: Uint32Array.from(data.precinctOf),
    adjOffsets: Uint32Array.from(data.adjOffsets),
    adjTargets: Uint32Array.from(data.adjTargets),
    adjLen: Uint16Array.from(data.adjLen),
    outerLen: Uint32Array.from(data.outerLen),
    areaM2: Float32Array.from(data.areaM2),
  };
  const assignment = Uint16Array.from(data.assignment);
  const locked = Uint8Array.from(data.locked);
  const worker = new Worker('/worker.js', { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      worker.onerror = (e) => reject(new Error(e.message || 'Worker error'));
      worker.onmessage = (e) => resolve(e.data);
      worker.postMessage({ graph, assignment, targets: data.targets, district: data.district, locked });
    });
  } finally {
    worker.terminate();
  }
};
</script></body></html>`;

    const server = createServer((reqHttp, res) => {
      if (reqHttp.url === '/engine.js') {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
        res.end(engineBundle);
      } else if (reqHttp.url === '/worker.js') {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
        res.end(workerCode);
      } else if (reqHttp.url === '/fixture.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(payloadJson);
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      }
    });

    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind HTTP server');
    const url = `http://127.0.0.1:${addr.port}/`;

    const browser = await launchChromium();
    let cdp: CdpClient | undefined;
    try {
      cdp = await CdpClient.connect(browser.wsUrl);
      const { targetId } = await cdp.send('Target.createTarget', { url });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Runtime.enable', {}, sessionId);

      // Wait for window.__run to be defined after module script parses
      const evalRes = await cdp.send('Runtime.evaluate', {
        expression: `(async () => {
          for (let i = 0; i < 200 && !window.__run; i++) await new Promise(r => setTimeout(r, 25));
          if (!window.__run) throw new Error('window.__run never initialized');
          return await window.__run();
        })()`,
        awaitPromise: true,
        returnByValue: true,
      }, sessionId);

      if (evalRes.exceptionDetails) {
        throw new Error(`Browser exception: ${JSON.stringify(evalRes.exceptionDetails)}`);
      }
      const workerResult = evalRes.result.value;
      expect(workerResult.ok, workerResult.error).toBe(true);
      expect(workerResult.env).toEqual({ isDedicatedWorker: true, noDom: true });
      expect(typeof workerResult.districtElapsedMs).toBe('number');
      expect(Number.isFinite(workerResult.districtElapsedMs)).toBe(true);
      expect(workerResult.districtElapsedMs).toBeGreaterThan(0);

      expect(workerResult.district).toEqual(serializeSolve(nodeDistrict));
      expect(workerResult.district2).toEqual(workerResult.district);
      expect(workerResult.capacity).toEqual(nodeCap);
      expect(workerResult.border).toEqual(serializeScored(nodeBorder));
      expect(workerResult.reach).toEqual({
        minReachable: nodeReach.minReachable,
        maxReachable: nodeReach.maxReachable,
        denseRange: nodeReach.denseRange,
        gaps: nodeReach.gaps,
        nearest200: nodeReach.nearest(200),
      });

      // Independently verify every solution returned by the Worker
      for (const sol of workerResult.district.solutions) {
        const reconstructed = {
          ...sol,
          transfers: sol.transfers.map((t: any) => ({ ...t, blocks: Uint32Array.from(t.blocks) })),
        };
        expect(verifySolution(req.graph, req.assignment, req.targets, reconstructed, {
          districts: [req.district], neighborTolerance: 0,
        })).toEqual({ ok: true });
      }
    } finally {
      cdp?.close();
      await browser.close();
      await new Promise<void>(r => server.close(() => r()));
    }
  }, 30_000);
});
