import { deltaE2000, rgbToLab } from "./color.js";
import type { Rgb } from "./types.js";

export interface UvMesh {
  positions: Float32Array;
  /** u,v per vertex. */
  uvs: Float32Array;
  indices: Uint32Array;
}

export type UvSampler = (u: number, v: number) => Rgb;

export interface SubdivideOptions {
  /** Stop refining once the mesh reaches this many triangles (default 150 000). */
  maxTriangles?: number;
  /** Refine a triangle when samples across it differ by more than this ΔE00 (default 12). */
  deltaEThreshold?: number;
  /** Maximum refinement rounds (default 4). */
  maxDepth?: number;
  /** Do not split edges shorter than this, mm (default 0.4). */
  minEdgeMm?: number;
}

export interface SubdividedMesh {
  positions: Float32Array;
  indices: Uint32Array;
  /** sRGB colour per triangle sampled at its centroid. */
  triColors: Uint8Array;
  rounds: number;
}

/**
 * Adaptive, conforming (no T-junction) subdivision along texture colour boundaries.
 * Each round marks triangles whose corner/centroid samples disagree, splits every edge
 * of marked triangles at its midpoint, and re-triangulates neighbours red-green style.
 * Edges are keyed by position so UV seams stay watertight after welding.
 */
export function subdivideByColorContrast(mesh: UvMesh, sample: UvSampler, opts: SubdivideOptions = {}): SubdividedMesh {
  const maxTris = opts.maxTriangles ?? 150_000;
  const threshold = opts.deltaEThreshold ?? 12;
  const maxDepth = opts.maxDepth ?? 4;
  const minEdge = opts.minEdgeMm ?? 0.4;

  let pos: number[] = Array.from(mesh.positions);
  let uv: number[] = Array.from(mesh.uvs);
  let tris: number[][] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) tris.push([mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]]);

  const posKey = (v: number) => `${Math.round(pos[v * 3] * 1e4)},${Math.round(pos[v * 3 + 1] * 1e4)},${Math.round(pos[v * 3 + 2] * 1e4)}`;
  const edgeId = (a: number, b: number) => {
    const ka = posKey(a);
    const kb = posKey(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const len = (a: number, b: number) => Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
  const sampleLab = (u: number, v: number) => rgbToLab(sample(u, v));

  let rounds = 0;
  for (let depth = 0; depth < maxDepth; depth++) {
    const marked = new Set<string>();
    let markedCount = 0;
    for (const [a, b, c] of tris) {
      if (Math.max(len(a, b), len(b, c), len(c, a)) < minEdge * 2) continue;
      const labs = [
        sampleLab(uv[a * 2], uv[a * 2 + 1]),
        sampleLab(uv[b * 2], uv[b * 2 + 1]),
        sampleLab(uv[c * 2], uv[c * 2 + 1]),
        sampleLab((uv[a * 2] + uv[b * 2] + uv[c * 2]) / 3, (uv[a * 2 + 1] + uv[b * 2 + 1] + uv[c * 2 + 1]) / 3),
      ];
      let worst = 0;
      for (let i = 0; i < 4 && worst <= threshold; i++) for (let j = i + 1; j < 4; j++) worst = Math.max(worst, deltaE2000(labs[i], labs[j]));
      if (worst > threshold) {
        markedCount++;
        for (const [p, q] of [[a, b], [b, c], [c, a]]) if (len(p, q) >= minEdge * 2) marked.add(edgeId(p, q));
      }
    }
    if (markedCount === 0 || tris.length + markedCount * 3 > maxTris) break;

    const mids = new Map<string, number>(); // per directed index pair to keep UV seams separate
    const mid = (a: number, b: number): number => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      let m = mids.get(k);
      if (m === undefined) {
        m = pos.length / 3;
        pos.push((pos[a * 3] + pos[b * 3]) / 2, (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2, (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2);
        uv.push((uv[a * 2] + uv[b * 2]) / 2, (uv[a * 2 + 1] + uv[b * 2 + 1]) / 2);
        mids.set(k, m);
      }
      return m;
    };
    const next: number[][] = [];
    for (const tri of tris) {
      const [a, b, c] = tri;
      const sAB = marked.has(edgeId(a, b));
      const sBC = marked.has(edgeId(b, c));
      const sCA = marked.has(edgeId(c, a));
      const n = Number(sAB) + Number(sBC) + Number(sCA);
      if (n === 0) next.push(tri);
      else if (n === 3) {
        const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
        next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
      } else if (n === 1) {
        // rotate so the split edge is (p,q)
        const [p, q, r] = sAB ? [a, b, c] : sBC ? [b, c, a] : [c, a, b];
        const m = mid(p, q);
        next.push([p, m, r], [m, q, r]);
      } else {
        // two edges split: rotate so the unsplit edge is (r,p)
        const [p, q, r] = !sCA ? [a, b, c] : !sAB ? [b, c, a] : [c, a, b];
        const mpq = mid(p, q), mqr = mid(q, r);
        next.push([mpq, q, mqr], [p, mpq, mqr], [p, mqr, r]);
      }
    }
    tris = next;
    rounds++;
  }

  const triColors = new Uint8Array(tris.length * 3);
  const indices = new Uint32Array(tris.length * 3);
  tris.forEach(([a, b, c], i) => {
    indices.set([a, b, c], i * 3);
    const col = sample((uv[a * 2] + uv[b * 2] + uv[c * 2]) / 3, (uv[a * 2 + 1] + uv[b * 2 + 1] + uv[c * 2 + 1]) / 3);
    triColors.set(col, i * 3);
  });
  return { positions: new Float32Array(pos), indices, triColors, rounds };
}
