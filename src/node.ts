import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { directoryPresetSource, type PresetSource } from "./presets.js";

/**
 * Candidate folders holding Bambu Studio's system presets on this machine.
 * Bambu Studio keeps its auto-updated vendor profiles in the user config folder.
 */
export function localBambuProfileDirs(vendor = "BBL"): string[] {
  const dirs: string[] = [];
  const env = process.env;
  if (platform() === "win32") {
    if (env.APPDATA) dirs.push(join(env.APPDATA, "BambuStudio", "system", vendor));
    for (const pf of [env.ProgramFiles, env["ProgramFiles(x86)"]]) if (pf) dirs.push(join(pf, "Bambu Studio", "resources", "profiles", vendor));
  } else if (platform() === "darwin") {
    dirs.push(join(homedir(), "Library", "Application Support", "BambuStudio", "system", vendor));
    dirs.push(join("/Applications", "BambuStudio.app", "Contents", "Resources", "profiles", vendor));
  } else {
    dirs.push(join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "BambuStudio", "system", vendor));
  }
  return dirs.filter((d) => existsSync(join(d, "machine")));
}

/** Presets from a folder laid out like Bambu Studio's `<vendor>/{machine,process,filament}`. */
export function localPresetSource(dir: string): PresetSource {
  return directoryPresetSource(`local:${dir}`, (rel) => readFile(join(dir, rel), "utf8"));
}

/** The first local Bambu Studio installation found, or undefined. */
export function findLocalPresetSource(vendor = "BBL"): PresetSource | undefined {
  const dir = localBambuProfileDirs(vendor)[0];
  return dir ? localPresetSource(dir) : undefined;
}

/** Default Bambu Studio executable path for the current OS, if present. */
export function findBambuStudioExecutable(): string | undefined {
  const candidates =
    platform() === "win32"
      ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Bambu Studio", "bambu-studio.exe")]
      : platform() === "darwin"
        ? ["/Applications/BambuStudio.app/Contents/MacOS/BambuStudio"]
        : ["/usr/bin/bambu-studio", "/opt/bambu-studio/bin/bambu-studio"];
  return candidates.find((c) => existsSync(c));
}
