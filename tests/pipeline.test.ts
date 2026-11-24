import { describe, expect, it } from "vitest";
import { generateCalibrationCard, calibrationRecipes } from "../src/calibration.js";
import { KIT_PLA_PALETTE_CMYKW, hexToLab, deltaE2000 } from "../src/color.js";
import { convertToBambu3mf } from "../src/convert.js";
import { flutedVase } from "../src/demo.js";
import { inspect3mf } from "../src/inspect.js";
import { analyzeEdges } from "../src/mesh.js";
import { denoise, solvePalette } from "../src/palette.js";
import { subdivideByColorContrast } from "../src/subdivide.js";
import { cube, fakeBundle } from "./helpers.js";

describe("solvePalette", () => {
  it("prints base-coloured faces with base spools and others with mixed slots", () => {
    const part = cube(20, [[0, 0, 0], [255, 255, 255], [0, 144, 218], [226, 69, 133], [252, 227, 0], [60, 140, 70]]);
    const s = solvePalette([part], KIT_PLA_PALETTE_CMYKW, { maxMixedSlots: 3, spatialDenoise: false });
    expect(s.palette.slots.slice(0, 5).map((x) => x.kind)).toEqual(["base", "base", "base", "base", "base"]);
    const slots = s.parts[0].triSlots!;
    expect([slots[0], slots[2], slots[4], slots[6], slots[8]]).toEqual([4, 5, 1, 2, 3]);
    const green = s.palette.slots[slots[10] - 1];
    expect(green.kind).toBe("mixed");
    expect(green.recipe!.components).toContain(1);
    expect(green.recipe!.components).toContain(3);
    expect(s.palette.slots.reduce((a, x) => a + (x.areaShare ?? 0), 0)).toBeCloseTo(1, 6);
  });

  it("respects the mixed-slot budget", () => {
    const vase = flutedVase({ segments: 48, rings: 24 });
    const s = solvePalette([vase], KIT_PLA_PALETTE_CMYKW, { maxMixedSlots: 2 });
    expect(s.palette.slots.filter((x) => x.kind === "mixed").length).toBeLessThanOrEqual(2);
    expect(Math.max(...s.parts[0].triSlots!)).toBeLessThanOrEqual(s.palette.slots.length);
  });

  it("spends a tight slot budget where dropping a colour would cost the most", () => {
    const vase = flutedVase({ segments: 120, rings: 80, flutes: 14, gradient: ["#123B4A", "#1F7A8C", "#B33F6B", "#E9805A", "#F4C542"] });
    const s = solvePalette([vase], KIT_PLA_PALETTE_CMYKW, { maxMixedSlots: 8 });
    const visible = s.palette.slots.filter((x) => (x.areaShare ?? 0) > 0.02);
    expect(Math.max(...visible.map((x) => x.deltaE00 ?? 0))).toBeLessThan(12);
  });

  it("denoise removes isolated triangles", () => {
    const c = cube();
    const slots = new Uint8Array(12).fill(1);
    slots[3] = 2;
    expect(denoise(c.indices, slots)).toBe(1);
    expect(slots[3]).toBe(1);
  });
});

describe("subdivideByColorContrast", () => {
  it("refines along a colour edge and stays watertight after welding", () => {
    const c = cube(20);
    const uvs = new Float32Array((c.positions.length / 3) * 2);
    for (let v = 0; v < c.positions.length / 3; v++) {
      uvs[v * 2] = c.positions[v * 3] / 20;
      uvs[v * 2 + 1] = c.positions[v * 3 + 2] / 20;
    }
    const sampler = (u: number) => (u < 0.37 ? ([0, 0, 0] as const) : ([255, 255, 255] as const));
    const r = subdivideByColorContrast({ positions: c.positions, uvs, indices: c.indices }, sampler, { maxDepth: 3, minEdgeMm: 0.5 });
    expect(r.indices.length / 3).toBeGreaterThan(12);
    expect(r.rounds).toBeGreaterThan(0);
    expect(analyzeEdges(r.indices).open).toBe(0);
    expect(r.triColors.length).toBe(r.indices.length);
  });
});

describe("flutedVase", () => {
  it("is a closed, consistently wound solid before any repair", () => {
    const v = flutedVase({ segments: 48, rings: 24 });
    const e = analyzeEdges(v.indices);
    expect(e).toEqual({ open: 0, nonManifold: 0, reversed: 0 });
  });
});

describe("convertToBambu3mf", () => {
  it("runs the full pipeline on the demo vase", async () => {
    const bundle = await fakeBundle();
    const r = await convertToBambu3mf([flutedVase({ segments: 64, rings: 32 })], { bundle, targetHeightMm: 90 });
    expect(r.printability.sizeMm[2]).toBeCloseTo(90, 1);
    expect(r.repairs[0].openEdgesAfter).toBe(0);
    expect(r.repairs[0].reversedEdgesAfter).toBe(0);
    expect(r.palette.slots.some((s) => s.kind === "mixed")).toBe(true);
    const rep = await inspect3mf(r.bytes);
    expect(rep.objects.every((o) => o.openEdges === 0 && o.reversedEdges === 0)).toBe(true);
  });
});

describe("calibration card", () => {
  it("spreads recipes and builds a fillable table", async () => {
    const recipes = calibrationRecipes();
    expect(recipes.length).toBe(60);
    const firstTwo = recipes.slice(0, 2).map((r) => hexToLab(r.hex));
    expect(deltaE2000(firstTwo[0], firstTwo[1])).toBeGreaterThan(10);
    const card = await generateCalibrationCard({ bundle: await fakeBundle() });
    expect(card.slotCount).toBe(17);
    expect(card.template.entries).toHaveLength(12);
    expect(card.legend[0]).toMatchObject({ row: 0, col: 0, slot: 1, label: "Cyan" });
    const rep = await inspect3mf(card.bytes);
    expect(rep.objects).toHaveLength(18);
    expect(rep.settings.enable_support).toBe("0");
  });
});
