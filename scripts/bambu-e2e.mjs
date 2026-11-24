#!/usr/bin/env node
// End-to-end check: build projects with cmyk-3mf, slice them with the local Bambu Studio CLI,
// and assert a clean slice with the printer's own G-code and active mixed filaments.
// Usage: npm run build && node scripts/bambu-e2e.mjs [--presets github|local|<dir>] [--keep]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  cachedPresetSource, convertToBambu3mf, flutedVase, generateCalibrationCard, githubPresetSource, inspect3mf, readZip,
} from "../dist/index.js";
import { findBambuStudioExecutable, findLocalPresetSource, localPresetSource } from "../dist/node.js";

const { values } = parseArgs({ options: { presets: { type: "string" }, exe: { type: "string" }, out: { type: "string" } } });
const exe = values.exe ?? findBambuStudioExecutable();
if (!exe) {
  console.error("Bambu Studio executable not found; pass --exe. Skipping.");
  process.exit(0);
}
const spec = values.presets ?? "github";
const presets = cachedPresetSource(spec === "github" ? githubPresetSource() : spec === "local" ? findLocalPresetSource() : localPresetSource(spec));
const out = resolve(values.out ?? ".e2e");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function checkerCube() {
  // 20 mm cube with each face a different colour, to exercise paint_color.
  const p = [0,0,0, 20,0,0, 20,20,0, 0,20,0, 0,0,20, 20,0,20, 20,20,20, 0,20,20];
  const f = [[0,2,1,0,3,2],[4,5,6,4,6,7],[0,1,5,0,5,4],[1,2,6,1,6,5],[2,3,7,2,7,6],[3,0,4,3,4,7]];
  const faceCols = [[0,0,0],[255,255,255],[0,144,218],[226,69,133],[252,227,0],[60,140,70]];
  const idx = f.flat();
  const cols = f.flatMap((_, i) => [...faceCols[i], ...faceCols[i]]);
  return { name: "Checker_Cube", positions: new Float32Array(p), indices: new Uint32Array(idx), triColors: new Uint8Array(cols) };
}

const cases = [];
const vase = await convertToBambu3mf([flutedVase()], { presets, title: "Fluted vase demo", targetHeightMm: 120 });
cases.push({ name: "vase", bytes: vase.bytes, expectMixed: true, expectSupport: true, info: `${vase.slotCount} slots, ΔE00 ${vase.meanDeltaE00.toFixed(1)}` });
const cube = await convertToBambu3mf([checkerCube()], { presets, title: "Checker cube", palette: { maxMixedSlots: 2 } });
cases.push({ name: "cube", bytes: cube.bytes, expectMixed: true, expectSupport: false, info: `${cube.slotCount} slots` });
const card = await generateCalibrationCard({ presets });
cases.push({ name: "calibration", bytes: card.bytes, expectMixed: true, expectSupport: false, info: `${card.slotCount} slots` });

let failed = 0;
for (const c of cases) {
  const dir = join(out, c.name);
  mkdirSync(dir, { recursive: true });
  const input = join(dir, `${c.name}.3mf`);
  writeFileSync(input, c.bytes);
  const pre = await inspect3mf(c.bytes);
  const t0 = Date.now();
  const r = spawnSync(exe, ["--slice", "1", "--outputdir", dir, "--export-3mf", "sliced.3mf", input], { encoding: "utf8", timeout: 900_000 });
  const rc = r.status === null ? null : r.status > 2 ** 31 ? r.status - 2 ** 32 : r.status;
  const checks = [];
  const ok = (name, pass, detail = "") => checks.push({ name, pass, detail });
  ok("bambu exit code 0", rc === 0, `rc=${rc}`);
  const resPath = join(dir, "result.json");
  const res = existsSync(resPath) ? JSON.parse(readFileSync(resPath, "utf8")) : {};
  const plate = res.sliced_plates?.[0];
  ok("no slicer warning", plate && !plate.warning_message, JSON.stringify(plate?.warning_message ?? res.error_string));
  ok("input mesh has no open/reversed edges", pre.objects.every((o) => o.openEdges === 0 && o.reversedEdges === 0));
  if (existsSync(join(dir, "sliced.3mf"))) {
    const z = readZip(new Uint8Array(readFileSync(join(dir, "sliced.3mf"))));
    const gname = z.names.find((n) => n.endsWith(".gcode"));
    const gcode = gname ? await z.readText(gname) : "";
    const info = z.has("Metadata/slice_info.config") ? await z.readText("Metadata/slice_info.config") : "";
    ok("printer start G-code (H3C marker)", gcode.includes("machine: H3C start"));
    ok("toolchange G-code present", (gcode.match(/;======== H3C ======/g) ?? []).length > 0, `${(gcode.match(/;======== H3C ======/g) ?? []).length} changes`);
    const mixedCount = (info.match(/<mixed_filament /g) ?? []).length;
    if (c.expectMixed) ok("mixed filaments active", mixedCount > 0, `${mixedCount}`);
    const sup = /key="support_used" value="([^"]+)"/.exec(info)?.[1];
    if (c.expectSupport) ok("supports generated", sup === "true", `support_used=${sup}`);
    const edges = [...info.matchAll(/edges_fixed="(\d+)"/g)].map((m) => +m[1]);
    ok("Bambu fixed no edges", edges.every((e) => e === 0), edges.join(","));
  } else ok("sliced 3mf written", false);
  const pass = checks.every((x) => x.pass);
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"} ${c.name} (${c.info}, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  for (const x of checks) console.log(`   ${x.pass ? "ok " : "XX "} ${x.name}${x.detail ? ` — ${x.detail}` : ""}`);
}
console.log(`presets: ${presets.label}`);
process.exit(failed ? 1 : 0);
