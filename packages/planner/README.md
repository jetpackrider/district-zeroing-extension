# @zd/planner

Multi-district planner (SPEC.md "Balancing several districts"). Pure TypeScript, synchronous,
deterministic, no DOM or Node APIs; runs in the engine Worker on top of any `BorderSolver`.

```ts
import { planGroup, checkGroupFeasibility, buildInteractionGraph } from '@zd/planner';
import { borderSolver } from '@zd/engine';

checkGroupFeasibility({ graph, assignment, targets, districts });          // live "can this group zero?" line
buildInteractionGraph({ graph, assignment, targets, districts, solver: borderSolver }); // schematic, before solving
const result = planGroup({ graph, assignment, targets, districts, solver: borderSolver, onProgress });
```

`planGroup` returns the contract's `GroupSolveResult` plus `failures` (why a plan kind produced nothing).

## How it works

1. **Feasibility** (`feasibility.ts`). The selection is split into connected pieces (district adjacency
   restricted to the selection). Each piece must fit `[k·q, k·(q + hi)]`, where `hi = 1` when the state
   has a remainder. Otherwise the result is `group-unbalanced` with the signed excess and the adjacent
   outside districts that would help (opposite-signed deviation, ranked by the excess left after adding each).
   With `allowOutsideAbsorb`, a piece with an allowed outside neighbor is feasible. Omit
   `absorbers` to allow all adjacent outsiders, or list their district IDs to restrict giving
   and receiving in both flow and repair. A group of one can trade both ways with a single
   chosen neighbor.
2. **Interaction map** (`interaction.ts`): `solver.capacity` in both directions for every neighboring pair.
3. **Min-cost flow** (`mcf.ts`, `flowModel.ts`). Successive shortest paths with Dijkstra and potentials,
   integer costs, deterministic tie-breaks. District nodes have supply `pop − q`. A sink `T` takes up to one
   extra person per district (arcs of capacity `hi`). Each capacity tier is a parallel arc, so convex costs
   fill cheapest first. Outside absorbers are split into in- and out-nodes, so they absorb or give but never
   relay. Their convex cost is cheap toward zero, half-penalized while no worse than now, then fully
   penalized. Fixed charges for using a border go through deterministic slope scaling. Expensive slack
   arcs leave residual amounts for local repair or for another round.
4. **Realization, stage 1** (`plan.ts`), largest transfer first, on the updated assignment with moved
   blocks locked. Each option is re-checked locally (blocks in `from`, unlocked, total in `accept`, no new
   piece for either district). When a border's exact amount cannot be delivered:
   - at most `DEFER_MAX` people: the border is left out and stage 2 places those people;
   - larger: it is realized within a window (`accept` = target ± up to `WINDOW_MAX`, the solver picks the
     cheapest) and stage 2 takes the difference;
   - if even the window fails, a probe asks for the largest reachable amount below it, that border's
     capacity is lowered (to the probe result, else half), and the round is re-planned from the flow step
     (at most `MAX_REPLANS` times).
   Border answers are memoized by the state of their two districts. Unfinished maps take several rounds
   (`MAX_ROUNDS`); between rounds, every direction that carried people is re-measured.
5. **Realization, stage 2: residual repair** (`repair.ts`), in the last round. On real maps some small exact
   amounts cannot be moved at all (NYC blocks hold dozens of people, so "exactly 1 person from 15 to 14"
   has no answer), and capacity curves cannot see that. Repair works on the per-district residuals left
   by stage 1 and searches over amounts the solver has really delivered:
   - Per directed border it asks for a menu with `accept` = 1..M and `maxOptions` 8. It also makes targeted
     requests for amounts that would finish a district or complement a known option in a swap.
   - it then looks, by iterative deepening on the number of transfers (at most `REPAIR_MAX_DEPTH`), for
     the fewest transfers that put every selected district at q or q + 1. It tries one-way moves, a **two-way
     trade** (x one way and x − r back), **chains** through middle districts, and **cycles** of
     three or more. Which districts keep q + 1 is free (each only has to land in its band);
   - greedy over districts: it zeroes the district furthest from zero without pushing any other selected
     district further out, commits, and repeats, so it always terminates;
   - every question in one local search is asked on the same state, so an option is always made of blocks
     its giving district holds then: a block that crossed one way is never in the return trade (and all
     moved blocks are locked for later questions). The chosen combination is applied in order and each
     transfer re-checked (no overlap, no new piece); a failing option is banned and the search reruns.
   If repair cannot place a residual, the borders it blames get lower caps and the round is re-planned
   (at most `MAX_REPAIR_REPLANS` times); after that the kind fails with `failures[].stuck` (the district,
   its remaining residual, the neighbors searched) and the message says which district could not be
   placed. Solver calls are bounded (`REPAIR_CALL_BUDGET` per district search).
6. **Whole-plan check** (`verify.ts`). Independent code: it applies the transfers itself, recounts
   populations, and counts pieces with union-find. A failure lowers the implicated border and re-plans.
