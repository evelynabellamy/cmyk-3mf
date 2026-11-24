import { describe, expect, it } from "vitest";
import { analyzeEdges, analyzePrintability, fitToHeight, repairMesh } from "../src/mesh.js";
import { cube } from "./helpers.js";

describe("repairMesh", () => {
  it("leaves a clean cube closed with positive volume", () => {
    const r = repairMesh(cube());
    expect(r.report.openEdgesAfter).toBe(0);
    expect(r.report.reversedEdgesAfter).toBe(0);
    expect(r.report.volumeMm3).toBeCloseTo(8000, 3);
  });

  it("fixes a flipped triangle and a missing face", () => {
    const c = cube();
    const idx = Array.from(c.indices);
    [idx[1], idx[2]] = [idx[2], idx[1]];
    const holed = new Uint32Array(idx.slice(0, 30));
    expect(analyzeEdges(holed).open).toBeGreaterThan(0);
    const r = repairMesh({ positions: c.positions, indices: holed }, Array.from({ length: 10 }, (_, i) => i));
    expect(r.report.openEdgesAfter).toBe(0);
    expect(r.report.reversedEdgesAfter).toBe(0);
    expect(r.report.cappedLoops).toBe(1);
    expect(r.report.volumeMm3).toBeGreaterThan(7000);
    expect(r.triData).toHaveLength(r.indices.length / 3);
  });

  it("turns an inside-out shell the right way", () => {
    const c = cube();
    const inv = new Uint32Array(c.indices.length);
    for (let t = 0; t < c.indices.length; t += 3) inv.set([c.indices[t], c.indices[t + 2], c.indices[t + 1]], t);
    const r = repairMesh({ positions: c.positions, indices: inv });
    expect(r.report.flippedComponents).toBe(1);
    expect(r.report.volumeMm3).toBeCloseTo(8000, 3);
  });

  it("welds duplicated vertices and drops degenerate triangles", () => {
    const c = cube();
    const pos: number[] = [];
    const idx: number[] = [];
    for (let t = 0; t < c.indices.length; t++) {
      const v = c.indices[t];
      pos.push(c.positions[v * 3] + 1e-5, c.positions[v * 3 + 1], c.positions[v * 3 + 2]);
      idx.push(t);
    }
    idx.push(0, 0, 1);
    const r = repairMesh({ positions: new Float32Array(pos), indices: new Uint32Array(idx) });
    expect(r.report.verticesAfter).toBe(8);
    expect(r.report.degenerateRemoved).toBe(1);
    expect(r.report.openEdgesAfter).toBe(0);
  });

  it("inflates outward", () => {
    const r = repairMesh(cube(), undefined, { inflateMm: 0.5 });
    expect(r.report.volumeMm3).toBeGreaterThan(8000);
  });
});

describe("fit and printability", () => {
  it("scales to height and centres on the plate", () => {
    const c = cube(10);
    expect(fitToHeight([c], 50)).toBeCloseTo(5);
    const zs = Array.from(c.positions).filter((_, i) => i % 3 === 2);
    const xs = Array.from(c.positions).filter((_, i) => i % 3 === 0);
    expect(Math.min(...zs)).toBeCloseTo(0);
    expect(Math.max(...xs)).toBeCloseTo(25);
  });
  it("flags thin and floating parts", () => {
    const thin = cube(0.5);
    for (let i = 2; i < thin.positions.length; i += 3) thin.positions[i] += 5;
    const r = analyzePrintability([cube(), thin]);
    expect(r.thinComponents).toBe(1);
    expect(r.floatingComponents).toBe(1);
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
  });
});
