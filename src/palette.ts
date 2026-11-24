import { buildCandidates, calibratedKit, deltaE2000, hexToLab, labToRgb, matchMixedRecipe, rgbToHex, rgbToLab, type MatchOptions } from "./color.js";
import { triangleArea } from "./mesh.js";
import type { ColoredPart, FilamentKit, Lab, Palette, PaletteSlot, SlottedPart } from "./types.js";

export interface PaletteOptions extends MatchOptions {
  /** Maximum number of virtual mixed slots (default 8, max 12). */
  maxMixedSlots?: number;
  /** Clusters within this ΔE00 of a base spool print with that spool directly (default 8). */
  snapToBaseDeltaE?: number;
  /** Clusters closer than this ΔE00 after matching are merged into one slot (default 3). */
  mergeDeltaE?: number;
  /** One pass of neighbour majority voting to remove isolated triangles (default true). */
  spatialDenoise?: boolean;
  /** Seed for deterministic K-Means++ initialisation (default 1). */
  seed?: number;
}

export interface PaletteSolution {
  palette: Palette;
  parts: SlottedPart[];
  /** Area-weighted mean ΔE00 between source colours and predicted print. */
  meanDeltaE00: number;
}

export const MAX_MIXED_SLOTS = 12;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Sample {
  lab: Lab;
  weight: number;
}

function dist2(a: Lab, b: Lab): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/** Area-weighted K-Means++ in CIELAB. Returns cluster centres and per-sample assignment. */
export function weightedKMeans(samples: Sample[], k: number, seed = 1, iterations = 30): { centers: Lab[]; assign: Int32Array; weights: number[] } {
  const rand = mulberry32(seed);
  const n = samples.length;
  const assign = new Int32Array(n);
  if (n === 0) return { centers: [], assign, weights: [] };
  const kk = Math.min(k, n);
  const centers: Lab[] = [];
  const totalW = samples.reduce((s, x) => s + x.weight, 0);
  // first centre: weighted random
  let r = rand() * totalW;
  let first = 0;
  for (; first < n - 1; first++) {
    r -= samples[first].weight;
    if (r <= 0) break;
  }
  centers.push(samples[first].lab);
  const d = new Float64Array(n).fill(Infinity);
  while (centers.length < kk) {
    let sum = 0;
    const last = centers[centers.length - 1];
    for (let i = 0; i < n; i++) {
      d[i] = Math.min(d[i], dist2(samples[i].lab, last));
      sum += d[i] * samples[i].weight;
    }
    if (sum === 0) break;
    let t = rand() * sum;
    let pick = 0;
    for (; pick < n - 1; pick++) {
      t -= d[pick] * samples[pick].weight;
      if (t <= 0) break;
    }
    centers.push(samples[pick].lab);
  }
  const weights = new Array(centers.length).fill(0);
  for (let it = 0; it < iterations; it++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const dd = dist2(samples[i].lab, centers[c]);
        if (dd < bd) {
          bd = dd;
          best = c;
        }
      }
      if (assign[i] !== best || it === 0) {
        changed = changed || assign[i] !== best;
        assign[i] = best;
      }
    }
    const acc = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const a = acc[assign[i]];
      const w = samples[i].weight;
      a[0] += samples[i].lab[0] * w;
      a[1] += samples[i].lab[1] * w;
      a[2] += samples[i].lab[2] * w;
      a[3] += w;
    }
    for (let c = 0; c < centers.length; c++) {
      weights[c] = acc[c][3];
      if (acc[c][3] > 0) centers[c] = [acc[c][0] / acc[c][3], acc[c][1] / acc[c][3], acc[c][2] / acc[c][3]];
    }
    if (!changed && it > 0) break;
  }
  return { centers, assign, weights };
}

/** Distinct colours by quantising sRGB to 5 bits/channel, with summed area. */
function collectSamples(parts: ColoredPart[]): { samples: Sample[]; keyOf: (r: number, g: number, b: number) => number; index: Map<number, number> } {
  const keyOf = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  const index = new Map<number, number>();
  const sums: { r: number; g: number; b: number; w: number }[] = [];
  for (const part of parts) {
    const triCount = part.indices.length / 3;
    for (let t = 0; t < triCount; t++) {
      const [r, g, b] = part.triColors ? [part.triColors[t * 3], part.triColors[t * 3 + 1], part.triColors[t * 3 + 2]] : (part.color ?? [200, 200, 200]);
      const area = triangleArea(part.positions, part.indices[t * 3], part.indices[t * 3 + 1], part.indices[t * 3 + 2]);
      const k = keyOf(r, g, b);
      let i = index.get(k);
      if (i === undefined) {
        i = sums.length;
        index.set(k, i);
        sums.push({ r: 0, g: 0, b: 0, w: 0 });
      }
      const w = Math.max(area, 1e-9);
      sums[i].r += r * w;
      sums[i].g += g * w;
      sums[i].b += b * w;
      sums[i].w += w;
    }
  }
  const samples = sums.map((s) => ({ lab: rgbToLab([s.r / s.w, s.g / s.w, s.b / s.w]), weight: s.w }));
  return { samples, keyOf, index };
}

