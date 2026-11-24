import { hexToRgb } from "./color.js";
import type { ColoredPart, Rgb } from "./types.js";
import { readZip } from "./zip.js";

export type UpAxis = "y" | "z";

export interface LoadOptions {
  /** Source up axis; Y-up input is rotated to Z-up (default: "y" for glTF, "z" otherwise). */
  upAxis?: UpAxis;
  /** Extra files referenced by the model (e.g. an .mtl for .obj), keyed by file name. */
  sidecars?: Record<string, Uint8Array | string>;
}

const decoder = new TextDecoder();
const asText = (b: Uint8Array | string) => (typeof b === "string" ? b : decoder.decode(b));

function finishPart(name: string, pos: number[], idx: number[], tri: number[] | undefined, up: UpAxis): ColoredPart {
  const positions = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    if (up === "y") {
      positions[i] = pos[i];
      positions[i + 1] = -pos[i + 2];
      positions[i + 2] = pos[i + 1];
    } else {
      positions[i] = pos[i];
      positions[i + 1] = pos[i + 1];
      positions[i + 2] = pos[i + 2];
    }
  }
  return { name, positions, indices: new Uint32Array(idx), triColors: tri ? new Uint8Array(tri) : undefined };
}

// --- STL -------------------------------------------------------------------

export function loadStl(bytes: Uint8Array, name = "stl", opts: LoadOptions = {}): ColoredPart[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pos: number[] = [];
  const idx: number[] = [];
  const isBinary = bytes.length >= 84 && 84 + view.getUint32(80, true) * 50 === bytes.length;
  if (isBinary) {
    const n = view.getUint32(80, true);
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50 + 12;
      for (let v = 0; v < 3; v++) {
        pos.push(view.getFloat32(o + v * 12, true), view.getFloat32(o + v * 12 + 4, true), view.getFloat32(o + v * 12 + 8, true));
        idx.push(idx.length);
      }
    }
  } else {
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(asText(bytes)))) {
      pos.push(+m[1], +m[2], +m[3]);
      idx.push(idx.length);
    }
  }
  return [finishPart(name, pos, idx, undefined, opts.upAxis ?? "z")];
}

// --- OBJ (+MTL Kd, + per-vertex colours) ----------------------------------

function parseMtl(text: string): Map<string, Rgb> {
  const out = new Map<string, Rgb>();
  let cur = "";
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === "newmtl") cur = t.slice(1).join(" ");
    else if (t[0] === "Kd" && cur) out.set(cur, [Math.round(+t[1] * 255), Math.round(+t[2] * 255), Math.round(+t[3] * 255)]);
  }
  return out;
}

export function loadObj(text: string | Uint8Array, name = "obj", opts: LoadOptions = {}): ColoredPart[] {
  const src = asText(text);
  const v: number[] = [];
  const vc: number[] = [];
  const materials = new Map<string, Rgb>();
  for (const [file, data] of Object.entries(opts.sidecars ?? {})) if (file.toLowerCase().endsWith(".mtl")) parseMtl(asText(data)).forEach((c, k) => materials.set(k, c));
  const groups = new Map<string, { pos: number[]; idx: number[]; tri: number[]; map: Map<number, number> }>();
  let current = name;
  let material: Rgb | undefined;
  const group = () => {
    let g = groups.get(current);
    if (!g) groups.set(current, (g = { pos: [], idx: [], tri: [], map: new Map() }));
    return g;
  };
  let anyColor = false;
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const t = line.split(/\s+/);
    if (t[0] === "v") {
      v.push(+t[1], +t[2], +t[3]);
      if (t.length >= 7) {
        const s = Math.max(+t[4], +t[5], +t[6]) > 1 ? 1 : 255;
        vc.push(+t[4] * s, +t[5] * s, +t[6] * s);
        anyColor = true;
      } else vc.push(NaN, NaN, NaN);
    } else if (t[0] === "o" || t[0] === "g") current = t.slice(1).join(" ") || name;
    else if (t[0] === "usemtl") {
      material = materials.get(t.slice(1).join(" "));
      if (material) anyColor = true;
    } else if (t[0] === "f") {
      const g = group();
      const ids = t.slice(1).map((f) => {
        const i = parseInt(f.split("/")[0], 10);
        return i < 0 ? v.length / 3 + i : i - 1;
      });
      const local = ids.map((i) => {
        let l = g.map.get(i);
        if (l === undefined) {
          l = g.pos.length / 3;
          g.pos.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
          g.map.set(i, l);
        }
        return l;
      });
      for (let k = 1; k + 1 < ids.length; k++) {
        g.idx.push(local[0], local[k], local[k + 1]);
        let col: Rgb = material ?? [200, 200, 200];
        const tri = [ids[0], ids[k], ids[k + 1]];
        if (!Number.isNaN(vc[tri[0] * 3])) {
          col = [0, 1, 2].map((c) => Math.round((vc[tri[0] * 3 + c] + vc[tri[1] * 3 + c] + vc[tri[2] * 3 + c]) / 3)) as unknown as Rgb;
        }
        g.tri.push(...col);
      }
    }
  }
  return [...groups.entries()].map(([n, g]) => finishPart(n, g.pos, g.idx, anyColor ? g.tri : undefined, opts.upAxis ?? "z"));
}

