import type { BaseFilament, FilamentKit, Lab, MixedRecipe, Rgb } from "./types.js";

// ---------------------------------------------------------------------------
// sRGB <-> linear <-> XYZ (D65) <-> CIELAB
// ---------------------------------------------------------------------------

export function srgbToLinear(c255: number): number {
  const c = c255 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(lin: number): number {
  const x = Math.min(1, Math.max(0, lin));
  const c = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(c * 255);
}

const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

export function linearRgbToLab(r: number, g: number, b: number): Lab {
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / XN;
  const y = (r * 0.2126729 + g * 0.7151522 + b * 0.072175) / YN;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / ZN;
  const e = 216 / 24389;
  const k = 24389 / 27;
  const f = (t: number) => (t > e ? Math.cbrt(t) : (k * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function rgbToLab(rgb: Rgb): Lab {
  return linearRgbToLab(srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2]));
}

export function labToRgb(lab: Lab): Rgb {
  const [L, a, b] = lab;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const e = 216 / 24389;
  const k = 24389 / 27;
  const inv = (f: number) => (f * f * f > e ? f * f * f : (116 * f - 16) / k);
  const x = inv(fx) * XN;
  const y = (L > k * e ? Math.pow(fy, 3) : L / k) * YN;
  const z = inv(fz) * ZN;
  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(bl)];
}

export function hexToRgb(hex: string): Rgb {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`Invalid hex colour: ${hex}`);
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

export function rgbToHex(rgb: Rgb): string {
  return "#" + rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function hexToLab(hex: string): Lab {
  return rgbToLab(hexToRgb(hex));
}

/** Relative luminance (0..1) of an sRGB hex colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

// ---------------------------------------------------------------------------
// CIEDE2000 (Sharma, Wu & Dalal 2005)
// ---------------------------------------------------------------------------

export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const Cm7 = Math.pow(Cm, 7);
  const G = 0.5 * (1 - Math.sqrt(Cm7 / (Cm7 + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hp = (a: number, b: number) => {
    if (a === 0 && b === 0) return 0;
    const h = Math.atan2(b, a) / rad;
    return h >= 0 ? h : h + 360;
  };
  const h1p = hp(a1p, b1);
  const h2p = hp(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lmp = (L1 + L2) / 2;
  const Cmp = (C1p + C2p) / 2;
  let hmp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hmp = (h1p + h2p) / 2;
    else hmp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hmp - 30) * rad) +
    0.24 * Math.cos(2 * hmp * rad) +
    0.32 * Math.cos((3 * hmp + 6) * rad) -
    0.2 * Math.cos((4 * hmp - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hmp - 275) / 25, 2));
  const Cmp7 = Math.pow(Cmp, 7);
  const Rc = 2 * Math.sqrt(Cmp7 / (Cmp7 + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lmp - 50, 2)) / Math.sqrt(20 + Math.pow(Lmp - 50, 2));
  const Sc = 1 + 0.045 * Cmp;
  const Sh = 1 + 0.015 * Cmp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(
    Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

export function deltaE2000Hex(a: string, b: string): number {
  return deltaE2000(hexToLab(a), hexToLab(b));
}

// ---------------------------------------------------------------------------
// Filament kits
// ---------------------------------------------------------------------------

/**
 * Nominal CMYKW primaries. These are generic process-colour approximations,
 * not measured values for any vendor's spools; calibrate with a printed swatch card.
 */
export const KIT_PLA_PALETTE_CMYKW: FilamentKit = {
  id: "pla-palette-cmykw",
  label: "PLA CMYKW (Bambu PLA Palette preset)",
  filamentPreset: "Bambu PLA Palette @BBL H3C",
  bases: [
    { name: "Cyan", hex: "#0090DA" },
    { name: "Magenta", hex: "#E24585" },
    { name: "Yellow", hex: "#FCE300" },
    { name: "Black", hex: "#000000" },
    { name: "White", hex: "#FFFFFF" },
  ],
};

export const KITS: Record<string, FilamentKit> = {
  [KIT_PLA_PALETTE_CMYKW.id]: KIT_PLA_PALETTE_CMYKW,
};

// ---------------------------------------------------------------------------
// Clean-room optical sublayer model
// ---------------------------------------------------------------------------

export interface OpticalModelOptions {
  /**
   * 0 = purely additive (viewer resolves thin stripes, e.g. on vertical walls),
   * 1 = purely subtractive (stacked translucent sublayers, e.g. top surfaces).
   * Default 0.55, an uncalibrated middle ground. Calibrate with a printed card.
   */
  subtractiveWeight?: number;
}

/** Single-constant Kubelka-Munk absorption/scattering ratio for a reflectance. */
function ksFromReflectance(r: number): number {
  const R = Math.min(0.999, Math.max(0.002, r));
  return ((1 - R) * (1 - R)) / (2 * R);
}

function reflectanceFromKs(ks: number): number {
  return 1 + ks - Math.sqrt(ks * ks + 2 * ks);
}

/**
 * Predict the printed colour of a sublayer mix. Each linear-RGB channel is treated
 * as a broad reflectance band: the subtractive term mixes Kubelka-Munk K/S ratios,
 * the additive term averages reflectance, and the result blends both.
 */
export function predictMixHex(bases: readonly BaseFilament[], components: number[], ratios: number[], opts: OpticalModelOptions = {}): string {
  const w = opts.subtractiveWeight ?? 0.55;
  const lin = components.map((c) => {
    const base = bases[c - 1];
    if (!base) throw new Error(`Unknown base component ${c}`);
    return hexToRgb(base.hex).map(srgbToLinear);
  });
  const total = ratios.reduce((s, r) => s + r, 0);
  const out: number[] = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    let ks = 0;
    let add = 0;
    for (let i = 0; i < lin.length; i++) {
      const f = ratios[i] / total;
      ks += f * ksFromReflectance(lin[i][ch]);
      add += f * lin[i][ch];
    }
    const sub = reflectanceFromKs(ks);
    out[ch] = w * sub + (1 - w) * add;
  }
  return rgbToHex([linearToSrgb(out[0]), linearToSrgb(out[1]), linearToSrgb(out[2])]);
}

export interface RecipeGridOptions extends OpticalModelOptions {
  /** Ratio step (default 0.05). */
  step?: number;
  /** Minimum share of any component (default 0.15). */
  minShare?: number;
  /** Largest number of components (2 or 3; default 3). */
  maxComponents?: 2 | 3;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Enumerate candidate 2- and 3-component recipes over the kit's bases. */
export function enumerateRecipes(kit: FilamentKit, opts: RecipeGridOptions = {}): MixedRecipe[] {
  const step = opts.step ?? 0.05;
  const minShare = opts.minShare ?? 0.15;
  const maxC = opts.maxComponents ?? 3;
  const n = kit.bases.length;
  const steps = Math.round(1 / step);
  const minSteps = Math.ceil(minShare / step - 1e-9);
  const out: MixedRecipe[] = [];
  for (let i = 1; i <= n; i++) {
    for (let j = i + 1; j <= n; j++) {
      for (let a = minSteps; a <= steps - minSteps; a++) {
        const ratios = [round2(a * step), round2((steps - a) * step)];
        out.push({ components: [i, j], ratios, hex: predictMixHex(kit.bases, [i, j], ratios, opts), source: "optical-model" });
      }
      if (maxC < 3) continue;
      for (let k = j + 1; k <= n; k++) {
        for (let a = minSteps; a <= steps - 2 * minSteps; a++) {
          for (let b = minSteps; b <= steps - a - minSteps; b++) {
            const c = steps - a - b;
            if (c < minSteps) continue;
            const ratios = [round2(a * step), round2(b * step), round2(c * step)];
            out.push({ components: [i, j, k], ratios, hex: predictMixHex(kit.bases, [i, j, k], ratios, opts), source: "optical-model" });
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Calibration tables
// ---------------------------------------------------------------------------

export interface CalibrationEntry {
  components: number[];
  ratios: number[];
  /** Measured printed colour. */
  hex: string;
}

export interface CalibrationTable {
  format: "cmyk-3mf-calibration";
  version: 1;
  kitId: string;
  /** Optional measured base spool colours, same order as the kit. */
  bases?: string[];
  entries: CalibrationEntry[];
  notes?: string;
}

export function parseCalibrationTable(json: string | unknown): CalibrationTable {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  if (!data || typeof data !== "object") throw new Error("Calibration table must be an object");
  const t = data as Partial<CalibrationTable>;
  if (t.format !== "cmyk-3mf-calibration" || t.version !== 1) throw new Error("Unsupported calibration format");
  if (typeof t.kitId !== "string" || !Array.isArray(t.entries)) throw new Error("Calibration table needs kitId and entries");
  for (const e of t.entries) {
    if (!Array.isArray(e.components) || !Array.isArray(e.ratios) || e.components.length !== e.ratios.length) {
      throw new Error("Each calibration entry needs matching components and ratios");
    }
    hexToRgb(e.hex);
  }
  if (t.bases) t.bases.forEach(hexToRgb);
  return t as CalibrationTable;
}

export function serializeCalibrationTable(table: CalibrationTable): string {
  return JSON.stringify(table, null, 2) + "\n";
}

/** Apply measured base colours from a calibration table to a kit. */
export function calibratedKit(kit: FilamentKit, table?: CalibrationTable): FilamentKit {
  if (!table?.bases) return kit;
  if (table.bases.length !== kit.bases.length) throw new Error("Calibration base count does not match kit");
  return { ...kit, bases: kit.bases.map((b, i) => ({ ...b, hex: table.bases![i].toUpperCase() })) };
}

function recipeKey(components: number[], ratios: number[]): string {
  return components.map((c, i) => `${c}:${ratios[i].toFixed(2)}`).join("|");
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface MatchOptions extends RecipeGridOptions {
  /** Prefer a 2-component recipe when it is within this many ΔE00 of the best 3-component one (default 2.5). */
  preferTwoComponentDeltaE?: number;
  calibration?: CalibrationTable;
  /** Pre-computed candidates (pass the same list when matching many colours). */
  candidates?: MixedRecipe[];
}

export interface RecipeMatch {
  recipe: MixedRecipe;
  deltaE00: number;
}

/** Build the candidate list once, applying calibration overrides. */
export function buildCandidates(kit: FilamentKit, opts: MatchOptions = {}): MixedRecipe[] {
  const k = calibratedKit(kit, opts.calibration);
  const list = enumerateRecipes(k, opts);
  if (!opts.calibration) return list;
  const measured = new Map(opts.calibration.entries.map((e) => [recipeKey(e.components, e.ratios), e.hex.toUpperCase()]));
  const seen = new Set<string>();
  const out = list.map((r) => {
    const key = recipeKey(r.components, r.ratios);
    seen.add(key);
    const hex = measured.get(key);
    return hex ? { ...r, hex, source: "calibrated" as const } : r;
  });
  for (const e of opts.calibration.entries) {
    const key = recipeKey(e.components, e.ratios);
    if (!seen.has(key) && e.components.length > 1) {
      out.push({ components: e.components, ratios: e.ratios, hex: e.hex.toUpperCase(), source: "calibrated" });
    }
  }
  return out;
}

/** Find the mixed recipe whose predicted print is closest to the target colour. */
export function matchMixedRecipe(target: Rgb | string, kit: FilamentKit, opts: MatchOptions = {}): RecipeMatch {
  const lab = typeof target === "string" ? hexToLab(target) : rgbToLab(target);
  const candidates = opts.candidates ?? buildCandidates(kit, opts);
  let best2: RecipeMatch | undefined;
  let best3: RecipeMatch | undefined;
  for (const r of candidates) {
    const d = deltaE2000(lab, hexToLab(r.hex));
    if (r.components.length === 2) {
      if (!best2 || d < best2.deltaE00) best2 = { recipe: r, deltaE00: d };
    } else if (!best3 || d < best3.deltaE00) best3 = { recipe: r, deltaE00: d };
  }
  const bias = opts.preferTwoComponentDeltaE ?? 2.5;
  if (best2 && (!best3 || best2.deltaE00 <= best3.deltaE00 + bias)) return best2;
  if (best3) return best3;
  throw new Error("No candidate recipes");
}