/**
 * Solve a CMYKW palette for coloured parts: cluster surface colours, snap clusters to
 * base spools where close, map the rest to mixed recipes, and assign every triangle a slot.
 */
export function solvePalette(parts: ColoredPart[], kit: FilamentKit, opts: PaletteOptions = {}): PaletteSolution {
  const maxMixed = Math.min(MAX_MIXED_SLOTS, Math.max(0, opts.maxMixedSlots ?? 8));
  const snap = opts.snapToBaseDeltaE ?? 8;
  const mergeDE = opts.mergeDeltaE ?? 3;
  const k = calibratedKit(kit, opts.calibration);
  const baseLabs = k.bases.map((b) => hexToLab(b.hex));
  const candidates = opts.candidates ?? buildCandidates(kit, opts);

  const { samples, keyOf, index } = collectSamples(parts);
  const totalArea = samples.reduce((s, x) => s + x.weight, 0) || 1;
  const km = weightedKMeans(samples, maxMixed + k.bases.length, opts.seed ?? 1);

  // Map each cluster to a printable colour (base or mixed recipe).
  type Target = { key: string; hex: string; kind: "base" | "mixed"; base?: number; recipe?: PaletteSlot["recipe"]; deltaE: number };
  const clusterTargets: Target[] = km.centers.map((center) => {
    let bestBase = 0;
    let bestBaseDE = Infinity;
    baseLabs.forEach((bl, i) => {
      const d = deltaE2000(center, bl);
      if (d < bestBaseDE) {
        bestBaseDE = d;
        bestBase = i;
      }
    });
    const m = maxMixed > 0 ? matchMixedRecipe(rgbToHex(labToRgb(center)), k, { ...opts, candidates }) : undefined;
    if (!m || bestBaseDE <= snap || bestBaseDE <= m.deltaE00) {
      return { key: `b${bestBase}`, hex: k.bases[bestBase].hex.toUpperCase(), kind: "base", base: bestBase, deltaE: bestBaseDE };
    }
    return {
      key: `m${m.recipe.components.join(",")}:${m.recipe.ratios.join(",")}`,
      hex: m.recipe.hex,
      kind: "mixed",
      recipe: m.recipe,
      deltaE: m.deltaE00,
    };
  });

  // Group clusters by target, then enforce the mixed-slot budget and merge near-duplicates.
  const groups = new Map<string, { target: Target; weight: number; clusters: number[]; lab: [number, number, number] }>();
  clusterTargets.forEach((t, c) => {
    const w = km.weights[c];
    let g = groups.get(t.key);
    if (!g) groups.set(t.key, (g = { target: t, weight: 0, clusters: [], lab: [0, 0, 0] }));
    g.weight += w;
    g.clusters.push(c);
    g.lab[0] += km.centers[c][0] * w;
    g.lab[1] += km.centers[c][1] * w;
    g.lab[2] += km.centers[c][2] * w;
  });
  let mixed = [...groups.values()].filter((g) => g.target.kind === "mixed").sort((a, b) => b.weight - a.weight);
  // merge mixed groups whose predicted colours are nearly identical
  const kept: typeof mixed = [];
  for (const g of mixed) {
    const twin = kept.find((x) => deltaE2000(hexToLab(x.target.hex), hexToLab(g.target.hex)) < mergeDE);
    if (twin) {
      twin.weight += g.weight;
      twin.clusters.push(...g.clusters);
    } else kept.push(g);
  }
  // Over budget: repeatedly fold away the group that is cheapest to lose, where the cost is
  // its surface weight times the ΔE00 from its source colour to the nearest remaining slot.
  const dropped: typeof kept = [];
  const groupLab = (g: (typeof kept)[number]): Lab => [g.lab[0] / (g.weight || 1), g.lab[1] / (g.weight || 1), g.lab[2] / (g.weight || 1)];
  while (kept.length > maxMixed) {
    let worst = -1;
    let worstCost = Infinity;
    kept.forEach((g, i) => {
      const src = groupLab(g);
      let nearest = Math.min(...baseLabs.map((b) => deltaE2000(src, b)));
      kept.forEach((o, j) => {
        if (j !== i) nearest = Math.min(nearest, deltaE2000(src, hexToLab(o.target.hex)));
      });
      const cost = g.weight * nearest;
      if (cost < worstCost) {
        worstCost = cost;
        worst = i;
      }
    });
    dropped.push(...kept.splice(worst, 1));
  }
  mixed = kept;

  // Final slot list: bases 1..N always present, mixed after.
  const slots: PaletteSlot[] = k.bases.map((b, i) => ({ slot: i + 1, kind: "base", hex: b.hex.toUpperCase(), areaShare: 0 }));
  const slotOfCluster = new Int32Array(km.centers.length);
  for (const g of groups.values()) {
    if (g.target.kind === "base") for (const c of g.clusters) slotOfCluster[c] = g.target.base! + 1;
  }
  mixed.forEach((g, i) => {
    const slot = k.bases.length + 1 + i;
    const lab: Lab = [g.lab[0] / (g.weight || 1), g.lab[1] / (g.weight || 1), g.lab[2] / (g.weight || 1)];
    slots.push({ slot, kind: "mixed", hex: g.target.hex, targetHex: rgbToHex(labToRgb(lab)), recipe: g.target.recipe, areaShare: 0 });
    for (const c of g.clusters) slotOfCluster[c] = slot;
  });
  const slotLabs = slots.map((s) => hexToLab(s.hex));
  for (const g of dropped) {
    for (const c of g.clusters) {
      let best = 0;
      let bd = Infinity;
      slotLabs.forEach((l, i) => {
        const d = deltaE2000(km.centers[c], l);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      slotOfCluster[c] = best + 1;
    }
  }

  // Assign triangles.
  let weightedDE = 0;
  const slotArea = new Array(slots.length + 1).fill(0);
  const slotTarget = slots.map(() => [0, 0, 0, 0]);
  const out: SlottedPart[] = parts.map((part) => {
    const triCount = part.indices.length / 3;
    const triSlots = new Uint8Array(triCount);
    for (let t = 0; t < triCount; t++) {
      const [r, g, b] = part.triColors ? [part.triColors[t * 3], part.triColors[t * 3 + 1], part.triColors[t * 3 + 2]] : (part.color ?? [200, 200, 200]);
      const sampleIdx = index.get(keyOf(r, g, b))!;
      triSlots[t] = slotOfCluster[km.assign[sampleIdx]];
    }
    if (opts.spatialDenoise ?? true) denoise(part.indices, triSlots);
    for (let t = 0; t < triCount; t++) {
      const [r, g, b] = part.triColors ? [part.triColors[t * 3], part.triColors[t * 3 + 1], part.triColors[t * 3 + 2]] : (part.color ?? [200, 200, 200]);
      const area = triangleArea(part.positions, part.indices[t * 3], part.indices[t * 3 + 1], part.indices[t * 3 + 2]);
      const s = triSlots[t];
      const lab = rgbToLab([r, g, b]);
      weightedDE += deltaE2000(lab, slotLabs[s - 1]) * area;
      slotArea[s] += area;
      const acc = slotTarget[s - 1];
      acc[0] += lab[0] * area;
      acc[1] += lab[1] * area;
      acc[2] += lab[2] * area;
      acc[3] += area;
    }
    const counts = new Map<number, number>();
    triSlots.forEach((s) => counts.set(s, (counts.get(s) ?? 0) + 1));
    const extruder = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1;
    return { name: part.name, positions: part.positions, indices: part.indices, extruder, triSlots };
  });
  slots.forEach((s, i) => {
    s.areaShare = slotArea[s.slot] / totalArea;
    const acc = slotTarget[i];
    if (acc[3] > 0) {
      const lab: Lab = [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]];
      s.targetHex = rgbToHex(labToRgb(lab));
      s.deltaE00 = deltaE2000(lab, slotLabs[i]);
    }
  });
  return { palette: { kit: k, slots }, parts: out, meanDeltaE00: weightedDE / totalArea };
}

/** One pass of majority voting over edge-adjacent triangles. */
export function denoise(indices: Uint32Array, slots: Uint8Array): number {
  const edgeTris = new Map<string, number[]>();
  const triCount = indices.length / 3;
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e];
      const b = indices[t * 3 + ((e + 1) % 3)];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      let l = edgeTris.get(k);
      if (!l) edgeTris.set(k, (l = []));
      l.push(t);
    }
  }
  const next = slots.slice();
  let changed = 0;
  for (let t = 0; t < triCount; t++) {
    const votes = new Map<number, number>();
    let neighbours = 0;
    for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e];
      const b = indices[t * 3 + ((e + 1) % 3)];
      for (const nb of edgeTris.get(a < b ? `${a}_${b}` : `${b}_${a}`)!) {
        if (nb === t) continue;
        neighbours++;
        votes.set(slots[nb], (votes.get(slots[nb]) ?? 0) + 1);
      }
    }
    if (neighbours < 2 || votes.has(slots[t])) continue;
    const [best, n] = [...votes.entries()].sort((x, y) => y[1] - x[1])[0];
    if (n >= 2) {
      next[t] = best;
      changed++;
    }
  }
  slots.set(next);
  return changed;
}
