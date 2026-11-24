import { describe, expect, it } from 'vitest';
import { computeGraphLayout } from '../src/layout/graphLayout';
import { GROUP_CHAIN_INTERACTION, buildInteractionForDistricts, makeNYDistricts } from '../src/mock/scenarios';

describe('computeGraphLayout', () => {
  it('produces identical coordinates regardless of input node order (deterministic)', () => {
    const a = computeGraphLayout(GROUP_CHAIN_INTERACTION, 360);
    const reversed = {
      nodes: [...GROUP_CHAIN_INTERACTION.nodes].reverse(),
      edges: [...GROUP_CHAIN_INTERACTION.edges].reverse(),
    };
    const b = computeGraphLayout(reversed, 360);

    expect(a.nodes).toEqual(b.nodes);
    expect(a.width).toBe(360);
    expect(a.edges).toHaveLength(4);
  });

  it('keeps all 26 NY whole-map nodes inside viewport bounds with finite coordinates', () => {
    const districts = makeNYDistricts();
    const graph = buildInteractionForDistricts(
      districts,
      districts.map((d) => d.index),
    );
    const layout = computeGraphLayout(graph, 360);

    expect(layout.nodes).toHaveLength(26);
    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(node.x).toBeGreaterThanOrEqual(layout.nodeRadius);
      expect(node.x).toBeLessThanOrEqual(layout.width - layout.nodeRadius);
      expect(node.y).toBeGreaterThanOrEqual(layout.nodeRadius);
      expect(node.y).toBeLessThanOrEqual(layout.height - layout.nodeRadius);
    }

    // Verify no pair of circles overlaps
    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        const dist = Math.hypot(
          layout.nodes[i].x - layout.nodes[j].x,
          layout.nodes[i].y - layout.nodes[j].y,
        );
        expect(dist).toBeGreaterThanOrEqual(layout.nodeRadius * 2);
      }
    }
  });

  it('handles disconnected components cleanly without NaN coordinates', () => {
    const graph = {
      nodes: [
        { district: 1, deviation: 200 },
        { district: 2, deviation: -100 },
        { district: 9, deviation: 50 },
        { district: 10, deviation: -150 },
      ],
      edges: [
        { a: 1, b: 2, cheapAtoB: 200, cheapBtoA: 150, maxAtoB: 600, maxBtoA: 500 },
        { a: 9, b: 10, cheapAtoB: 100, cheapBtoA: 100, maxAtoB: 400, maxBtoA: 400 },
      ],
    };
    const layout = computeGraphLayout(graph, 360);
    expect(layout.nodes).toHaveLength(4);
    for (const n of layout.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });
});