// --- PLY --------------------------------------------------------------------

export function loadPly(bytes: Uint8Array, name = "ply", opts: LoadOptions = {}): ColoredPart[] {
  const headEnd = (() => {
    const s = decoder.decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
    const i = s.indexOf("end_header");
    if (i < 0) throw new Error("PLY header not found");
    return s.indexOf("\n", i) + 1;
  })();
  const header = decoder.decode(bytes.subarray(0, headEnd)).split(/\r?\n/);
  const format = header.find((l) => l.startsWith("format"))?.split(/\s+/)[1] ?? "ascii";
  type Prop = { name: string; type: string; list?: [string, string] };
  const elements: { name: string; count: number; props: Prop[] }[] = [];
  for (const l of header) {
    const t = l.trim().split(/\s+/);
    if (t[0] === "element") elements.push({ name: t[1], count: +t[2], props: [] });
    else if (t[0] === "property") {
      const el = elements[elements.length - 1];
      if (t[1] === "list") el.props.push({ name: t[4], type: t[3], list: [t[2], t[3]] });
      else el.props.push({ name: t[2], type: t[1] });
    }
  }
  const size: Record<string, number> = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  const le = format !== "binary_big_endian";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = headEnd;
  const tokens = format === "ascii" ? decoder.decode(bytes.subarray(headEnd)).trim().split(/\s+/) : [];
  let ti = 0;
  const read = (type: string): number => {
    if (format === "ascii") return +tokens[ti++];
    let v: number;
    switch (type) {
      case "char": case "int8": v = view.getInt8(off); break;
      case "uchar": case "uint8": v = view.getUint8(off); break;
      case "short": case "int16": v = view.getInt16(off, le); break;
      case "ushort": case "uint16": v = view.getUint16(off, le); break;
      case "int": case "int32": v = view.getInt32(off, le); break;
      case "uint": case "uint32": v = view.getUint32(off, le); break;
      case "float": case "float32": v = view.getFloat32(off, le); break;
      default: v = view.getFloat64(off, le);
    }
    off += size[type];
    return v;
  };
  const pos: number[] = [];
  const vcol: number[] = [];
  const idx: number[] = [];
  const tri: number[] = [];
  let hasColor = false;
  for (const el of elements) {
    for (let i = 0; i < el.count; i++) {
      const rec: Record<string, number | number[]> = {};
      for (const p of el.props) {
        if (p.list) {
          const n = read(p.list[0]);
          const arr: number[] = [];
          for (let k = 0; k < n; k++) arr.push(read(p.list[1]));
          rec[p.name] = arr;
        } else rec[p.name] = read(p.type);
      }
      if (el.name === "vertex") {
        pos.push(rec.x as number, rec.y as number, rec.z as number);
        if (rec.red !== undefined) {
          hasColor = true;
          const isFloat = el.props.find((p) => p.name === "red")?.type.startsWith("float");
          const s = isFloat ? 255 : 1;
          vcol.push((rec.red as number) * s, (rec.green as number) * s, (rec.blue as number) * s);
        }
      } else if (el.name === "face") {
        const f = (rec.vertex_indices ?? rec.vertex_index) as number[];
        for (let k = 1; k + 1 < f.length; k++) {
          idx.push(f[0], f[k], f[k + 1]);
          if (hasColor) for (let c = 0; c < 3; c++) tri.push(Math.round((vcol[f[0] * 3 + c] + vcol[f[k] * 3 + c] + vcol[f[k + 1] * 3 + c]) / 3));
        }
      }
    }
  }
  return [finishPart(name, pos, idx, hasColor ? tri : undefined, opts.upAxis ?? "z")];
}

