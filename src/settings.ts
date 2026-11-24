import { relativeLuminance } from "./color.js";
import type { PresetBundle, PresetJson } from "./presets.js";
import type { Palette, SupportMode } from "./types.js";

/** Bambu Studio version the project format was verified against. */
export const BAMBU_APP_VERSION = "02.09.01.70";

export interface ProcessOptions {
  /** Layer height, mm (default 0.16; thinner layers give mixed sublayers more room). */
  layerHeightMm?: number;
  /** First layer height, mm (default 0.2). */
  firstLayerHeightMm?: number;
  supports?: SupportMode;
  /** 1-based slot used for support material (default: the darkest base spool). */
  supportSlot?: number;
  /** Sparse infill density in percent (default 15). */
  infillPercent?: number;
  /** Wall loops (default 2). */
  wallLoops?: number;
  /** Bed plate type (default "Textured PEI Plate"). */
  bedType?: string;
}

export interface PrimeTower {
  x: number;
  y: number;
  width: number;
}

const SKIP = new Set([
  "name",
  "from",
  "type",
  "setting_id",
  "filament_id",
  "instantiation",
  "description",
  "compatible_printers",
  "compatible_printers_condition",
  "compatible_prints",
  "compatible_prints_condition",
  "is_custom_defined",
  "version",
]);

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}

/** Luminance-aware purge volumes (mm³): dark-to-light changes purge more. Diagonal is 0. */
export function computeFlushMatrix(hexColors: string[]): string[] {
  const lum = hexColors.map(relativeLuminance);
  const out: string[] = [];
  for (let i = 0; i < hexColors.length; i++) {
    for (let j = 0; j < hexColors.length; j++) {
      if (i === j) out.push("0");
      else out.push(String(Math.round(200 + Math.max(0, lum[j] - lum[i]) * 420 + Math.abs(lum[j] - lum[i]) * 100)));
    }
  }
  return out;
}

/**
 * Place the prime tower in a bed corner at least `clearanceMm` away from the model's XY box.
 * `modelBox` is [minX, minY, maxX, maxY] in bed coordinates.
 */
export function computePrimeTower(bed: readonly [number, number], modelBox: [number, number, number, number], opts: { width?: number; depthEstimate?: number; clearanceMm?: number; marginMm?: number } = {}): PrimeTower {
  const clearance = opts.clearanceMm ?? 25;
  const margin = opts.marginMm ?? 15;
  for (const width of [opts.width ?? 45, 35, 25]) {
    const depth = opts.depthEstimate ?? Math.max(width, 60);
    const candidates: [number, number][] = [
      [margin, bed[1] - margin - depth],
      [bed[0] - margin - width, bed[1] - margin - depth],
      [margin, margin],
      [bed[0] - margin - width, margin],
    ];
    for (const [x, y] of candidates) {
      const gapX = Math.max(modelBox[0] - (x + width), x - modelBox[2], 0);
      const gapY = Math.max(modelBox[1] - (y + depth), y - modelBox[3], 0);
      if (Math.hypot(gapX, gapY) >= clearance || gapX >= clearance || gapY >= clearance) return { x, y, width };
    }
  }
  throw new Error("Model is too large to leave room for a prime tower with the requested clearance");
}

export interface BuildSettingsInput {
  bundle: PresetBundle;
  palette: Palette;
  primeTower: PrimeTower;
  process?: ProcessOptions;
}

/** Process keys we override; Bambu Studio keeps them only when listed in different_settings_to_system. */
const PROCESS_OVERRIDES = [
  "layer_height",
  "initial_layer_print_height",
  "wall_loops",
  "wall_generator",
  "detect_thin_wall",
  "sparse_infill_density",
  "sparse_infill_pattern",
  "enable_support",
  "support_type",
  "support_style",
  "support_on_build_plate_only",
  "support_threshold_angle",
  "support_filament",
  "support_interface_filament",
  "support_top_z_distance",
  "support_object_xy_distance",
  "tree_support_branch_angle",
  "enable_prime_tower",
  "prime_tower_width",
  "wipe_tower_x",
  "wipe_tower_y",
  "enable_mixed_color_sublayer",
];

