/** sRGB triple, each channel 0..255. */
export type Rgb = readonly [number, number, number];
/** CIELAB (D65) triple. */
export type Lab = readonly [number, number, number];

/**
 * A triangle mesh in millimetres, Z up.
 * `positions` holds xyz triples; `indices` holds counter-clockwise (outward) triangles.
 */
export interface IndexedMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** A named part of a model, optionally with one sRGB colour per triangle. */
export interface ColoredPart extends IndexedMesh {
  name: string;
  /** Per-triangle sRGB colours, length = triangleCount * 3. */
  triColors?: Uint8Array;
  /** Uniform colour used when `triColors` is absent. */
  color?: Rgb;
}

/** A part ready for export: each triangle carries a 1-based filament slot. */
export interface SlottedPart extends IndexedMesh {
  name: string;
  /** Default 1-based filament slot for the part. */
  extruder: number;
  /** Optional per-triangle 1-based filament slot (0 = use the part default). */
  triSlots?: Uint8Array;
}

/** A base (physical) spool. */
export interface BaseFilament {
  /** Short label, e.g. "Cyan". */
  name: string;
  hex: string;
}

export interface FilamentKit {
  id: string;
  label: string;
  /** Bambu Studio filament preset name used for every slot. */
  filamentPreset: string;
  bases: readonly BaseFilament[];
}

/** A virtual mixed filament built from optical sublayers of base spools. */
export interface MixedRecipe {
  /** 1-based indices into the kit's base spools. */
  components: number[];
  /** Fractions that sum to 1, same order as `components`. */
  ratios: number[];
  /** Predicted printed colour. */
  hex: string;
  /** Where the prediction came from. */
  source: "optical-model" | "calibrated";
}

/** One slot of a solved palette, in project order. */
export interface PaletteSlot {
  /** 1-based slot number in the exported project. */
  slot: number;
  kind: "base" | "mixed";
  /** Predicted printed colour. */
  hex: string;
  /** Mean source colour the slot stands in for (when solved from a model). */
  targetHex?: string;
  /** CIEDE2000 between target and predicted print. */
  deltaE00?: number;
  /** Share of total surface area assigned to this slot (0..1). */
  areaShare?: number;
  recipe?: MixedRecipe;
}

export interface Palette {
  kit: FilamentKit;
  slots: PaletteSlot[];
}

/** Printer + process + filament preset names for a target printer. */
export interface PrinterProfile {
  id: string;
  label: string;
  machinePreset: string;
  processPreset: string;
  /** Bed size in mm (X, Y). */
  bed: readonly [number, number];
  maxHeight: number;
  /** Whether this profile has been checked end-to-end against Bambu Studio. */
  verified: boolean;
}

export interface ManifoldReport {
  verticesBefore: number;
  verticesAfter: number;
  trianglesBefore: number;
  trianglesAfter: number;
  degenerateRemoved: number;
  openEdgesBefore: number;
  openEdgesAfter: number;
  nonManifoldEdgesAfter: number;
  reversedEdgesBefore: number;
  reversedEdgesAfter: number;
  cappedLoops: number;
  cappedTriangles: number;
  flippedComponents: number;
  components: number;
  volumeMm3: number;
}

export interface PrintabilityReport {
  sizeMm: [number, number, number];
  scale: number;
  triangles: number;
  /** Share of surface area facing downward steeper than the overhang angle. */
  overhangShare: number;
  /** Connected components whose lowest point is above the first layer. */
  floatingComponents: number;
  /** Connected components whose smallest bounding-box extent is under the minimum feature size. */
  thinComponents: number;
  warnings: string[];
}

export type SupportMode = "tree" | "normal" | "none";