7. **Alternatives**: kinds `fewest-splits`, `fewest-blocks` and `fewest-districts`, with plans that have
   the same effect dropped. Stats, `borderFlows` and `deviations` are computed exactly on the final plan
   (`stats.ts`). `transfers` are in the order they must be applied (stage 1, then repair; a swap's legs in
   order). `borderFlows` has one entry per direction used with its gross people, so a two-way trade shows
   up as both `4 → 7` and `7 → 4`. `stats.people` / `stats.blocks` count both legs.
   `stats.steps` counts each distinct precinct in each transfer. Plans rank by exact cost, including a fixed
   fee for every shared border used.
8. **Last resort**. The engine's normal solver only returns compact transfers. If all three plan
   kinds finish without a verified plan, the planner can retry with the engine's optional
   `lastResort` solver. It still asks for compact moves first on each amount and returns at most
   one verified rescue. A plan with any relaxed transfer carries `stats.longReach: true`, and the
   compact attempt diagnostics remain in `failures`.

**Sharing capacity curves.** `buildInteractionGraph` and `planGroup` both measure a capacity curve per
border and direction (about two thirds of a whole-map run on New York). Pass the same `CurveCache` to both
(`buildInteractionGraph({ ..., curveCache })`, `planGroup(req, { curveCache })`) and planning reuses the
view's curves. The cache distinguishes graph and solver objects, then fingerprints the assignment, locked mask and
weights. A graph with updated town or water data gets its own curves.

### Compact transfers and costs

The compact engine path caps every move at four hops from the recipient's territory at the
start of that transfer. Each occupied block reaches that territory through moved occupied
blocks. Empty pockets may follow when they touch the populated bite and would be cut off
from the remaining donor. They must stay within the hop limit and can account for at most
half the blocks. The engine checks these rules after contiguity settlement. Repair also
checks each leg of a trade in the order it would be painted.

The shared scoring defaults charge 100 for a new precinct split, credit 85 for healing one, and
charge 800 for another district entering a county and 420 for newly dividing a town. Town index
zero is ignored. The no-split capacity tier preserves all three geographies. Low capacity can
split precincts, and high capacity can add county or town splits. Each painted precinct per
transfer costs 240 even if already split. The exact plan score also charges 240 per distinct
shared border at these defaults. Flow approximates that preference with fixed charges of
420, 450, and 620 ranking units for the three plan kinds, respectively, after converting
each kind's integer scale.

The perimeter weight is 0.006 per meter of summed district perimeter. The engine grows most
exact-population prefixes toward the receiving district or blocks already in the chunk. The
cost of a candidate prefix also accounts for how much new boundary it creates per person.
`measureTransferShape` in `@zd/engine` reports this change for the shared border, plus the
fraction of its donor/recipient contact that still faces the donor. A value of 50% means the
old and new shared boundaries have equal length. For multi-step plans measure each transfer
against the assignment at that step.

The fewest-blocks variant still increases the block costs and reduces the precinct split cost.
It uses the same county, town and perimeter weights as the other variants. Flow also charges a
small per-person premium for the tiers that allow splits because the witness cost is averaged
over the whole capacity tier.

## County clusters

`findCountyClusters(req)` (src/clusters.ts, contract in packages/contracts/src/clusters.ts) splits a
state into groups of whole, contiguous counties, each holding a whole number k ≥ 1 of districts
within the tolerance, as North Carolina's legislative maps require: most clusters first, then the
smallest worst deviation, then the smallest largest cluster. Counties touch when any of their blocks
do, water and DRA's links included (county lines run through rivers and sounds). The search is exact
(pruned enumeration of the cluster holding one county, pieces solved independently and memoized by
county set and district count, bounded by LP-dual county weights) and falls back to greedy peeling
plus large-neighbourhood search when the time limit (default 10 s) runs out; `exhaustive` is true
only when the exact search finished. The district counts are chosen so they add up to
`numDistricts` (not automatic: 20 counties of 1.05 districts hold 21). `verifyClustering` checks a
result independently. `tsx scripts/clusters-real.ts` runs it on real bundles (`--list` prints the
clusters, `--log` the phases).

## Tests

`npm test` uses a reference `BorderSolver` (test/support/refSolver.ts) on seeded synthetic grids
(test/support/synth.ts). `npm run test:engine` runs the same scenarios against `packages/engine`.
test/trades.test.ts covers two-way trades, cycles, chains, the no-block-twice rule on a return trade and
impossible residuals with `RestrictedSolver` (test/support/restricted.ts), which lets each border and
direction deliver only a fixed set of amounts; it always wraps the reference solver, so it does not
depend on the engine.
Benchmarks: `npm run bench` (reference solver) and `npm run bench:engine` (291,600 blocks, 26 districts).

Real New York fixtures in `data/NY`: `tsx scripts/ny-sweep.ts` (whole map, blocks-per-district 1..4 × seeds
1..5), `tsx scripts/ny-groups.ts` (hand-picked groups), `tsx scripts/ny-profile.ts` (where the time goes),
`tsx scripts/ny-real.ts`, `tsx scripts/ny-one.ts blocks seed` (one run; `ZD_REPAIR_DEBUG=1` prints the
menus around a district repair could not place). `npx tsx scripts/ny-reach.ts [STATE] [runs]`
recounts the steps, depth, empty blocks and long-reach transfers in verified congressional plans.
