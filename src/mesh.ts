import type { IndexedMesh, ManifoldReport, PrintabilityReport } from "./types.js";

export interface RepairOptions {
  /** Vertices closer than this (mm) are merged (default 0.001). */
  weldPrecisionMm?: number;
  /** Close open boundary loops with a centroid fan (default true). */
  capOpenLoops?: boolean;
  /** Make winding consistent across shared edges (default true). */
  fixWinding?: boolean;
  /** Flip any closed component with negative signed volume (default true). */
  ensurePositiveVolume?: boolean;
  /** Push every vertex outward along its smoothed normal by this many mm (default 0). */
  inflateMm?: number;
}

export interface RepairResult<T> {
  positions: Float32Array;
  indices: Uint32Array;
  /** Per-triangle payload carried through repair (e.g. slot numbers), new triangles inherit a neighbour's. */
  triData?: T[];
  report: ManifoldReport;
}

function edgeKey(a: number, b: number): number {
  // Safe for vertex counts below 2^26 (~67M).
  return a < b ? a * 67108864 + b : b * 67108864 + a;
}

interface EdgeStats {
  open: number;
  nonManifold: number;
  reversed: number;
}

/** Count open, non-manifold and inconsistently wound edges of an indexed mesh. */
export function analyzeEdges(indices: Uint32Array | number[]): EdgeStats {
  const count = new Map<number, number>();
  const dirs = new Map<number, number>();
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const u = indices[t + e];
      const v = indices[t + ((e + 1) % 3)];
      const k = edgeKey(u, v);
      count.set(k, (count.get(k) ?? 0) + 1);
      dirs.set(k, (dirs.get(k) ?? 0) + (u < v ? 1 : -1));
    }
  }
  let open = 0;
  let nonManifold = 0;
  let reversed = 0;
  for (const [k, c] of count) {
    if (c === 1) open++;
    else if (c > 2) nonManifold++;
    else if (dirs.get(k) !== 0) reversed++;
  }
  return { open, nonManifold, reversed };
}

function signedVolume(pos: ArrayLike<number>, tris: number[][], subset?: number[]): number {
  let vol = 0;
  const list = subset ?? tris.map((_, i) => i);
  for (const t of list) {
    const [a, b, c] = tris[t];
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
    vol += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  return vol;
}

function buildEdgeMap(tris: number[][]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (let t = 0; t < tris.length; t++) {
    const tri = tris[t];
    for (let e = 0; e < 3; e++) {
      const k = edgeKey(tri[e], tri[(e + 1) % 3]);
      let list = m.get(k);
      if (!list) m.set(k, (list = []));
      list.push(t);
    }
  }
  return m;
}

function hasDirectedEdge(tri: number[], u: number, v: number): boolean {
  return (tri[0] === u && tri[1] === v) || (tri[1] === u && tri[2] === v) || (tri[2] === u && tri[0] === v);
}

function orientConsistently(tris: number[][]): void {
  const edges = buildEdgeMap(tris);
  const visited = new Uint8Array(tris.length);
  for (let start = 0; start < tris.length; start++) {
    if (visited[start]) continue;
    visited[start] = 1;
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      const tri = tris[cur];
      for (let e = 0; e < 3; e++) {
        const u = tri[e];
        const v = tri[(e + 1) % 3];
        const nbs = edges.get(edgeKey(u, v))!;
        if (nbs.length !== 2) continue;
        const nb = nbs[0] === cur ? nbs[1] : nbs[0];
        if (visited[nb]) continue;
        if (hasDirectedEdge(tris[nb], u, v)) {
          const t = tris[nb];
          tris[nb] = [t[0], t[2], t[1]];
        }
        visited[nb] = 1;
        queue.push(nb);
      }
    }
  }
}

function components(tris: number[][]): number[][] {
  const edges = buildEdgeMap(tris);
  const visited = new Uint8Array(tris.length);
  const out: number[][] = [];
  for (let start = 0; start < tris.length; start++) {
    if (visited[start]) continue;
    visited[start] = 1;
    const comp = [start];
    for (let head = 0; head < comp.length; head++) {
      const tri = tris[comp[head]];
      for (let e = 0; e < 3; e++) {
        for (const nb of edges.get(edgeKey(tri[e], tri[(e + 1) % 3]))!) {
          if (!visited[nb]) {
            visited[nb] = 1;
            comp.push(nb);
          }
        }
      }
    }
    out.push(comp);
  }
  return out;
}

/**
 * Weld, re-orient, cap and optionally thicken a mesh so slicers see closed, outward-facing shells.
 * Works per part; per-triangle data (slots, colours) is carried through.
 */
