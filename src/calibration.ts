import { deltaE2000, enumerateRecipes, hexToLab, KIT_PLA_PALETTE_CMYKW, type CalibrationTable, type OpticalModelOptions } from "./color.js";
import { defaultPresetSource, loadPrinterPresets } from "./convert.js";
import type { PresetBundle, PresetSource } from "./presets.js";
import { getPrinter } from "./printers.js";
import type { ProcessOptions } from "./settings.js";
import type { FilamentKit, MixedRecipe, Palette, PaletteSlot, PrinterProfile, SlottedPart } from "./types.js";
import { exportBambu3mf, type ExportResult } from "./writer.js";

/** Closed, outward-facing axis-aligned box. */
export function boxMesh(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom (-Z)
    4, 5, 6, 4, 6, 7, // top (+Z)
    0, 1, 5, 0, 5, 4, // front (-Y)
    1, 2, 6, 1, 6, 5, // right (+X)
    2, 3, 7, 2, 7, 6, // back (+Y)
    3, 0, 4, 3, 4, 7, // left (-X)
  ]);
  return { positions, indices };
}

export const CALIBRATION_TILES_PER_CARD = 12;

/**
 * Calibration recipes in a deterministic, maximally spread order (farthest-point sampling
 * in CIELAB over 25 % steps). Page 0 is the most informative set of 12.
 */
export function calibrationRecipes(kit: FilamentKit = KIT_PLA_PALETTE_CMYKW, opts: OpticalModelOptions = {}): MixedRecipe[] {
  const all = enumerateRecipes(kit, { ...opts, step: 0.25, minShare: 0.25 });
  if (all.length === 0) return [];
  const labs = all.map((r) => hexToLab(r.hex));
  const baseLabs = kit.bases.map((b) => hexToLab(b.hex));
  const minD = labs.map((l) => Math.min(...baseLabs.map((b) => deltaE2000(l, b))));
  const order: number[] = [];
  const used = new Uint8Array(all.length);
  for (let n = 0; n < all.length; n++) {
    let best = -1;
    for (let i = 0; i < all.length; i++) if (!used[i] && (best < 0 || minD[i] > minD[best])) best = i;
    used[best] = 1;
    order.push(best);
    for (let i = 0; i < all.length; i++) if (!used[i]) minD[i] = Math.min(minD[i], deltaE2000(labs[i], labs[best]));
  }
  return order.map((i) => all[i]);
}

export interface CalibrationCardOptions {
  printer?: string | PrinterProfile;
  kit?: FilamentKit;
  /** Which page of {@link calibrationRecipes} to print (default 0). */
  page?: number;
  /** Explicit recipes instead of a page (max 12). */
  recipes?: MixedRecipe[];
  /** Tile edge length, mm (default 14). */
  tileMm?: number;
  /** Tile height, mm (default 4: tall enough to judge walls and tops). */
  tileHeightMm?: number;
  presets?: PresetSource;
  bundle?: PresetBundle;
  process?: ProcessOptions;
}

export interface CalibrationCard extends ExportResult {
  palette: Palette;
  /** Fill in measured `hex` values and load with `parseCalibrationTable`. */
  template: CalibrationTable;
  /** Row-major legend: tile position -> slot and recipe. */
  legend: { row: number; col: number; slot: number; label: string }[];
}

/** A printable card of base and mixed swatch tiles on a thin backing plate. */
export async function generateCalibrationCard(opts: CalibrationCardOptions = {}): Promise<CalibrationCard> {
  const printer = typeof opts.printer === "object" ? opts.printer : getPrinter(opts.printer ?? "bbl-h3c-0.4");
  const kit = opts.kit ?? KIT_PLA_PALETTE_CMYKW;
  const page = opts.page ?? 0;
  const recipes = (opts.recipes ?? calibrationRecipes(kit).slice(page * CALIBRATION_TILES_PER_CARD, (page + 1) * CALIBRATION_TILES_PER_CARD)).slice(0, CALIBRATION_TILES_PER_CARD);
  if (recipes.length === 0) throw new Error(`Calibration page ${page} is empty`);

  const slots: PaletteSlot[] = kit.bases.map((b, i) => ({ slot: i + 1, kind: "base", hex: b.hex.toUpperCase() }));
  recipes.forEach((r, i) => slots.push({ slot: kit.bases.length + 1 + i, kind: "mixed", hex: r.hex, recipe: r }));
  const palette: Palette = { kit, slots };

  const tile = opts.tileMm ?? 14;
  const height = opts.tileHeightMm ?? 4;
  const gap = 3;
  const cols = 6;
  const rows = Math.ceil(slots.length / cols);
  const plateT = 1.2;
  const w = cols * tile + (cols + 1) * gap;
  const d = rows * tile + (rows + 1) * gap;
  const ox = -w / 2;
  const oy = -d / 2;
  const darkest = kit.bases.findIndex((b) => b.hex.toUpperCase() === "#000000");
  const plateSlot = darkest >= 0 ? darkest + 1 : 1;

  const parts: SlottedPart[] = [{ name: "00_Backing_Plate", ...boxMesh(ox, oy, 0, ox + w, oy + d, plateT), extruder: plateSlot }];
  const legend: CalibrationCard["legend"] = [];
  slots.forEach((s, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x = ox + gap + col * (tile + gap);
    // row 0 at the back (+Y) so the card reads like a page
    const y = oy + d - gap - (row + 1) * tile - row * gap;
    const label = s.recipe ? s.recipe.components.map((c, k) => `${kit.bases[c - 1].name} ${Math.round(s.recipe!.ratios[k] * 100)}%`).join(" + ") : kit.bases[s.slot - 1].name;
    parts.push({ name: `${String(i + 1).padStart(2, "0")}_${label.replace(/[^A-Za-z0-9%]+/g, "_")}`, ...boxMesh(x, y, plateT, x + tile, y + tile, plateT + height), extruder: s.slot });
    legend.push({ row, col, slot: s.slot, label });
  });
  // Shift so Z starts at 0 and XY is centred (already centred).
  const bundle = opts.bundle ?? (await loadPrinterPresets(printer, kit, opts.presets ?? defaultPresetSource()));
  const result = await exportBambu3mf(parts, palette, {
    printer,
    bundle,
    title: `cmyk-3mf calibration card ${page + 1}`,
    description: `Swatch tiles for ${kit.label}: ${legend.map((l) => `${l.slot}=${l.label}`).join("; ")}`,
    process: { supports: "none", layerHeightMm: 0.16, ...opts.process },
  });
  const template: CalibrationTable = {
    format: "cmyk-3mf-calibration",
    version: 1,
    kitId: kit.id,
    bases: kit.bases.map((b) => b.hex.toUpperCase()),
    entries: recipes.map((r) => ({ components: r.components, ratios: r.ratios, hex: r.hex })),
    notes: "Replace each hex with the measured colour of the printed tile (top surface), then pass this file to --calibration.",
  };
  return { ...result, palette, template, legend };
}
