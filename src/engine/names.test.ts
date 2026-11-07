import { describe, expect, it } from "vitest";
import {
  collectExpressions,
  collectMotions,
  resolveNamed,
  slugify,
} from "./names";

const FILES = [
  "IceGirl.8192/texture_00.png",
  "IceGirl.moc3",
  "IceGirl.model3.json",
  "脸红.exp3.json",
  "生气.exp3.json",
  "星星眼.exp3.json",
  "←歪嘴.exp3.json",
  "DaiJi.motion3.json",
  "HuiShou.motion3.json",
  "Read me.txt",
  "模型说明.url",
];

describe("slugify", () => {
  it("slugs ascii stems", () => {
    expect(slugify("Star Eyes")).toBe("star-eyes");
    expect(slugify("  wink!! ")).toBe("wink");
  });

  it("returns empty for cjk-only stems (alias table covers those)", () => {
    expect(slugify("生气")).toBe("");
  });
});

describe("collectExpressions", () => {
  const exprs = collectExpressions(FILES);

  it("keeps only exp3 files, sorted by path", () => {
    expect(exprs.map((e) => e.file)).toEqual([
      "←歪嘴.exp3.json",
      "星星眼.exp3.json",
      "生气.exp3.json",
      "脸红.exp3.json",
    ]);
  });

  it("maps aliased Chinese names to stable ids", () => {
    expect(exprs.map((e) => e.id)).toEqual(["mouth-left", "star-eyes", "angry", "blush"]);
  });

  it("preserves the native stem", () => {
    expect(exprs.find((e) => e.id === "angry")?.native).toBe("生气");
  });
});

describe("collectMotions", () => {
  it("aliases the VTube Studio idle and gesture motions", () => {
    const motions = collectMotions(FILES);
    expect(motions.map((m) => [m.id, m.native])).toEqual([
      ["idle", "DaiJi"],
      ["wave", "HuiShou"],
    ]);
  });
});

describe("resolveNamed", () => {
  const exprs = collectExpressions(FILES);
  const motions = collectMotions(FILES);

  it("resolves stable ids, native names, and chat aliases", () => {
    expect(resolveNamed("angry", exprs)?.file).toBe("生气.exp3.json");
    expect(resolveNamed("生气", exprs)?.id).toBe("angry");
    expect(resolveNamed("happy", exprs)?.id).toBe("blush");
  });

  it("resolves motion aliases like nod → wave", () => {
    expect(resolveNamed("nod", motions)?.id).toBe("wave");
    expect(resolveNamed("DaiJi", motions)?.id).toBe("idle");
  });

  it("matches case-insensitively and by substring", () => {
    expect(resolveNamed("STAR-EYES", exprs)?.id).toBe("star-eyes");
    expect(resolveNamed("star", exprs)?.id).toBe("star-eyes");
  });

  it("returns null for unknown or empty input", () => {
    expect(resolveNamed("shake", motions)).toBeNull();
    expect(resolveNamed("", exprs)).toBeNull();
    expect(resolveNamed("angry", [])).toBeNull();
  });
});