export function repairMesh<T = never>(mesh: IndexedMesh, triData?: T[], opts: RepairOptions = {}): RepairResult<T> {
  const precision = opts.weldPrecisionMm ?? 0.001;
  const src = mesh.positions;
  const before = analyzeEdges(mesh.indices);
  const inv = 1 / precision;

  // Weld
  const verts: number[] = [];
  const remap = new Uint32Array(src.length / 3);
  const lookup = new Map<string, number>();
  for (let i = 0; i < src.length / 3; i++) {
    const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let id = lookup.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      verts.push(x, y, z);
      lookup.set(key, id);
    }
    remap[i] = id;
  }

  const tris: number[][] = [];
  const data: T[] = [];
  let degenerate = 0;
  const seenTri = new Set<string>();
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const a = remap[mesh.indices[t * 3]];
    const b = remap[mesh.indices[t * 3 + 1]];
    const c = remap[mesh.indices[t * 3 + 2]];
    if (a === b || b === c || c === a) {
      degenerate++;
      continue;
    }
    const sorted = [a, b, c].sort((p, q) => p - q).join(",");
    if (seenTri.has(sorted)) {
      degenerate++;
      continue;
    }
    seenTri.add(sorted);
    tris.push([a, b, c]);
    if (triData) data.push(triData[t]);
  }

  if (opts.fixWinding ?? true) orientConsistently(tris);

  // Cap open boundary loops
  let cappedLoops = 0;
  let cappedTriangles = 0;
  if (opts.capOpenLoops ?? true) {
    const edges = buildEdgeMap(tris);
    const next = new Map<number, { to: number; tri: number }[]>();
    const boundary: { u: number; v: number; tri: number }[] = [];
    for (let t = 0; t < tris.length; t++) {
      const tri = tris[t];
      for (let e = 0; e < 3; e++) {
        const u = tri[e];
        const v = tri[(e + 1) % 3];
        if (edges.get(edgeKey(u, v))!.length === 1) {
          boundary.push({ u, v, tri: t });
          let arr = next.get(u);
          if (!arr) next.set(u, (arr = []));
          arr.push({ to: v, tri: t });
        }
      }
    }
    const used = new Set<string>();
    for (const start of boundary) {
      if (used.has(`${start.u}>${start.v}`)) continue;
      const loop: { u: number; v: number; tri: number }[] = [];
      let cur = start;
      let closed = false;
      for (let guard = 0; guard < 200000; guard++) {
        const k = `${cur.u}>${cur.v}`;
        if (used.has(k)) break;
        used.add(k);
        loop.push(cur);
        if (cur.v === start.u) {
          closed = true;
          break;
        }
        const cand = (next.get(cur.v) ?? []).find((c) => !used.has(`${cur.v}>${c.to}`));
        if (!cand) break;
        cur = { u: cur.v, v: cand.to, tri: cand.tri };
      }
      if (!closed || loop.length < 3) continue;
      let cx = 0, cy = 0, cz = 0;
      for (const e of loop) {
        cx += verts[e.u * 3];
        cy += verts[e.u * 3 + 1];
        cz += verts[e.u * 3 + 2];
      }
      const center = verts.length / 3;
      verts.push(cx / loop.length, cy / loop.length, cz / loop.length);
      for (const e of loop) {
        tris.push([e.v, e.u, center]);
        if (triData) data.push(data[e.tri]);
      }
      cappedLoops++;
      cappedTriangles += loop.length;
    }
    if (cappedLoops > 0 && (opts.fixWinding ?? true)) orientConsistently(tris);
  }

  // Positive volume per closed component
  let flipped = 0;
  const comps = components(tris);
  if (opts.ensurePositiveVolume ?? true) {
    for (const comp of comps) {
      if (signedVolume(verts, tris, comp) < 0) {
        flipped++;
        for (const t of comp) {
          const tri = tris[t];
          tris[t] = [tri[0], tri[2], tri[1]];
        }
      }
    }
  }

  // Outward normal inflation
  const inflate = opts.inflateMm ?? 0;
  if (inflate > 0) {
    const vc = verts.length / 3;
    const n = new Float64Array(vc * 3);
    for (const [a, b, c] of tris) {
      const abx = verts[b * 3] - verts[a * 3], aby = verts[b * 3 + 1] - verts[a * 3 + 1], abz = verts[b * 3 + 2] - verts[a * 3 + 2];
      const acx = verts[c * 3] - verts[a * 3], acy = verts[c * 3 + 1] - verts[a * 3 + 1], acz = verts[c * 3 + 2] - verts[a * 3 + 2];
      const fx = aby * acz - abz * acy, fy = abz * acx - abx * acz, fz = abx * acy - aby * acx;
      for (const v of [a, b, c]) {
        n[v * 3] += fx;
        n[v * 3 + 1] += fy;
        n[v * 3 + 2] += fz;
      }
    }
    for (let i = 0; i < vc; i++) {
      const len = Math.hypot(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]);
      if (len > 1e-12) {
        verts[i * 3] += (n[i * 3] / len) * inflate;
        verts[i * 3 + 1] += (n[i * 3 + 1] / len) * inflate;
        verts[i * 3 + 2] += (n[i * 3 + 2] / len) * inflate;
      }
    }
  }

  const indices = new Uint32Array(tris.length * 3);
  tris.forEach((t, i) => indices.set(t, i * 3));
  const after = analyzeEdges(indices);
  const positions = new Float32Array(verts);
  return {
    positions,
    indices,
    triData: triData ? data : undefined,
    report: {
      verticesBefore: src.length / 3,
      verticesAfter: positions.length / 3,
      trianglesBefore: mesh.indices.length / 3,
      trianglesAfter: tris.length,
      degenerateRemoved: degenerate,
      openEdgesBefore: before.open,
      openEdgesAfter: after.open,
      nonManifoldEdgesAfter: after.nonManifold,
      reversedEdgesBefore: before.reversed,
      reversedEdgesAfter: after.reversed,
      cappedLoops,
      cappedTriangles,
      flippedComponents: flipped,
      components: comps.length,
      volumeMm3: signedVolume(verts, tris),
    },
  };
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export function computeBounds(meshes: IndexedMesh[]): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = m.positions[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  return { min, max };
}

