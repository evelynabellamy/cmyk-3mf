import { describe, expect, it, vi } from "vitest";
import { cachedPresetSource, githubPresetSource, resolvePreset } from "../src/presets.js";
import { fakeSource } from "./helpers.js";

describe("resolvePreset", () => {
  it("applies base <- include <- own keys and strips meta keys", async () => {
    const m = await resolvePreset(fakeSource(), "machine", "Test Printer 0.4 nozzle");
    expect(m.machine_start_gcode).toBe(";===== machine: TEST start");
    expect(m.change_filament_gcode).toBe("GENERIC CHANGE");
    expect(m.printer_model).toBe("Test Printer");
    expect(m.name).toBe("Test Printer 0.4 nozzle");
    expect(m).not.toHaveProperty("inherits");
    expect(m).not.toHaveProperty("include");
    expect(m).not.toHaveProperty("instantiation");
  });

  it("caches reads", async () => {
    const log: string[] = [];
    const src = cachedPresetSource(fakeSource(log));
    await resolvePreset(src, "process", "0.20mm Test");
    await resolvePreset(src, "process", "0.20mm Test");
    expect(log).toEqual(["process/0.20mm Test", "process/base_process"]);
  });
});

describe("githubPresetSource", () => {
  it("uses the vendor index sub_path and encodes file names", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith("/BBL.json")) {
        return new Response(JSON.stringify({ machine_list: [{ name: "A B", sub_path: "machine/sub dir/A B.json" }] }));
      }
      return new Response(JSON.stringify({ name: "A B", value: 1 }));
    });
    const src = githubPresetSource({ tag: "v1.2.3", fetch: fetchMock as unknown as typeof fetch });
    expect(src.label).toBe("github:bambulab/BambuStudio@v1.2.3");
    const p = await src.read("machine", "A B");
    expect(p.value).toBe(1);
    expect(urls[0]).toBe("https://raw.githubusercontent.com/bambulab/BambuStudio/v1.2.3/resources/profiles/BBL.json");
    expect(urls[1]).toBe("https://raw.githubusercontent.com/bambulab/BambuStudio/v1.2.3/resources/profiles/BBL/machine/sub%20dir/A%20B.json");
  });

  it("reports HTTP failures", async () => {
    const src = githubPresetSource({ fetch: (async () => new Response("no", { status: 404 })) as unknown as typeof fetch });
    await expect(src.read("machine", "x")).rejects.toThrow(/HTTP 404/);
  });
});
