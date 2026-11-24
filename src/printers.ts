import type { PrinterProfile } from "./types.js";

/**
 * Printer targets. Only profiles marked `verified` have been sliced end-to-end
 * with the Bambu Studio CLI; others are best-effort and need a test print.
 */
export const PRINTERS: Record<string, PrinterProfile> = {
  "bbl-h3c-0.4": {
    id: "bbl-h3c-0.4",
    label: "Bambu Lab H3C (0.4 mm nozzle)",
    machinePreset: "Bambu Lab H3C 0.4 nozzle",
    processPreset: "0.20mm Standard @BBL H3C",
    bed: [330, 320],
    maxHeight: 325,
    verified: true,
  },
};

export function getPrinter(id: string): PrinterProfile {
  const p = PRINTERS[id] ?? Object.values(PRINTERS).find((x) => x.id.endsWith(id) || x.id.includes(`-${id}-`));
  if (!p) throw new Error(`Unknown printer "${id}". Known: ${Object.keys(PRINTERS).join(", ")}`);
  return p;
}