// --- 3MF (core spec + basematerials/colorgroup) ----------------------------

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m?.[1];
}

function parse3mfColor(s: string): Rgb {
  return hexToRgb(s.slice(0, 7));
}

export async function load3mf(bytes: Uint8Array, name = "3mf", opts: LoadOptions = {}): Promise<ColoredPart[]> {
  const zip = readZip(bytes);
  const models = zip.names.filter((n) => n.toLowerCase().endsWith(".model"));
  const parts: ColoredPart[] = [];
  for (const modelName of models) {
    const xml = await zip.readText(modelName);
    const unit = attr(/<model\b[^>]*>/.exec(xml)?.[0] ?? "", "unit") ?? "millimeter";
    const scale = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }[unit] ?? 1;
    const palettes = new Map<string, Rgb[]>();
    for (const m of xml.matchAll(/<(?:\w+:)?basematerials\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?basematerials>/g)) {
      palettes.set(attr(m[1], "id")!, [...m[2].matchAll(/<(?:\w+:)?base\b([^>]*)\/?>/g)].map((b) => parse3mfColor(attr(b[1], "displaycolor") ?? "#C8C8C8")));
    }
    for (const m of xml.matchAll(/<(?:\w+:)?colorgroup\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?colorgroup>/g)) {
      palettes.set(attr(m[1], "id")!, [...m[2].matchAll(/<(?:\w+:)?color\b([^>]*)\/?>/g)].map((b) => parse3mfColor(attr(b[1], "color") ?? "#C8C8C8")));
    }
    for (const o of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
      const meshXml = /<mesh>([\s\S]*?)<\/mesh>/.exec(o[2]);
      if (!meshXml) continue;
      const objPid = attr(o[1], "pid");
      const objP1 = attr(o[1], "pindex");
      const pos: number[] = [];
      for (const v of meshXml[1].matchAll(/<vertex\b([^>]*)\/>/g)) pos.push(+attr(v[1], "x")! * scale, +attr(v[1], "y")! * scale, +attr(v[1], "z")! * scale);
      const idx: number[] = [];
      const tri: number[] = [];
      let colored = false;
      for (const t of meshXml[1].matchAll(/<triangle\b([^>]*)\/>/g)) {
        idx.push(+attr(t[1], "v1")!, +attr(t[1], "v2")!, +attr(t[1], "v3")!);
        const pid = attr(t[1], "pid") ?? objPid;
        const p1 = attr(t[1], "p1") ?? objP1;
        const pal = pid ? palettes.get(pid) : undefined;
        const c = pal && p1 !== undefined ? pal[+p1] : undefined;
        if (c) colored = true;
        tri.push(...(c ?? [200, 200, 200]));
      }
      const label = attr(o[1], "name") ?? `${name}_${attr(o[1], "id")}`;
      parts.push(finishPart(label, pos, idx, colored ? tri : undefined, opts.upAxis ?? "z"));
    }
  }
  return parts;
}

// --- glTF binary (positions, indices, COLOR_0, baseColorFactor) ------------

interface GltfJson {
  meshes?: { name?: string; primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }[] }[];
  accessors: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  materials?: { pbrMetallicRoughness?: { baseColorFactor?: number[] } }[];
  nodes?: { mesh?: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; children?: number[] }[];
  scenes?: { nodes: number[] }[];
  scene?: number;
}

