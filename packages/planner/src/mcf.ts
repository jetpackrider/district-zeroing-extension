/**
 * Integer min-cost flow with node supplies: successive shortest paths with Dijkstra on
 * reduced costs (Johnson potentials). All capacities and costs must be non-negative
 * integers. Convex piecewise costs are expressed as parallel arcs with ascending cost.
 *
 * Deterministic: arcs are scanned in insertion order, the heap breaks distance ties by
 * node index, and relaxation only replaces a label on a strictly smaller distance.
 */

export interface FlowArc {
  from: number;
  to: number;
  cap: number;
  cost: number;
}

export interface FlowResult {
  /** True when every supply reached a demand. */
  feasible: boolean;
  /** Flow on each input arc, same order as `arcs`. */
  flow: number[];
  /** Total cost of the flow that was shipped. */
  cost: number;
  /** Units shipped and units required (sum of positive supplies). */
  shipped: number;
  required: number;
}

function assertInt(x: number, what: string): void {
  if (!Number.isSafeInteger(x)) throw new Error(`minCostFlow: ${what} must be a safe integer, got ${x}`);
}

export function minCostFlow(numNodes: number, supply: ArrayLike<number>, arcs: readonly FlowArc[]): FlowResult {
  if (supply.length !== numNodes) throw new Error('minCostFlow: supply length must equal numNodes');
  let balance = 0;
  let required = 0;
  for (let v = 0; v < numNodes; v++) {
    assertInt(supply[v], 'supply');
    balance += supply[v];
    if (supply[v] > 0) required += supply[v];
  }
  if (balance !== 0) throw new Error(`minCostFlow: supplies must sum to 0, got ${balance}`);

  const N = numNodes + 2;
  const S = numNodes;
  const T = numNodes + 1;
  // Residual graph: edge 2i is forward, 2i+1 its reverse.
  const eTo: number[] = [];
  const eCap: number[] = [];
  const eCost: number[] = [];
  const adj: number[][] = [];
  for (let v = 0; v < N; v++) adj.push([]);
  const addEdge = (u: number, v: number, cap: number, cost: number): number => {
    const id = eTo.length;
    eTo.push(v, u);
    eCap.push(cap, 0);
    eCost.push(cost, -cost);
    adj[u].push(id);
    adj[v].push(id + 1);
    return id;
  };
  const arcEdge: number[] = [];
  for (const a of arcs) {
    if (a.from < 0 || a.from >= numNodes || a.to < 0 || a.to >= numNodes) throw new Error('minCostFlow: arc endpoint out of range');
    assertInt(a.cap, 'cap');
    assertInt(a.cost, 'cost');
    if (a.cap < 0) throw new Error('minCostFlow: negative capacity');
    if (a.cost < 0) throw new Error('minCostFlow: negative cost (not supported)');
    arcEdge.push(addEdge(a.from, a.to, a.cap, a.cost));
  }
  for (let v = 0; v < numNodes; v++) {
    if (supply[v] > 0) addEdge(S, v, supply[v], 0);
    else if (supply[v] < 0) addEdge(v, T, -supply[v], 0);
  }

  const pot = new Array<number>(N).fill(0);
  const dist = new Array<number>(N);
  const parentEdge = new Array<number>(N);
  const done = new Uint8Array(N);
  let shipped = 0;
  let cost = 0;

  // Binary heap of (dist, node) pairs, ordered by dist then node.
  const heapD: number[] = [];
  const heapV: number[] = [];
  const less = (i: number, j: number) => heapD[i] < heapD[j] || (heapD[i] === heapD[j] && heapV[i] < heapV[j]);
  const swap = (i: number, j: number) => {
    const d = heapD[i]; heapD[i] = heapD[j]; heapD[j] = d;
    const v = heapV[i]; heapV[i] = heapV[j]; heapV[j] = v;
  };
  const push = (d: number, v: number) => {
    heapD.push(d); heapV.push(v);
    let i = heapD.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(i, p)) break;
      swap(i, p); i = p;
    }
  };
  const pop = (): number => {
    const v = heapV[0];
    const lastD = heapD.pop()!;
    const lastV = heapV.pop()!;
    if (heapD.length > 0) {
      heapD[0] = lastD; heapV[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heapD.length && less(l, m)) m = l;
        if (r < heapD.length && less(r, m)) m = r;
        if (m === i) break;
        swap(i, m); i = m;
      }
    }
    return v;
  };

  while (shipped < required) {
    dist.fill(Infinity);
    parentEdge.fill(-1);
    done.fill(0);
    dist[S] = 0;
    push(0, S);
    while (heapD.length > 0) {
      const d = heapD[0];
      const u = pop();
      if (done[u] || d > dist[u]) continue;
      done[u] = 1;
      for (const e of adj[u]) {
        if (eCap[e] <= 0) continue;
        const v = eTo[e];
        if (done[v]) continue;
        const nd = d + eCost[e] + pot[u] - pot[v];
        if (nd < dist[v]) {
          dist[v] = nd;
          parentEdge[v] = e;
          push(nd, v);
        }
      }
    }
    if (!done[T]) break;
    for (let v = 0; v < N; v++) if (done[v]) pot[v] += dist[v];
    // Bottleneck along the path.
    let push_ = required - shipped;
    for (let v = T; v !== S; v = eTo[parentEdge[v] ^ 1]) push_ = Math.min(push_, eCap[parentEdge[v]]);
    for (let v = T; v !== S; v = eTo[parentEdge[v] ^ 1]) {
      const e = parentEdge[v];
      eCap[e] -= push_;
      eCap[e ^ 1] += push_;
      cost += push_ * eCost[e];
    }
    shipped += push_;
  }

  const flow = arcEdge.map((e) => eCap[e + 1]);
  return { feasible: shipped === required, flow, cost, shipped, required };
}
