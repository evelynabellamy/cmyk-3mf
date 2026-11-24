# cmyk-3mf

Convert colored 3D models into **Bambu Studio projects that print in CMYKW mixed filaments**.
Five physical spools (cyan, magenta, yellow, black, white) plus up to twelve *virtual* mixed
filaments, which Bambu Studio prints as alternating optical sublayers.

- Zero runtime dependencies. Runs in Node 20+ and in the browser.
- Reads `.glb`, `.obj` (+ `.mtl` / vertex colours), `.ply`, `.stl` and `.3mf`.
- Repairs meshes (weld, winding, hole capping, inside-out shells, optional thickening).
- Solves an area-weighted CMYKW palette and paints every triangle (`paint_color`).
- Writes a complete Bambu Studio project with the printer's real presets, tree supports,
  a prime tower clear of the model, and purge volumes for every filament pair.
- Prints a swatch calibration card so you can replace predicted colours with measured ones.

> **Status: 0.1.** Output for the **Bambu Lab H3C (0.4 mm)** is checked end-to-end with the
> Bambu Studio 02.09.01.70 command line (see [Verification](#verification)). Colour predictions
> come from a generic optical model until you calibrate with your own spools.

## Quick start

```sh
npx cmyk-3mf convert flower.glb -o flower.3mf --height 120 --colors 8
npx cmyk-3mf calibrate -o card.3mf          # print it, measure the tiles
npx cmyk-3mf convert flower.glb -o flower.3mf --calibration card.calibration.json
npx cmyk-3mf inspect flower.3mf
```

Open the `.3mf` in Bambu Studio, check the plate, and slice.

### Options

| Option | Default | |
| --- | --- | --- |
| `--printer` | `bbl-h3c-0.4` | Printer profile |
| `--colors` | `8` | Maximum mixed slots (0–12) |
| `--height` | model size | Scale to this height (mm). glTF is in metres, so set this for `.glb` |
| `--inflate` | `0` | Push thin shells outward (mm) for miniatures |
| `--supports` | `tree` | `tree`, `normal` or `none` |
| `--layer` | `0.16` | Layer height (mm) |
| `--calibration` | | Measured table from a printed card |
| `--presets` | `github` | `github`, `github@<tag>`, `local`, or a profile folder |
| `--up` | `y` for glb, else `z` | Source up axis |

## Where the printer presets come from

A Bambu Studio project must embed the printer's full machine, process and filament settings,
including its own start and tool-change G-code. A project with partial settings either
fails to slice or silently falls back to generic defaults, which is unsafe on a tool changer.

**This package does not ship those presets.** They belong to Bambu Lab and are published under
AGPL-3.0 in [bambulab/BambuStudio](https://github.com/bambulab/BambuStudio). At run time
cmyk-3mf reads them from one of:

- **GitHub (default):** `raw.githubusercontent.com/bambulab/BambuStudio/v02.09.01.70/resources/profiles/BBL/…`,
  pinned to a release tag. Requests go straight from your machine or browser to GitHub.
- **Your local Bambu Studio install** (`--presets local`), which also works offline.

Presets are resolved the way Bambu Studio does it: the `inherits` chain first, then each
`include` template (where the H3C's G-code lives), then the preset's own keys.

## Library

```ts
import { convertToBambu3mf, loadModel } from "cmyk-3mf";

const parts = await loadModel("vase.glb", bytes);
const result = await convertToBambu3mf(parts, {
  printer: "bbl-h3c-0.4",
  targetHeightMm: 120,
  palette: { maxMixedSlots: 8 },
  repair: { inflateMm: 0 },
});
// result.bytes      .3mf file
// result.palette    slots with predicted colour, recipe, ΔE00 and area share
// result.repairs    per-part manifold report
// result.printability  size, overhang share, floating and thin components
```

Lower-level pieces are exported too: `solvePalette`, `repairMesh`, `subdivideByColorContrast`
(adaptive, watertight refinement along texture edges), `exportBambu3mf`, `generateCalibrationCard`,
`inspect3mf`, `deltaE2000`, `predictMixHex`, `writeZip` / `readZip`, and the preset sources
(`githubPresetSource`, `cachedPresetSource`; `localPresetSource` from `cmyk-3mf/node`).

## How the colour model works

Each mixed slot is a recipe such as *magenta 75 % + black 25 %*. Bambu Studio splits each layer
into sublayers in those proportions. What you see depends on the surface:

- On **vertical walls** the eye resolves fine stripes and averages them (additive).
- On **top surfaces** light passes through thin translucent layers (subtractive).

cmyk-3mf predicts the result with a clean-room blend of both: a single-constant Kubelka–Munk
mix of the spools' reflectance, weighted against a linear average (`subtractiveWeight`,
default 0.55). It is a starting point, not a measurement. Expect the largest errors on
shallow slopes and saturated mixes, and calibrate:

1. `cmyk-3mf calibrate -o card.3mf` (5 base + 12 mixed tiles; `--page 1…4` for 48 more recipes).
2. Print it and measure each tile's top surface with a colorimeter or a colour-checked photo.
3. Put the measured hex values into `card.calibration.json` and pass it to `--calibration`.

The base CMYKW hex values are generic process-colour approximations, not any vendor's
published spool colours.

## Verification

`npm test` runs the unit suite (ZIP, CIEDE2000 against Sharma et al. 2005 reference pairs, the
optical model, mesh repair, subdivision, palette solving, preset resolution, the project
writer and loaders) with synthetic presets.

`npm run build && npm run e2e:bambu` needs Bambu Studio installed. It builds a demo vase, a
painted cube and a calibration card, slices each with `bambu-studio --slice 1`, and checks:
exit code 0, no slicer warning, no open or reversed edges, the H3C's own start G-code, tool
changes present, mixed filaments active, and supports generated where expected.

## Limits

- Only the H3C profile is verified. Other printers need a test slice and print.
- Per-triangle painting can address 18 slots, so palettes are capped at 5 base + 12 mixed.
- Filament presets are applied with their first-listed value per key.
- The Node CLI reads glTF vertex colours and material colours but not image textures;
  the browser studio samples textures.
- Bambu Studio's GUI may still adjust settings when it opens a project; check the plate before printing.

## Releasing

Releases go through npm trusted publishing: no npm token lives in GitHub. Publishing a GitHub
release (tag `vX.Y.Z` matching `package.json`) runs `.github/workflows/publish.yml` in the
`npm` environment, which tests, builds and runs `npm stage publish` over OIDC with provenance.
A maintainer then approves the staged version with 2FA on npmjs.com before it goes live.

## License

MIT © Evelyna Bellamy. See [NOTICE.md](NOTICE.md) for third-party material that is fetched
at run time and not distributed with this package.
