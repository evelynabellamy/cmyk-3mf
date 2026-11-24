#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { generateCalibrationCard } from "./calibration.js";
import { KITS, parseCalibrationTable } from "./color.js";
import { convertToBambu3mf } from "./convert.js";
import { inspect3mf } from "./inspect.js";
import { loadModel } from "./loaders.js";
import { findLocalPresetSource, localPresetSource } from "./node.js";
import { cachedPresetSource, DEFAULT_BAMBU_TAG, githubPresetSource, type PresetSource } from "./presets.js";
import { PRINTERS } from "./printers.js";
import type { SupportMode } from "./types.js";

const HELP = `cmyk-3mf — colored 3D models to Bambu Studio CMYKW mixed-filament projects

Usage:
  cmyk-3mf convert <model.(glb|obj|ply|stl|3mf)> -o <out.3mf> [options]
  cmyk-3mf calibrate -o <card.3mf> [--page 0] [options]
  cmyk-3mf inspect <file.3mf> [--json]

Options:
  --printer <id>        Printer profile (default bbl-h3c-0.4). Known: ${Object.keys(PRINTERS).join(", ")}
  --kit <id>            Filament kit (default pla-palette-cmykw)
  --colors <n>          Maximum mixed slots, 0-12 (default 8)
  --height <mm>         Scale the model to this height
  --inflate <mm>        Thicken thin shells outward by this much (default 0)
  --supports <mode>     tree | normal | none (default tree)
  --layer <mm>          Layer height (default 0.16)
  --calibration <json>  Measured calibration table from a printed card
  --up <y|z>            Source up axis (default y for .glb, z otherwise)
  --mtl <file.mtl>      Material library for .obj colours
  --presets <source>    github (default), github@<tag>, local, or a folder path
  --no-repair           Skip mesh repair
  --json                Machine-readable output
  -h, --help            Show this help

Presets are read at runtime from github.com/bambulab/BambuStudio@${DEFAULT_BAMBU_TAG} or a local
Bambu Studio install; this package does not include them.`;

