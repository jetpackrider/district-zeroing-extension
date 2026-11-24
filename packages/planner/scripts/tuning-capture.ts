import { appendFileSync, readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Assignment, Solution } from '@zd/contracts';

const output = process.env.ZD_TUNING_CAPTURE;
let replay: Map<string, string> | undefined;

export function fixedAssignment(id: string, assignment: Assignment): Assignment {
  const input = process.env.ZD_TUNING_REPLAY;
  if (!input) return assignment;
  replay ??= new Map(readFileSync(input, 'utf8').trimEnd().split('\n').map(line => {
    const { id, assignment } = JSON.parse(line);
    return [id, assignment];
  }));
  const encoded = replay.get(id);
  if (!encoded) throw new Error(`Missing baseline assignment for ${id}`);
  const raw = gunzipSync(Buffer.from(encoded, 'base64'));
  return new Uint16Array(Uint8Array.from(raw).buffer);
}

export function capture(
  id: string, state: string, assignment: Assignment, status: string, ms: number,
  solutions: Solution[], verified: boolean[],
) {
  if (!output) return;
  if (verified.length !== solutions.length) throw new Error(`Missing verification for ${id}`);
  const packed = gzipSync(new Uint8Array(assignment.buffer, assignment.byteOffset, assignment.byteLength));
  appendFileSync(output, JSON.stringify({
    id, state, assignment: packed.toString('base64'), status, ms,
    solutions: solutions.map(({ kind, stats, transfers }, i) => ({ kind, stats, transfers, verified: verified[i] })),
  }) + '\n');
}