/**
 * Scale meshes uniformly (in place) so the assembly is `targetHeightMm` tall,
 * centred on X/Y = 0 and resting on Z = 0. Returns the scale applied.
 */
export function fitToHeight(meshes: IndexedMesh[], targetHeightMm?: number): number {
  const b = computeBounds(meshes);
  const h = b.max[2] - b.min[2];
  const s = targetHeightMm && h > 0 ? targetHeightMm / h : 1;
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      m.positions[i] = (m.positions[i] - cx) * s;
      m.positions[i + 1] = (m.positions[i + 1] - cy) * s;
      m.positions[i + 2] = (m.positions[i + 2] - b.min[2]) * s;
    }
  }
  return s;
}

export function triangleArea(p: ArrayLike<number>, a: number, b: number, c: number): number {
  const abx = p[b * 3] - p[a * 3], aby = p[b * 3 + 1] - p[a * 3 + 1], abz = p[b * 3 + 2] - p[a * 3 + 2];
  const acx = p[c * 3] - p[a * 3], acy = p[c * 3 + 1] - p[a * 3 + 1], acz = p[c * 3 + 2] - p[a * 3 + 2];
  return 0.5 * Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx);
}

export interface PrintabilityOptions {
  /** Overhang angle from vertical, degrees (default 45). */
  overhangAngleDeg?: number;
  /** Smallest feature extent the nozzle can print, mm (default 0.8 = 2 × 0.4 mm lines). */
  minFeatureMm?: number;
  /** Height of the first layer, mm (default 0.2). */
  firstLayerMm?: number;
}

/** Quick printability telemetry for meshes already in millimetres. */
export function analyzePrintability(meshes: IndexedMesh[], opts: PrintabilityOptions = {}): PrintabilityReport {
  const b = computeBounds(meshes);
  const overhangCos = Math.cos(((90 - (opts.overhangAngleDeg ?? 45)) * Math.PI) / 180);
  const minFeature = opts.minFeatureMm ?? 0.8;
  const firstLayer = opts.firstLayerMm ?? 0.2;
  let total = 0;
  let over = 0;
  let triangles = 0;
  let floating = 0;
  let thin = 0;
  for (const m of meshes) {
    const p = m.positions;
    const tris: number[][] = [];
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = m.indices[t], bb = m.indices[t + 1], c = m.indices[t + 2];
      tris.push([a, bb, c]);
      const area = triangleArea(p, a, bb, c);
      const abx = p[bb * 3] - p[a * 3], aby = p[bb * 3 + 1] - p[a * 3 + 1];
      const acx = p[c * 3] - p[a * 3], acy = p[c * 3 + 1] - p[a * 3 + 1];
      const nz = abx * acy - aby * acx;
      const nzUnit = area > 0 ? nz / (2 * area) : 0;
      const minZ = Math.min(p[a * 3 + 2], p[bb * 3 + 2], p[c * 3 + 2]);
      total += area;
      if (nzUnit < -overhangCos && minZ > firstLayer) over += area;
    }
    triangles += tris.length;
    for (const comp of components(tris)) {
      const cmin = [Infinity, Infinity, Infinity];
      const cmax = [-Infinity, -Infinity, -Infinity];
      for (const t of comp) {
        for (const v of tris[t]) {
          for (let k = 0; k < 3; k++) {
            cmin[k] = Math.min(cmin[k], p[v * 3 + k]);
            cmax[k] = Math.max(cmax[k], p[v * 3 + k]);
          }
        }
      }
      if (cmin[2] > firstLayer + 1e-6) floating++;
      if (Math.min(cmax[0] - cmin[0], cmax[1] - cmin[1], cmax[2] - cmin[2]) < minFeature) thin++;
    }
  }
  const size: [number, number, number] = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const warnings: string[] = [];
  const overhangShare = total > 0 ? over / total : 0;
  if (overhangShare > 0.05) warnings.push(`${(overhangShare * 100).toFixed(0)}% of the surface overhangs; keep supports on.`);
  if (floating > 0) warnings.push(`${floating} component(s) start above the build plate; they need supports unless they rest on another part.`);
  if (thin > 0) warnings.push(`${thin} component(s) are thinner than ${minFeature} mm; consider inflating or scaling up.`);
  return { sizeMm: size, scale: 1, triangles, overhangShare, floatingComponents: floating, thinComponents: thin, warnings };
}
