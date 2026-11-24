import { describe, expect, it } from "vitest";
import { KIT_PLA_PALETTE_CMYKW } from "../src/color.js";
import { inspect3mf } from "../src/inspect.js";
import { PRINTERS } from "../src/printers.js";
import { computeFlushMatrix, computePrimeTower } from "../src/settings.js";
import type { Palette, SlottedPart } from "../src/types.js";
import { MAX_PAINT_SLOT, decodePaintColor, encodePaintColor, exportBambu3mf } from "../src/writer.js";
import { readZip } from "../src/zip.js";
import { cube, fakeBundle } from "./helpers.js";

describe("paint_color codes", () => {
  it("matches the codes Bambu Studio uses", () => {
    expect([1, 2, 3, 4, 6, 11, 18].map(encodePaintColor)).toEqual(["4", "8", "0C", "1C", "3C", "8C", "FC"]);
  });
  it("round-trips every addressable slot", () => {
    for (let s = 1; s <= MAX_PAINT_SLOT; s++) expect(decodePaintColor(encodePaintColor(s))).toBe(s);
  });
  it("rejects out-of-range slots", () => {
    expect(() => encodePaintColor(0)).toThrow();
    expect(() => encodePaintColor(MAX_PAINT_SLOT + 1)).toThrow();
  });
});

describe("flush matrix and prime tower", () => {
  it("has a zero diagonal and positive off-diagonal volumes", () => {
    const hex = ["#000000", "#FFFFFF", "#0090DA"];
    const m = computeFlushMatrix(hex).map(Number);
    expect(m).toHaveLength(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) i === j ? expect(m[i * 3 + j]).toBe(0) : expect(m[i * 3 + j]).toBeGreaterThan(0);
    expect(m[0 * 3 + 1]).toBeGreaterThan(m[1 * 3 + 0]); // black -> white purges more than white -> black
  });
  it("keeps 25 mm clear of the model", () => {
    const box: [number, number, number, number] = [100, 90, 230, 230];
    const t = computePrimeTower([330, 320], box);
    const depth = Math.max(t.width, 60);
    const gapX = Math.max(box[0] - (t.x + t.width), t.x - box[2], 0);
    const gapY = Math.max(box[1] - (t.y + depth), t.y - box[3], 0);
    expect(Math.hypot(gapX, gapY)).toBeGreaterThanOrEqual(25);
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(t.y + depth).toBeLessThanOrEqual(320);
  });
  it("throws when nothing fits", () => {
    expect(() => computePrimeTower([330, 320], [5, 5, 325, 315])).toThrow();
  });
});

describe("exportBambu3mf", () => {
  const kit = KIT_PLA_PALETTE_CMYKW;
  const palette: Palette = {
    kit,
    slots: [
      ...kit.bases.map((b, i) => ({ slot: i + 1, kind: "base" as const, hex: b.hex })),
      { slot: 6, kind: "mixed", hex: "#984265", recipe: { components: [2, 4], ratios: [0.75, 0.25], hex: "#984265", source: "optical-model" } },
    ],
  };

  it("writes a project with an assembly, paint codes, mixed recipes and locked overrides", async () => {
    const c = cube(20);
    for (let i = 0; i < c.positions.length; i += 3) {
      c.positions[i] -= 10;
      c.positions[i + 1] -= 10;
    }
    const triSlots = new Uint8Array(12).fill(4);
    triSlots[0] = 6;
    triSlots[1] = 1;
    const part: SlottedPart = { name: "cube & co", positions: c.positions, indices: c.indices, extruder: 4, triSlots };
    const bundle = await fakeBundle();
    const { bytes, primeTower } = await exportBambu3mf([part], palette, { printer: PRINTERS["bbl-h3c-0.4"], bundle, title: "Test <1>" });
    const zip = readZip(bytes);
    expect(zip.names).toEqual(expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model", "3D/Objects/object_1.model", "Metadata/project_settings.config", "Metadata/model_settings.config"]));

    const root = await zip.readText("3D/3dmodel.model");
    expect(root).toContain('<metadata name="Title">Test &lt;1&gt;</metadata>');
    expect(root).toMatch(/<component p:path="\/3D\/Objects\/object_1.model" objectid="1"/);
    expect(root).toMatch(/transform="1 0 0 0 1 0 0 0 1 165 160 0"/);

    const obj = await zip.readText("3D/Objects/object_1.model");
    expect((obj.match(/paint_color="3C"/g) ?? []).length).toBe(1);
    expect((obj.match(/paint_color="4"/g) ?? []).length).toBe(1);
    expect((obj.match(/paint_color=/g) ?? []).length).toBe(2);

    const ps = JSON.parse(await zip.readText("Metadata/project_settings.config"));
    expect(ps.machine_start_gcode).toBe(";===== machine: TEST start");
    expect(ps.printer_settings_id).toBe("Test Printer 0.4 nozzle");
    expect(ps.filament_settings_id).toEqual(new Array(6).fill("Test PLA"));
    expect(ps.filament_ids).toEqual(new Array(6).fill("TST01"));
    expect(ps.nozzle_temperature).toEqual(new Array(6).fill("220"));
    expect(ps.filament_is_mixed).toEqual(["0", "0", "0", "0", "0", "1"]);
    expect(ps.filament_mixed_components[5]).toBe("2,4");
    expect(ps.filament_mixed_sublayer_ratios[5]).toBe("0.75,0.25");
    expect(ps.flush_volumes_matrix).toHaveLength(36);
    expect(ps.best_object_pos).toBe("0.5,0.5");
    expect(ps.different_settings_to_system).toHaveLength(8);
    expect(ps.different_settings_to_system[0]).toContain("enable_support");
    expect(ps.support_filament).toBe("4");
    expect(ps.wipe_tower_x).toEqual([String(primeTower.x)]);
    expect(ps).not.toHaveProperty("setting_id");

    const ms = await zip.readText("Metadata/model_settings.config");
    expect(ms).toContain('<metadata key="name" value="cube &amp; co"/>');
    expect(ms).toContain('<metadata key="extruder" value="4"/>');

    const report = await inspect3mf(bytes);
    expect(report.filaments).toHaveLength(6);
    expect(report.objects[0].openEdges).toBe(0);
    expect(report.objects[0].paintedTriangles).toEqual({ 1: 1, 6: 1 });
  });

  it("is deterministic", async () => {
    const bundle = await fakeBundle();
    const part: SlottedPart = { ...cube(), name: "c", extruder: 1 };
    const a = await exportBambu3mf([part], palette, { printer: PRINTERS["bbl-h3c-0.4"], bundle });
    const b = await exportBambu3mf([part], palette, { printer: PRINTERS["bbl-h3c-0.4"], bundle });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it("refuses models larger than the bed", async () => {
    const bundle = await fakeBundle();
    const part: SlottedPart = { ...cube(400), name: "big", extruder: 1 };
    await expect(exportBambu3mf([part], palette, { printer: PRINTERS["bbl-h3c-0.4"], bundle })).rejects.toThrow(/does not fit/);
  });
});
