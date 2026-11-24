import { describe, expect, it } from "vitest";
import { KIT_PLA_PALETTE_CMYKW } from "../src/color.js";
import { load3mf, loadGlb, loadModel, loadObj, loadPly, loadStl } from "../src/loaders.js";
import { PRINTERS } from "../src/printers.js";
import { exportBambu3mf } from "../src/writer.js";
import { cube, fakeBundle } from "./helpers.js";

const enc = new TextEncoder();

describe("loaders", () => {
  it("reads ASCII and binary STL", () => {
    const ascii = "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n";
    expect(loadStl(enc.encode(ascii))[0].indices.length).toBe(3);
    const bin = new Uint8Array(84 + 50);
    const dv = new DataView(bin.buffer);
    dv.setUint32(80, 1, true);
    [0, 0, 0, 2, 0, 0, 0, 2, 0].forEach((v, i) => dv.setFloat32(84 + 12 + i * 4, v, true));
    const p = loadStl(bin)[0];
    expect(Array.from(p.positions)).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0]);
  });

  it("reads OBJ groups, MTL colours and vertex colours, triangulating quads", () => {
    const obj = "mtllib m.mtl\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0 0 1 1 0 0\no red\nusemtl Red\nf 1 2 3 4\no vc\nf 1 2 5\n";
    const mtl = "newmtl Red\nKd 1 0 0\n";
    const parts = loadObj(obj, "t", { sidecars: { "m.mtl": mtl } });
    expect(parts.map((p) => p.name)).toEqual(["red", "vc"]);
    expect(parts[0].indices.length).toBe(6);
    expect(Array.from(parts[0].triColors!.slice(0, 3))).toEqual([255, 0, 0]);
  });

  it("reads ASCII PLY with vertex colours", () => {
    const ply = "ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0 255 0 0\n1 0 0 255 0 0\n0 1 0 255 0 0\n3 0 1 2\n";
    const p = loadPly(enc.encode(ply))[0];
    expect(p.indices.length).toBe(3);
    expect(Array.from(p.triColors!)).toEqual([255, 0, 0]);
  });

  it("reads back a 3MF written by the exporter", async () => {
    const kit = KIT_PLA_PALETTE_CMYKW;
    const { bytes } = await exportBambu3mf([{ ...cube(), name: "c", extruder: 1 }], { kit, slots: kit.bases.map((b, i) => ({ slot: i + 1, kind: "base", hex: b.hex })) }, { printer: PRINTERS["bbl-h3c-0.4"], bundle: await fakeBundle() });
    const parts = await load3mf(bytes);
    expect(parts).toHaveLength(1);
    expect(parts[0].indices.length).toBe(36);
  });

  it("reads a minimal GLB with a base colour and node transform, converting Y-up to Z-up", () => {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, translation: [0, 5, 0] }],
      meshes: [{ name: "tri", primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    };
    let jsonBytes = enc.encode(JSON.stringify(json));
    const pad = (4 - (jsonBytes.length % 4)) % 4;
    jsonBytes = new Uint8Array([...jsonBytes, ...new Array(pad).fill(0x20)]);
    const total = 12 + 8 + jsonBytes.length + 8 + 36;
    const glb = new Uint8Array(total);
    const dv = new DataView(glb.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonBytes.length, true);
    dv.setUint32(16, 0x4e4f534a, true);
    glb.set(jsonBytes, 20);
    const o = 20 + jsonBytes.length;
    dv.setUint32(o, 36, true);
    dv.setUint32(o + 4, 0x004e4942, true);
    glb.set(new Uint8Array(pos.buffer), o + 8);
    const p = loadGlb(glb)[0];
    expect(p.name).toBe("tri");
    expect(Array.from(p.triColors!)).toEqual([255, 0, 0]);
    // node y=5 becomes z=5; vertex (0,1,0) becomes (0,0,6)
    expect(Array.from(p.positions.slice(6, 9))).toEqual([0, -0, 6]);
  });

  it("dispatches by extension and rejects unknown formats", async () => {
    await expect(loadModel("a.fbx", new Uint8Array())).rejects.toThrow(/Unsupported/);
  });
});