/**
 * Build Metadata/project_settings.config from resolved presets plus the palette.
 * Every filament slot uses the kit's filament preset; mixed slots add the sublayer recipe keys.
 */
export function buildProjectSettings(input: BuildSettingsInput): PresetJson {
  const { bundle, palette, primeTower } = input;
  const p = input.process ?? {};
  const n = palette.slots.length;
  const ps: PresetJson = {};
  for (const src of [bundle.machine, bundle.process]) {
    for (const [k, v] of Object.entries(src)) if (!SKIP.has(k)) ps[k] = v;
  }
  for (const [k, v] of Object.entries(bundle.filament)) {
    if (SKIP.has(k)) continue;
    const first = Array.isArray(v) ? (v.length ? v[0] : "") : v;
    ps[k] = new Array(n).fill(str(first));
  }

  const colours = palette.slots.map((s) => s.hex.toUpperCase());
  const filamentId = str(bundle.filament.filament_id ?? "");
  const mixed = palette.slots.map((s) => s.kind === "mixed");
  const darkest = palette.kit.bases.reduce((best, b, i) => (relativeLuminance(b.hex) < relativeLuminance(palette.kit.bases[best].hex) ? i : best), 0) + 1;
  const supports = p.supports ?? "tree";
  const supportSlot = String(p.supportSlot ?? darkest);

  Object.assign(ps, {
    from: "project",
    version: BAMBU_APP_VERSION,
    printer_settings_id: bundle.names.machine,
    print_settings_id: bundle.names.process,
    filament_settings_id: new Array(n).fill(bundle.names.filament),
    filament_ids: new Array(n).fill(filamentId),
    filament_colour: colours,
    filament_multi_colors: colours,
    filament_color_types: new Array(n).fill("2"),
    filament_self_index: colours.map((_, i) => String(i + 1)),
    filament_is_mixed: mixed.map((m) => (m ? "1" : "0")),
    filament_mixed_components: palette.slots.map((s) => (s.recipe ? s.recipe.components.join(",") : "")),
    filament_mixed_sublayer_ratios: palette.slots.map((s) => (s.recipe ? s.recipe.ratios.map((r) => r.toFixed(2)).join(",") : "")),
    filament_mixed_gradient: new Array(n).fill("0"),
    filament_mixed_gradient_curve: new Array(n).fill(""),
    filament_mixed_gradient_per_part: new Array(n).fill("0"),
    filament_mixed_gradient_range: new Array(n).fill(""),
    flush_volumes_matrix: computeFlushMatrix(colours),
    flush_volumes_vector: new Array(n * 2).fill("140"),
    enable_mixed_color_sublayer: "1",
    enable_prime_tower: "1",
    prime_tower_width: String(primeTower.width),
    wipe_tower_x: [String(primeTower.x)],
    wipe_tower_y: [String(primeTower.y)],
    curr_bed_type: p.bedType ?? "Textured PEI Plate",
    layer_height: String(p.layerHeightMm ?? 0.16),
    initial_layer_print_height: String(p.firstLayerHeightMm ?? 0.2),
    wall_loops: String(p.wallLoops ?? 2),
    wall_generator: "arachne",
    detect_thin_wall: "1",
    sparse_infill_density: `${p.infillPercent ?? 15}%`,
    sparse_infill_pattern: "gyroid",
    enable_support: supports === "none" ? "0" : "1",
    support_type: supports === "normal" ? "normal(auto)" : "tree(auto)",
    support_style: supports === "normal" ? "default" : "tree_organic",
    support_on_build_plate_only: "0",
    support_threshold_angle: "35",
    support_filament: supportSlot,
    support_interface_filament: supportSlot,
    support_top_z_distance: "0.2",
    support_object_xy_distance: "0.35",
    tree_support_branch_angle: "45",
  });
  // Bambu Studio formats these with commas in projects.
  for (const k of ["best_object_pos", "default_wipe_tower_pos"]) {
    if (typeof ps[k] === "string") ps[k] = (ps[k] as string).replace("x", ",");
  }
  ps.different_settings_to_system = [PROCESS_OVERRIDES.join(";"), ...new Array(n).fill(""), ""];
  return ps;
}
