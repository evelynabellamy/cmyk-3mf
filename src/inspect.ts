import { analyzeEdges } from "./mesh.js";
import { decodePaintColor } from "./writer.js";
import { readZip } from "./zip.js";

export interface InspectReport {
  application?: string;
  printer?: string;
  process?: string;
  filaments: { slot: number; colour: string; preset?: string; mixed: boolean; components?: string; ratios?: string }[];
  objects: { file: string; id: string; vertices: number; triangles: number; openEdges: number; nonManifoldEdges: number; reversedEdges: number; paintedTriangles: Record<number, number> }[];
  settings: Record<string, string | undefined>;
  warnings: string[];
}

const KEY_SETTINGS = ["layer_height", "enable_support", "support_type", "wall_generator", "enable_prime_tower", "prime_tower_width", "wipe_tower_x", "wipe_tower_y", "enable_mixed_color_sublayer", "curr_bed_type"];

/** Summarise a Bambu Studio .3mf: printer, filaments, mixed recipes and per-object mesh health. */
export async function inspect3mf(bytes: Uint8Array): Promise<InspectReport> {
  const zip = readZip(bytes);
  const warnings: string[] = [];
  let settings: Record<string, unknown> = {};
  if (zip.has("Metadata/project_settings.config")) settings = JSON.parse(await zip.readText("Metadata/project_settings.config"));
  else warnings.push("No Metadata/project_settings.config: Bambu Studio will use its current presets.");
  const arr = (k: string) => (Array.isArray(settings[k]) ? (settings[k] as unknown[]).map(String) : []);
  const colours = arr("filament_colour");
  const mixed = arr("filament_is_mixed");
  const comps = arr("filament_mixed_components");
  const ratios = arr("filament_mixed_sublayer_ratios");
  const presets = arr("filament_settings_id");
  const filaments = colours.map((c, i) => ({
    slot: i + 1,
    colour: c,
    preset: presets[i],
    mixed: mixed[i] === "1",
    components: comps[i] || undefined,
    ratios: ratios[i] || undefined,
  }));
  const startGcode = typeof settings.machine_start_gcode === "string" ? settings.machine_start_gcode : "";
  if (settings.printer_model && startGcode && startGcode.length < 200) {
    warnings.push(`machine_start_gcode is only ${startGcode.length} characters; it may be a generic default rather than the printer's own start sequence.`);
  }
  if (settings.printer_model && !settings.change_filament_gcode && colours.length > 1) warnings.push("change_filament_gcode is empty on a multi-filament project.");

  const objects: InspectReport["objects"] = [];
  for (const file of zip.names.filter((n) => n.endsWith(".model"))) {
    const xml = await zip.readText(file);
    for (const o of xml.matchAll(/<object\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/object>/g)) {
      const mesh = /<mesh>([\s\S]*?)<\/mesh>/.exec(o[2]);
      if (!mesh) continue;
      const vertices = (mesh[1].match(/<vertex\b/g) ?? []).length;
      const idx: number[] = [];
      const painted: Record<number, number> = {};
      for (const t of mesh[1].matchAll(/<triangle\b([^>]*)\/>/g)) {
        const v = /v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"/.exec(t[1]);
        if (v) idx.push(+v[1], +v[2], +v[3]);
        const p = /paint_color="([^"]+)"/.exec(t[1]);
        if (p) {
          try {
            const s = decodePaintColor(p[1]);
            painted[s] = (painted[s] ?? 0) + 1;
          } catch {
            painted[-1] = (painted[-1] ?? 0) + 1;
          }
        }
      }
      const e = analyzeEdges(idx);
      objects.push({ file, id: o[1], vertices, triangles: idx.length / 3, openEdges: e.open, nonManifoldEdges: e.nonManifold, reversedEdges: e.reversed, paintedTriangles: painted });
      if (e.open || e.reversed) warnings.push(`${file} object ${o[1]}: ${e.open} open and ${e.reversed} reversed edges.`);
    }
  }
  let application: string | undefined;
  if (zip.has("3D/3dmodel.model")) application = /<metadata name="Application">([^<]*)</.exec(await zip.readText("3D/3dmodel.model"))?.[1];
  const s: Record<string, string | undefined> = {};
  for (const k of KEY_SETTINGS) s[k] = settings[k] === undefined ? undefined : Array.isArray(settings[k]) ? (settings[k] as unknown[]).join(",") : String(settings[k]);
  return {
    application,
    printer: settings.printer_settings_id as string | undefined,
    process: settings.print_settings_id as string | undefined,
    filaments,
    objects,
    settings: s,
    warnings,
  };
}