function presetSourceFrom(spec: string | undefined): PresetSource {
  if (!spec || spec === "github") return cachedPresetSource(githubPresetSource());
  if (spec.startsWith("github@")) return cachedPresetSource(githubPresetSource({ tag: spec.slice(7) }));
  if (spec === "local") {
    const s = findLocalPresetSource();
    if (!s) throw new Error("No local Bambu Studio profiles found; use --presets github or a folder path");
    return cachedPresetSource(s);
  }
  return cachedPresetSource(localPresetSource(spec));
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      printer: { type: "string" },
      kit: { type: "string" },
      colors: { type: "string" },
      height: { type: "string" },
      inflate: { type: "string" },
      supports: { type: "string" },
      layer: { type: "string" },
      calibration: { type: "string" },
      up: { type: "string" },
      mtl: { type: "string" },
      presets: { type: "string" },
      page: { type: "string" },
      "no-repair": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, input] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return command || values.help ? 0 : 1;
  }
  const kit = KITS[values.kit ?? "pla-palette-cmykw"];
  if (!kit) throw new Error(`Unknown kit ${values.kit}. Known: ${Object.keys(KITS).join(", ")}`);
  const supports = (values.supports ?? "tree") as SupportMode;
  if (!["tree", "normal", "none"].includes(supports)) throw new Error("--supports must be tree, normal or none");
  const processOpts = { supports, layerHeightMm: values.layer ? Number(values.layer) : undefined };
  const print = (human: string, data: unknown) => console.log(values.json ? JSON.stringify(data, null, 2) : human);

  if (command === "inspect") {
    if (!input) throw new Error("inspect needs a .3mf file");
    const r = await inspect3mf(new Uint8Array(await readFile(input)));
    const lines = [
      `${basename(input)}: ${r.printer ?? "unknown printer"} / ${r.process ?? "unknown process"} (${r.application ?? "unknown app"})`,
      ...r.filaments.map((f) => `  slot ${String(f.slot).padStart(2)} ${f.colour}${f.mixed ? ` mixed ${f.components} @ ${f.ratios}` : ""}`),
      ...r.objects.map((o) => `  ${o.file}#${o.id}: ${o.triangles} tris, open ${o.openEdges}, reversed ${o.reversedEdges}, painted ${JSON.stringify(o.paintedTriangles)}`),
      ...Object.entries(r.settings).map(([k, v]) => `  ${k} = ${v ?? "(unset)"}`),
      ...r.warnings.map((w) => `  ! ${w}`),
    ];
    print(lines.join("\n"), r);
    return r.warnings.length ? 2 : 0;
  }

  if (!values.output) throw new Error("--output/-o is required");
  const presets = presetSourceFrom(values.presets);

  if (command === "calibrate") {
    const card = await generateCalibrationCard({ printer: values.printer, kit, page: values.page ? Number(values.page) : 0, presets, process: processOpts });
    await writeFile(values.output, card.bytes);
    const tablePath = join(dirname(values.output), basename(values.output).replace(/\.3mf$/i, "") + ".calibration.json");
    await writeFile(tablePath, JSON.stringify(card.template, null, 2) + "\n");
    print(
      [`Wrote ${values.output} (${(card.bytes.length / 1024).toFixed(0)} KB, ${card.slotCount} slots)`, `Wrote ${tablePath} (fill in measured colours)`, ...card.legend.map((l) => `  row ${l.row} col ${l.col}: slot ${l.slot} ${l.label}`)].join("\n"),
      { output: values.output, table: tablePath, legend: card.legend, primeTower: card.primeTower },
    );
    return 0;
  }

  if (command === "convert") {
    if (!input) throw new Error("convert needs an input model");
    const sidecars: Record<string, Uint8Array> = {};
    if (values.mtl) sidecars[basename(values.mtl)] = new Uint8Array(await readFile(values.mtl));
    else if (input.toLowerCase().endsWith(".obj")) {
      const guess = input.replace(/\.obj$/i, ".mtl");
      try {
        sidecars[basename(guess)] = new Uint8Array(await readFile(guess));
      } catch {
        /* no material library */
      }
    }
    const parts = await loadModel(input, new Uint8Array(await readFile(input)), { upAxis: values.up as "y" | "z" | undefined, sidecars });
    if (parts.length === 0) throw new Error("No triangles found in the input");
    const calibration = values.calibration ? parseCalibrationTable(await readFile(values.calibration, "utf8")) : undefined;
    const r = await convertToBambu3mf(parts, {
      printer: values.printer,
      kit,
      targetHeightMm: values.height ? Number(values.height) : undefined,
      palette: { maxMixedSlots: values.colors ? Number(values.colors) : 8, calibration },
      repair: values["no-repair"] ? false : { inflateMm: values.inflate ? Number(values.inflate) : 0 },
      process: processOpts,
      presets,
      title: basename(input).replace(/\.[^.]+$/, ""),
    });
    await writeFile(values.output, r.bytes);
    const size = r.printability.sizeMm.map((v) => v.toFixed(1)).join(" × ");
    print(
      [
        `Wrote ${values.output} (${(r.bytes.length / 1024 / 1024).toFixed(2)} MB)`,
        `  size ${size} mm, ${r.triangleCount} triangles, ${r.slotCount} slots, mean ΔE00 ${r.meanDeltaE00.toFixed(1)}`,
        `  presets ${r.presetSource}`,
        ...r.palette.slots.map((s) => `  slot ${String(s.slot).padStart(2)} ${s.hex}${s.recipe ? ` = ${s.recipe.components.join("+")} @ ${s.recipe.ratios.join("/")}` : ""}${s.areaShare ? ` (${(s.areaShare * 100).toFixed(1)}% area${s.deltaE00 !== undefined ? `, ΔE00 ${s.deltaE00.toFixed(1)}` : ""})` : ""}`),
        ...r.repairs.map((m, i) => `  part ${i + 1}: open edges ${m.openEdgesBefore}→${m.openEdgesAfter}, reversed ${m.reversedEdgesBefore}→${m.reversedEdgesAfter}, capped ${m.cappedLoops} loop(s)`),
        ...r.printability.warnings.map((w) => `  ! ${w}`),
      ].join("\n"),
      { output: values.output, size: r.printability.sizeMm, slots: r.palette.slots, meanDeltaE00: r.meanDeltaE00, repairs: r.repairs, printability: r.printability, primeTower: r.primeTower, presets: r.presetSource },
    );
    return 0;
  }
  throw new Error(`Unknown command "${command}"`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`cmyk-3mf: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
