import { computeBounds } from "./mesh.js";
import type { PresetBundle } from "./presets.js";
import { buildProjectSettings, computePrimeTower, BAMBU_APP_VERSION, type PrimeTower, type ProcessOptions } from "./settings.js";
import type { ManifoldReport, Palette, PrinterProfile, SlottedPart } from "./types.js";
import { writeZip } from "./zip.js";

/** Highest filament slot that a per-triangle paint code can address. */
export const MAX_PAINT_SLOT = 18;

/**
 * Bambu Studio per-triangle `paint_color` code for a 1-based filament slot.
 * Slots 1 and 2 use a single nibble ("4", "8"); slot N >= 3 uses "C" plus the nibble N-3,
 * written most-significant first (slot 3 -> "0C", slot 4 -> "1C", slot 18 -> "FC").
 */
export function encodePaintColor(slot: number): string {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_PAINT_SLOT) throw new Error(`Paint slot out of range: ${slot}`);
  if (slot === 1) return "4";
  if (slot === 2) return "8";
  return (slot - 3).toString(16).toUpperCase() + "C";
}

export function decodePaintColor(code: string): number {
  if (code === "4") return 1;
  if (code === "8") return 2;
  const m = /^([0-9A-F])C$/i.exec(code);
  if (!m) throw new Error(`Unsupported paint code: ${code}`);
  return parseInt(m[1], 16) + 3;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function num(v: number): string {
  const s = v.toFixed(4);
  return s.replace(/\.?0+$/, "") || "0";
}

/** Deterministic UUID-shaped identifiers so identical input yields identical files. */
function uuidFactory(seed: string): () => string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  let counter = 0;
  return () => {
    const parts: string[] = [];
    for (let i = 0; i < 4; i++) {
      h = Math.imul(h ^ (counter++ + i * 7919), 2654435761) >>> 0;
      parts.push(h.toString(16).padStart(8, "0"));
    }
    const hex = parts.join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
}

export interface ExportOptions {
  printer: PrinterProfile;
  bundle: PresetBundle;
  title?: string;
  description?: string;
  process?: ProcessOptions;
  /** Override the computed prime tower placement. */
  primeTower?: PrimeTower;
  /** Repair reports per part (same order), used for mesh_stat metadata. */
  reports?: ManifoldReport[];
  /** Compress the archive (default true). */
  compress?: boolean;
}

export interface ExportResult {
  bytes: Uint8Array;
  primeTower: PrimeTower;
  slotCount: number;
  triangleCount: number;
}

/**
 * Write a Bambu Studio project (.3mf) for parts already in millimetres, centred on X/Y = 0
 * with Z >= 0. The assembly is placed at the bed centre as one object so parts keep their
 * relative positions.
 */
export async function exportBambu3mf(parts: SlottedPart[], palette: Palette, opts: ExportOptions): Promise<ExportResult> {
  if (parts.length === 0) throw new Error("Nothing to export");
  const slotCount = palette.slots.length;
  if (slotCount > MAX_PAINT_SLOT) throw new Error(`Too many filament slots (${slotCount} > ${MAX_PAINT_SLOT})`);
  const { printer, bundle } = opts;
  const title = opts.title ?? "cmyk-3mf export";
  const uuid = uuidFactory(`${title}|${parts.map((p) => `${p.name}:${p.indices.length}`).join(",")}`);

  const b = computeBounds(parts);
  const cx = printer.bed[0] / 2;
  const cy = printer.bed[1] / 2;
  if (b.max[0] - b.min[0] > printer.bed[0] || b.max[1] - b.min[1] > printer.bed[1] || b.max[2] > printer.maxHeight) {
    throw new Error(`Model (${num(b.max[0] - b.min[0])} × ${num(b.max[1] - b.min[1])} × ${num(b.max[2])} mm) does not fit the ${printer.label} build volume`);
  }
  const modelBox: [number, number, number, number] = [b.min[0] + cx, b.min[1] + cy, b.max[0] + cx, b.max[1] + cy];
  const primeTower = opts.primeTower ?? computePrimeTower(printer.bed, modelBox);

  // 3D/Objects/object_1.model — one mesh object per part
  const objectXml: string[] = [];
  let triangleCount = 0;
  parts.forEach((part, i) => {
    if (part.extruder < 1 || part.extruder > slotCount) throw new Error(`Part ${part.name} uses slot ${part.extruder} of ${slotCount}`);
    const p = part.positions;
    const v: string[] = new Array(p.length / 3);
    for (let k = 0; k < p.length / 3; k++) v[k] = `<vertex x="${num(p[k * 3])}" y="${num(p[k * 3 + 1])}" z="${num(p[k * 3 + 2])}"/>`;
    const t: string[] = new Array(part.indices.length / 3);
    for (let k = 0; k < part.indices.length / 3; k++) {
      const slot = part.triSlots?.[k] ?? 0;
      if (slot > slotCount) throw new Error(`Triangle slot ${slot} exceeds ${slotCount} slots`);
      const paint = slot && slot !== part.extruder ? ` paint_color="${encodePaintColor(slot)}"` : "";
      t[k] = `<triangle v1="${part.indices[k * 3]}" v2="${part.indices[k * 3 + 1]}" v3="${part.indices[k * 3 + 2]}"${paint}/>`;
    }
    triangleCount += t.length;
    objectXml.push(`  <object id="${i + 1}" p:UUID="${uuid()}" type="model">\n   <mesh>\n    <vertices>\n     ${v.join("\n     ")}\n    </vertices>\n    <triangles>\n     ${t.join("\n     ")}\n    </triangles>\n   </mesh>\n  </object>`);
  });
  const objectModel = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
${objectXml.join("\n")}
 </resources>
 <build/>
</model>
`;

  const asmId = parts.length + 1;
  const partUuids = parts.map(() => uuid());
  const rootModel = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="Application">BambuStudio-${BAMBU_APP_VERSION}</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="Title">${xmlEscape(title)}</metadata>
 <metadata name="Description">${xmlEscape(opts.description ?? "")}</metadata>
 <metadata name="Designer">cmyk-3mf</metadata>
 <resources>
  <object id="${asmId}" p:UUID="${uuid()}" type="model">
   <components>
${parts.map((_, i) => `    <component p:path="/3D/Objects/object_1.model" objectid="${i + 1}" p:UUID="${partUuids[i]}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`).join("\n")}
   </components>
  </object>
 </resources>
 <build p:UUID="${uuid()}">
  <item objectid="${asmId}" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 ${num(cx)} ${num(cy)} 0" printable="1"/>
 </build>
</model>
`;

  const partSettings = parts
    .map((part, i) => {
      const r = opts.reports?.[i];
      return `    <part id="${i + 1}" subtype="normal_part" uuid="${partUuids[i]}">
      <metadata key="name" value="${xmlEscape(part.name)}"/>
      <metadata key="extruder" value="${part.extruder}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <mesh_stat face_count="${part.indices.length / 3}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="${r ? r.reversedEdgesAfter : 0}"/>
    </part>`;
    })
    .join("\n");
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="${asmId}">
    <metadata key="name" value="${xmlEscape(title)}"/>
    <metadata key="extruder" value="${parts[0].extruder}"/>
    <metadata face_count="${triangleCount}"/>
${partSettings}
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value="${xmlEscape(title)}"/>
    <metadata key="locked" value="false"/>
    <metadata key="filament_map_mode" value="Auto For Flush"/>
    <model_instance>
      <metadata key="object_id" value="${asmId}"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="101"/>
    </model_instance>
  </plate>
  <assemble></assemble>
</config>
`;

  const settings = buildProjectSettings({ bundle, palette, primeTower, process: opts.process });
  const bytes = await writeZip(
    [
      {
        name: "[Content_Types].xml",
        data: `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>
`,
      },
      {
        name: "_rels/.rels",
        data: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`,
      },
      { name: "3D/3dmodel.model", data: rootModel },
      {
        name: "3D/_rels/3dmodel.model.rels",
        data: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`,
      },
      { name: "3D/Objects/object_1.model", data: objectModel },
      { name: "Metadata/project_settings.config", data: JSON.stringify(settings, null, 4) },
      { name: "Metadata/model_settings.config", data: modelSettings },
    ],
    { compress: opts.compress },
  );
  return { bytes, primeTower, slotCount, triangleCount };
}
