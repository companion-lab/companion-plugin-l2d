import { describe, expect, it } from "vitest";
import {
  chunkOffsets,
  rootSegment,
  stripRootSegment,
  UPLOAD_CHUNK_BYTES,
} from "./upload";

describe("stripRootSegment", () => {
  it("strips the picked folder prefix", () => {
    expect(stripRootSegment("MyModel/IceGirl.model3.json")).toBe("IceGirl.model3.json");
    expect(stripRootSegment("MyModel/textures/tex.png")).toBe("textures/tex.png");
  });

  it("keeps paths without a root segment", () => {
    expect(stripRootSegment("model.zip")).toBe("model.zip");
  });
});

describe("rootSegment", () => {
  it("returns the picked folder name", () => {
    expect(rootSegment("MyModel/IceGirl.model3.json")).toBe("MyModel");
    expect(rootSegment("model.zip")).toBe("model.zip");
  });
});

describe("chunkOffsets", () => {
  it("splits sizes into aligned chunks", () => {
    expect(chunkOffsets(0)).toEqual([]);
    expect(chunkOffsets(10, 4)).toEqual([
      { offset: 0, length: 4 },
      { offset: 4, length: 4 },
      { offset: 8, length: 2 },
    ]);
    expect(chunkOffsets(UPLOAD_CHUNK_BYTES)).toEqual([
      { offset: 0, length: UPLOAD_CHUNK_BYTES },
    ]);
    const twoAndABit = chunkOffsets(UPLOAD_CHUNK_BYTES * 2 + 5);
    expect(twoAndABit.length).toBe(3);
    expect(twoAndABit[2].length).toBe(5);
  });
});
