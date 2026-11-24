import { loadPresetBundle, type PresetBundle, type PresetJson, type PresetSource } from "../src/presets.js";
import type { ColoredPart } from "../src/types.js";

/** Synthetic presets (not Bambu data) shaped like Bambu Studio's JSON files. */
export const FAKE_PRESETS: Record<string, PresetJson> = {
  "machine/base_machine": {
    name: "base_machine",
    machine_start_gcode: "GENERIC START",
    change_filament_gcode: "GENERIC CHANGE",
    nozzle_diameter: ["0.4"],
    printable_area: ["0x0", "330x0", "330x320", "0x320"],
    printable_height: "325",
    best_object_pos: "0.5x0.5",
  },
  "machine/tpl_start": { name: "tpl_start", instantiation: "false", machine_start_gcode: ";===== machine: TEST start" },
  "machine/Test Printer 0.4 nozzle": { name: "Test Printer 0.4 nozzle", inherits: "base_machine", include: ["tpl_start"], printer_model: "Test Printer", setting_id: "X1" },
  "process/base_process": { name: "base_process", layer_height: "0.2", wall_loops: "3" },
  "process/0.20mm Test": { name: "0.20mm Test", inherits: "base_process", sparse_infill_density: "20%" },
  "filament/Test PLA": { name: "Test PLA", filament_id: "TST01", nozzle_temperature: ["220", "225"], filament_type: ["PLA"] },
};

export function fakeSource(log: string[] = []): PresetSource {
  return {
    label: "fake",
    async read(kind, name) {
      log.push(`${kind}/${name}`);
      const v = FAKE_PRESETS[`${kind}/${name}`];
      if (!v) throw new Error(`missing ${kind}/${name}`);
      return structuredClone(v);
    },
  };
}

export const FAKE_NAMES = { machine: "Test Printer 0.4 nozzle", process: "0.20mm Test", filament: "Test PLA" };

export function fakeBundle(): Promise<PresetBundle> {
  return loadPresetBundle(fakeSource(), FAKE_NAMES);
}

/** Axis-aligned cube, optionally coloured per face. */
export function cube(size = 20, faceColors?: number[][]): ColoredPart {
  const s = size;
  const positions = new Float32Array([0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0, 0, 0, s, s, 0, s, s, s, s, 0, s, s]);
  const faces = [
    [0, 2, 1, 0, 3, 2],
    [4, 5, 6, 4, 6, 7],
    [0, 1, 5, 0, 5, 4],
    [1, 2, 6, 1, 6, 5],
    [2, 3, 7, 2, 7, 6],
    [3, 0, 4, 3, 4, 7],
  ];
  const indices = new Uint32Array(faces.flat());
  const triColors = faceColors ? new Uint8Array(faces.flatMap((_, i) => [...faceColors[i], ...faceColors[i]])) : undefined;
  return { name: "cube", positions, indices, triColors };
}
