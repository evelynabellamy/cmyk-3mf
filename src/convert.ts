import { KIT_PLA_PALETTE_CMYKW } from "./color.js";
import { analyzePrintability, fitToHeight, repairMesh, type RepairOptions } from "./mesh.js";
import { solvePalette, type PaletteOptions } from "./palette.js";
import { cachedPresetSource, githubPresetSource, loadPresetBundle, type PresetBundle, type PresetSource } from "./presets.js";
import { getPrinter } from "./printers.js";
import type { ProcessOptions } from "./settings.js";
import type { ColoredPart, FilamentKit, ManifoldReport, Palette, PrintabilityReport, PrinterProfile } from "./types.js";
import { exportBambu3mf, type ExportResult } from "./writer.js";

export interface ConvertOptions {
  /** Printer id (default "bbl-h3c-0.4") or a profile. */
  printer?: string | PrinterProfile;
  kit?: FilamentKit;
  /** Scale the assembly to this height in mm. Omit to keep the model's size. */
  targetHeightMm?: number;
  palette?: PaletteOptions;
  repair?: RepairOptions | false;
  process?: ProcessOptions;
  /** Where to read Bambu Studio presets (default: GitHub at the pinned tag). */
  presets?: PresetSource;
  /** Pre-loaded presets (skips the source). */
  bundle?: PresetBundle;
  title?: string;
  description?: string;
}

export interface ConvertResult extends ExportResult {
  palette: Palette;
  meanDeltaE00: number;
  repairs: ManifoldReport[];
  printability: PrintabilityReport;
  scale: number;
  presetSource: string;
}

let defaultSource: PresetSource | undefined;
export function defaultPresetSource(): PresetSource {
  return (defaultSource ??= cachedPresetSource(githubPresetSource()));
}

/** Load the preset bundle for a printer + kit. */
export async function loadPrinterPresets(printer: PrinterProfile, kit: FilamentKit, source: PresetSource = defaultPresetSource()): Promise<PresetBundle> {
  return loadPresetBundle(source, { machine: printer.machinePreset, process: printer.processPreset, filament: kit.filamentPreset });
}

function clonePart(p: ColoredPart): ColoredPart {
  return { ...p, positions: new Float32Array(p.positions), indices: new Uint32Array(p.indices), triColors: p.triColors ? new Uint8Array(p.triColors) : undefined };
}

/**
 * Full pipeline: fit to height, repair every part, solve a CMYKW palette and write a
 * Bambu Studio project. Input parts are not modified.
 */
export async function convertToBambu3mf(input: ColoredPart[], opts: ConvertOptions = {}): Promise<ConvertResult> {
  const printer = typeof opts.printer === "object" ? opts.printer : getPrinter(opts.printer ?? "bbl-h3c-0.4");
  const kit = opts.kit ?? KIT_PLA_PALETTE_CMYKW;
  const parts = input.map(clonePart);
  const scale = fitToHeight(parts, opts.targetHeightMm);

  const repairs: ManifoldReport[] = [];
  const repaired: ColoredPart[] = parts.map((part) => {
    if (opts.repair === false) return part;
    const triCount = part.indices.length / 3;
    const colours = part.triColors ? Array.from({ length: triCount }, (_, t) => [part.triColors![t * 3], part.triColors![t * 3 + 1], part.triColors![t * 3 + 2]]) : undefined;
    const r = repairMesh(part, colours, opts.repair);
    repairs.push(r.report);
    return {
      name: part.name,
      positions: r.positions,
      indices: r.indices,
      color: part.color,
      triColors: r.triData ? new Uint8Array(r.triData.flat()) : undefined,
    };
  });
  // Inflation can push vertices slightly below the plate; re-seat the assembly.
  fitToHeight(repaired);

  const solved = solvePalette(repaired, kit, opts.palette);
  const bundle = opts.bundle ?? (await loadPrinterPresets(printer, kit, opts.presets));
  const printability = analyzePrintability(solved.parts);
  printability.scale = scale;
  const result = await exportBambu3mf(solved.parts, solved.palette, {
    printer,
    bundle,
    title: opts.title,
    description: opts.description,
    process: opts.process,
    reports: repairs.length ? repairs : undefined,
  });
  return { ...result, palette: solved.palette, meanDeltaE00: solved.meanDeltaE00, repairs, printability, scale, presetSource: bundle.source };
}
