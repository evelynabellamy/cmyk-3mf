import { describe, expect, it } from "vitest";
import {
  KIT_PLA_PALETTE_CMYKW,
  buildCandidates,
  deltaE2000,
  enumerateRecipes,
  hexToLab,
  hexToRgb,
  labToRgb,
  matchMixedRecipe,
  parseCalibrationTable,
  predictMixHex,
  rgbToHex,
  rgbToLab,
  serializeCalibrationTable,
} from "../src/color.js";
import type { Lab } from "../src/types.js";

describe("colour conversions", () => {
  it("round-trips hex and Lab", () => {
    for (const hex of ["#000000", "#FFFFFF", "#0090DA", "#E24585", "#FCE300", "#7F3F1F"]) {
      expect(rgbToHex(hexToRgb(hex))).toBe(hex);
      expect(rgbToHex(labToRgb(rgbToLab(hexToRgb(hex))))).toBe(hex);
    }
  });
  it("maps white to L=100", () => {
    const [L, a, b] = hexToLab("#FFFFFF");
    expect(L).toBeCloseTo(100, 1);
    expect(Math.abs(a)).toBeLessThan(0.01);
    expect(Math.abs(b)).toBeLessThan(0.01);
  });
});

describe("CIEDE2000", () => {
  // Reference pairs from Sharma, Wu & Dalal (2005), Table 1.
  const pairs: [Lab, Lab, number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ];
  it.each(pairs)("pair %#", (a, b, expected) => {
    expect(deltaE2000(a, b)).toBeCloseTo(expected, 3);
  });
  it("is symmetric and zero for identical colours", () => {
    const a = hexToLab("#123456");
    const b = hexToLab("#654321");
    expect(deltaE2000(a, a)).toBe(0);
    expect(deltaE2000(a, b)).toBeCloseTo(deltaE2000(b, a), 10);
  });
});

describe("optical sublayer model", () => {
  const bases = KIT_PLA_PALETTE_CMYKW.bases;
  it("returns the base colour when both components are the same spool", () => {
    expect(deltaE2000(hexToLab(predictMixHex(bases, [5, 5], [0.5, 0.5])), hexToLab("#FFFFFF"))).toBeLessThan(1);
  });
  it("darkens monotonically as black increases", () => {
    const L = [0.15, 0.35, 0.55, 0.75].map((k) => hexToLab(predictMixHex(bases, [1, 4], [1 - k, k]))[0]);
    for (let i = 1; i < L.length; i++) expect(L[i]).toBeLessThan(L[i - 1]);
  });
  it("mixes cyan and yellow toward green", () => {
    const [, a] = hexToLab(predictMixHex(bases, [1, 3], [0.5, 0.5]));
    expect(a).toBeLessThan(-10);
  });
  it("enumerates recipes on the grid with the minimum share", () => {
    const r = enumerateRecipes(KIT_PLA_PALETTE_CMYKW, { step: 0.05, minShare: 0.15 });
    expect(r.length).toBeGreaterThan(500);
    for (const x of r) {
      expect(x.ratios.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
      expect(Math.min(...x.ratios)).toBeGreaterThanOrEqual(0.15 - 1e-9);
    }
  });
});

describe("matching", () => {
  const candidates = buildCandidates(KIT_PLA_PALETTE_CMYKW);
  it("matches a colour that is itself a predicted mix almost exactly", () => {
    const target = predictMixHex(KIT_PLA_PALETTE_CMYKW.bases, [2, 5], [0.4, 0.6]);
    const m = matchMixedRecipe(target, KIT_PLA_PALETTE_CMYKW, { candidates });
    expect(m.deltaE00).toBeLessThan(1);
    expect(m.recipe.components).toEqual([2, 5]);
  });
  it("prefers two-spool recipes within the bias", () => {
    const strict = matchMixedRecipe("#6A4C93", KIT_PLA_PALETTE_CMYKW, { candidates, preferTwoComponentDeltaE: 0 });
    const lenient = matchMixedRecipe("#6A4C93", KIT_PLA_PALETTE_CMYKW, { candidates, preferTwoComponentDeltaE: 100 });
    expect(lenient.recipe.components.length).toBe(2);
    expect(strict.deltaE00).toBeLessThanOrEqual(lenient.deltaE00);
  });
  it("uses calibrated colours over predictions", () => {
    const table = parseCalibrationTable(
      serializeCalibrationTable({
        format: "cmyk-3mf-calibration",
        version: 1,
        kitId: KIT_PLA_PALETTE_CMYKW.id,
        entries: [{ components: [1, 2], ratios: [0.5, 0.5], hex: "#00FF00" }],
      }),
    );
    const m = matchMixedRecipe("#00FF00", KIT_PLA_PALETTE_CMYKW, { calibration: table });
    expect(m.recipe.source).toBe("calibrated");
    expect(m.recipe.components).toEqual([1, 2]);
    expect(m.deltaE00).toBe(0);
  });
  it("rejects malformed calibration tables", () => {
    expect(() => parseCalibrationTable({ format: "nope" })).toThrow();
    expect(() =>
      parseCalibrationTable({ format: "cmyk-3mf-calibration", version: 1, kitId: "k", entries: [{ components: [1], ratios: [], hex: "#000" }] }),
    ).toThrow();
  });
});
