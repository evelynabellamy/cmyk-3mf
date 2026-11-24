/**
 * Bambu Studio preset resolution.
 *
 * This package ships no Bambu Studio profile data. Presets are read at runtime from
 * either Bambu's public GitHub repository at a pinned release tag, or a local
 * Bambu Studio installation, and flattened the way Bambu Studio does it:
 * base (via `inherits`) <- each `include` template <- the preset's own keys.
 */

export type PresetKind = "machine" | "process" | "filament";
export type PresetJson = Record<string, unknown>;

export interface PresetSource {
  /** Human-readable origin, recorded in exported project metadata. */
  label: string;
  /** Read one raw (unresolved) preset by name. */
  read(kind: PresetKind, name: string): Promise<PresetJson>;
}

export const DEFAULT_BAMBU_TAG = "v02.09.01.70";
export const DEFAULT_BAMBU_REPO = "bambulab/BambuStudio";

export interface GithubSourceOptions {
  /** Release tag or commit (default {@link DEFAULT_BAMBU_TAG}). */
  tag?: string;
  /** owner/repo (default bambulab/BambuStudio). */
  repo?: string;
  /** Vendor folder (default "BBL"). */
  vendor?: string;
  /** Override the raw-file host, e.g. for a mirror or tests. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Presets fetched from the Bambu Studio GitHub repository at a pinned tag. */
export function githubPresetSource(opts: GithubSourceOptions = {}): PresetSource {
  const tag = opts.tag ?? DEFAULT_BAMBU_TAG;
  const repo = opts.repo ?? DEFAULT_BAMBU_REPO;
  const vendor = opts.vendor ?? "BBL";
  const base = (opts.baseUrl ?? `https://raw.githubusercontent.com/${repo}/${tag}`).replace(/\/$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch;
  if (!doFetch) throw new Error("fetch is not available; pass opts.fetch");
  let indexPromise: Promise<Map<string, string>> | undefined;
  const getJson = async (path: string): Promise<PresetJson> => {
    const url = `${base}/${path.split("/").map(encodeURIComponent).join("/")}`;
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
    return (await res.json()) as PresetJson;
  };
  const index = () =>
    (indexPromise ??= getJson(`resources/profiles/${vendor}.json`).then((idx) => {
      const map = new Map<string, string>();
      for (const list of ["machine_model_list", "machine_list", "process_list", "filament_list"]) {
        for (const e of (idx[list] as { name: string; sub_path: string }[] | undefined) ?? []) map.set(e.name, e.sub_path);
      }
      return map;
    }));
  return {
    label: `github:${repo}@${tag}`,
    async read(kind, name) {
      const sub = (await index()).get(name) ?? `${kind}/${name}.json`;
      return getJson(`resources/profiles/${vendor}/${sub}`);
    },
  };
}

/** Presets read through a caller-supplied file reader (used for local installs). */
export function directoryPresetSource(label: string, readText: (relativePath: string) => Promise<string>): PresetSource {
  return {
    label,
    async read(kind, name) {
      return JSON.parse(await readText(`${kind}/${name}.json`)) as PresetJson;
    },
  };
}

/** Memoise reads (and therefore network requests) for a source. */
export function cachedPresetSource(source: PresetSource): PresetSource {
  const cache = new Map<string, Promise<PresetJson>>();
  return {
    label: source.label,
    read(kind, name) {
      const key = `${kind}/${name}`;
      let p = cache.get(key);
      if (!p) {
        p = source.read(kind, name);
        p.catch(() => cache.delete(key));
        cache.set(key, p);
      }
      return p;
    },
  };
}

const META_KEYS = new Set(["inherits", "include", "instantiation"]);

/** Resolve a preset's `inherits` chain and `include` templates into one flat object. */
export async function resolvePreset(source: PresetSource, kind: PresetKind, name: string, depth = 0): Promise<PresetJson> {
  if (depth > 16) throw new Error(`Preset inheritance too deep at ${name}`);
  const raw = await source.read(kind, name);
  const parent = typeof raw.inherits === "string" && raw.inherits ? await resolvePreset(source, kind, raw.inherits, depth + 1) : {};
  const out: PresetJson = { ...parent };
  const includes = Array.isArray(raw.include) ? (raw.include as string[]) : [];
  for (const inc of includes) Object.assign(out, await resolvePreset(source, kind, inc, depth + 1));
  for (const [k, v] of Object.entries(raw)) if (!META_KEYS.has(k)) out[k] = v;
  if (depth === 0) {
    out.name = raw.name ?? name;
    for (const k of META_KEYS) delete out[k];
  }
  return out;
}

export interface PresetBundle {
  source: string;
  machine: PresetJson;
  process: PresetJson;
  filament: PresetJson;
  names: { machine: string; process: string; filament: string };
}

export async function loadPresetBundle(source: PresetSource, names: { machine: string; process: string; filament: string }): Promise<PresetBundle> {
  const [machine, process, filament] = await Promise.all([
    resolvePreset(source, "machine", names.machine),
    resolvePreset(source, "process", names.process),
    resolvePreset(source, "filament", names.filament),
  ]);
  return { source: source.label, machine, process, filament, names };
}
