import { describe, expect, it } from "vitest";
import { crc32, readZip, writeZip } from "../src/zip.js";

describe("zip", () => {
  it("computes the standard CRC-32 check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it.each([true, false])("round-trips entries (compress=%s)", async (compress) => {
    const big = "lorem ipsum ".repeat(5000);
    const bytes = await writeZip(
      [
        { name: "a.txt", data: "hello" },
        { name: "dir/big.txt", data: big },
        { name: "bin", data: new Uint8Array([0, 1, 2, 255]) },
      ],
      { compress },
    );
    const zip = readZip(bytes);
    expect(zip.names).toEqual(["a.txt", "dir/big.txt", "bin"]);
    expect(await zip.readText("a.txt")).toBe("hello");
    expect(await zip.readText("dir/big.txt")).toBe(big);
    expect([...(await zip.read("bin"))]).toEqual([0, 1, 2, 255]);
    if (compress) expect(bytes.length).toBeLessThan(big.length / 10);
  });

  it("rejects non-zip data", () => {
    expect(() => readZip(new Uint8Array(100))).toThrow(/Not a ZIP/);
  });
});
