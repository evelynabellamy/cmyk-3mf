import { hexToRgb } from "./color.js";
import type { ColoredPart, Rgb } from "./types.js";

export interface FlutedVaseOptions {
  heightMm?: number;
  /** Mean outer radius, mm. */
  radiusMm?: number;
  /** Number of flutes around the body. */
  flutes?: number;
  /** Flute depth, mm. */
  fluteMm?: number;
  wallMm?: number;
  baseMm?: number;
  segments?: number;
  rings?: number;
  /** Gradient stops from foot to rim. */
  gradient?: string[];
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round) as unknown as Rgb;
}

function sampleGradient(stops: Rgb[], t: number): Rgb {
  const x = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(x);
  return mix(stops[i], stops[i + 1], x - i);
}

/**
 * A closed, watertight fluted vase: r(z, θ) = profile(z) + flute · sin(kθ), with a solid
 * foot, an inner wall and a rounded lip. Colours run through a gradient by height, with
 * flute ridges slightly lighter, so it exercises both base and mixed slots.
 */
export function flutedVase(opts: FlutedVaseOptions = {}): ColoredPart {
  const H = opts.heightMm ?? 120;
  const R = opts.radiusMm ?? 34;
  const k = opts.flutes ?? 12;
  const flute = opts.fluteMm ?? 2.2;
  const wall = opts.wallMm ?? 2.4;
  const base = opts.baseMm ?? 3;
  const seg = opts.segments ?? 144;
  const rings = opts.rings ?? 96;
  const stops = (opts.gradient ?? ["#1D2B53", "#2E6F95", "#E24585", "#F2A541", "#FCE300"]).map(hexToRgb);

  const profile = (t: number) => R * (0.62 + 0.5 * Math.sin(Math.PI * (0.15 + 0.85 * t)) - 0.22 * t * t);
  const pos: number[] = [];
  const rowStart: number[] = [];
  // Outer surface rings (z from 0 to H), then inner rings (z from H back down to base).
  const addRing = (z: number, r: (th: number) => number) => {
    rowStart.push(pos.length / 3);
    for (let s = 0; s < seg; s++) {
      const th = (s / seg) * Math.PI * 2;
      const rr = r(th);
      pos.push(rr * Math.cos(th), rr * Math.sin(th), z);
    }
  };
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    addRing(t * H, (th) => profile(t) + flute * Math.sin(k * th) * Math.sin(Math.PI * Math.min(1, t * 1.3)));
  }
  for (let i = rings; i >= 0; i--) {
    const t = i / rings;
    const z = base + t * (H - base);
    const tt = z / H;
    addRing(z, (th) => Math.max(1, profile(tt) + flute * Math.sin(k * th) * Math.sin(Math.PI * Math.min(1, tt * 1.3)) - wall));
  }
  const bottomCenter = pos.length / 3;
  pos.push(0, 0, 0);
  const floorCenter = pos.length / 3;
  pos.push(0, 0, base);

  const idx: number[] = [];
  const cols: number[] = [];
  const colorAt = (z: number, s: number, inner: boolean): Rgb => {
    const c = sampleGradient(stops, z / H);
    const ridge = Math.sin((k * (s + 0.5) * Math.PI * 2) / seg) > 0.6 && !inner;
    return ridge ? mix(c, [255, 255, 255], 0.18) : inner ? mix(c, [0, 0, 0], 0.15) : c;
  };
  const rowsTotal = rowStart.length;
  for (let r = 0; r + 1 < rowsTotal; r++) {
    const a0 = rowStart[r];
    const b0 = rowStart[r + 1];
    const inner = r >= rings + 1;
    const z = (pos[a0 * 3 + 2] + pos[b0 * 3 + 2]) / 2;
    for (let s = 0; s < seg; s++) {
      const s1 = (s + 1) % seg;
      const c = colorAt(z, s, inner);
      // Outer rows go up and inner rows come down, so this winding faces outward on the outer wall
      // and inward (toward the cavity) on the inner wall: both away from the solid.
      idx.push(a0 + s, a0 + s1, b0 + s1, a0 + s, b0 + s1, b0 + s);
      cols.push(...c, ...c);
    }
  }
  const bottom = rowStart[0];
  const floor = rowStart[rowsTotal - 1];
  const footColor = stops[0];
  for (let s = 0; s < seg; s++) {
    const s1 = (s + 1) % seg;
    idx.push(bottomCenter, bottom + s1, bottom + s);
    idx.push(floorCenter, floor + s, floor + s1);
    cols.push(...footColor, ...mix(footColor, [0, 0, 0], 0.2));
  }
  return { name: "Fluted_Vase", positions: new Float32Array(pos), indices: new Uint32Array(idx), triColors: new Uint8Array(cols) };
}
