# Notices

cmyk-3mf is MIT-licensed and contains no third-party code or data.

## Bambu Studio presets (fetched at run time, not distributed)

When cmyk-3mf builds a project, it reads printer, process and filament presets from the
[bambulab/BambuStudio](https://github.com/bambulab/BambuStudio) repository (AGPL-3.0) at a
pinned release tag, or from a Bambu Studio installation on the user's machine. These files are
not included in this repository or its npm package. Exported `.3mf` files embed the resolved
preset values, as any project saved by Bambu Studio does.

"Bambu Lab", "Bambu Studio" and "H3C" are trademarks of their owner. cmyk-3mf is an independent
project and is not affiliated with or endorsed by Bambu Lab.

## Colour science references

- G. Sharma, W. Wu, E. N. Dalal, "The CIEDE2000 color-difference formula: Implementation notes,
  supplementary test data, and mathematical observations," *Color Research & Application* 30(1), 2005.
- P. Kubelka, F. Munk, "Ein Beitrag zur Optik der Farbanstriche," *Zeitschrift für technische Physik* 12, 1931.