function linToSrgb255(c: number): number {
  const x = Math.min(1, Math.max(0, c));
  return Math.round((x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255);
}

function mat4Mul(a: number[], b: number[]): number[] {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

function nodeMatrix(n: NonNullable<GltfJson["nodes"]>[number]): number[] {
  if (n.matrix) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
    2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
    2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/**
 * Load a .glb. Reads positions, indices, COLOR_0 and material base colours.
 * Image textures are not decoded here; the browser studio samples them instead.
 */
export function loadGlb(bytes: Uint8Array, name = "glb", opts: LoadOptions = {}): ColoredPart[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("Not a GLB file");
  let off = 12;
  let json: GltfJson | undefined;
  let bin: Uint8Array | undefined;
  while (off < bytes.length) {
    const len = view.getUint32(off, true);
    const type = view.getUint32(off + 4, true);
    const chunk = bytes.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(decoder.decode(chunk));
    else if (type === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error("GLB is missing JSON or BIN chunk");
  const g = json;
  const comps: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const readAccessor = (i: number): number[] => {
    const a = g.accessors[i];
    const bv = g.bufferViews[a.bufferView ?? 0];
    const n = comps[a.type];
    const bytesPer = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType]!;
    const stride = bv.byteStride ?? n * bytesPer;
    const base = bin!.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const dv = new DataView(bin!.buffer);
    const out: number[] = [];
    for (let e = 0; e < a.count; e++) {
      for (let c = 0; c < n; c++) {
        const o = base + e * stride + c * bytesPer;
        let v: number;
        switch (a.componentType) {
          case 5120: v = dv.getInt8(o); if (a.normalized) v = Math.max(v / 127, -1); break;
          case 5121: v = dv.getUint8(o); if (a.normalized) v /= 255; break;
          case 5122: v = dv.getInt16(o, true); if (a.normalized) v = Math.max(v / 32767, -1); break;
          case 5123: v = dv.getUint16(o, true); if (a.normalized) v /= 65535; break;
          case 5125: v = dv.getUint32(o, true); break;
          default: v = dv.getFloat32(o, true);
        }
        out.push(v);
      }
    }
    return out;
  };
  const parts: ColoredPart[] = [];
  const visit = (nodeIdx: number, parent: number[]) => {
    const node = g.nodes![nodeIdx];
    const m = mat4Mul(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = g.meshes![node.mesh];
      mesh.primitives.forEach((prim, pi) => {
        if ((prim.mode ?? 4) !== 4) return;
        const p = readAccessor(prim.attributes.POSITION);
        const pos: number[] = [];
        for (let i = 0; i < p.length; i += 3) {
          const [x, y, z] = [p[i], p[i + 1], p[i + 2]];
          pos.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
        }
        const idx = prim.indices !== undefined ? readAccessor(prim.indices) : Array.from({ length: p.length / 3 }, (_, i) => i);
        const factor = g.materials?.[prim.material ?? -1]?.pbrMetallicRoughness?.baseColorFactor ?? [0.78, 0.78, 0.78, 1];
        const colAcc = prim.attributes.COLOR_0;
        const vcol = colAcc !== undefined ? readAccessor(colAcc) : undefined;
        const cn = colAcc !== undefined ? comps[g.accessors[colAcc].type] : 0;
        const tri: number[] = [];
        for (let t = 0; t < idx.length; t += 3) {
          for (let c = 0; c < 3; c++) {
            let lin = factor[c];
            if (vcol) lin *= (vcol[idx[t] * cn + c] + vcol[idx[t + 1] * cn + c] + vcol[idx[t + 2] * cn + c]) / 3;
            tri.push(linToSrgb255(lin));
          }
        }
        parts.push(finishPart(`${mesh.name ?? name}${mesh.primitives.length > 1 ? `_${pi}` : ""}`, pos, idx, tri, opts.upAxis ?? "y"));
      });
    }
    for (const ch of node.children ?? []) visit(ch, m);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? (g.nodes ?? []).map((_, i) => i);
  roots.forEach((r) => visit(r, identity));
  return parts;
}

/** Load any supported model by file extension. */
export async function loadModel(fileName: string, bytes: Uint8Array, opts: LoadOptions = {}): Promise<ColoredPart[]> {
  const ext = fileName.toLowerCase().split(".").pop();
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  switch (ext) {
    case "stl": return loadStl(bytes, base, opts);
    case "obj": return loadObj(bytes, base, opts);
    case "ply": return loadPly(bytes, base, opts);
    case "3mf": return load3mf(bytes, base, opts);
    case "glb": return loadGlb(bytes, base, opts);
    default: throw new Error(`Unsupported model format: .${ext} (use .glb, .obj, .ply, .stl or .3mf)`);
  }
}
