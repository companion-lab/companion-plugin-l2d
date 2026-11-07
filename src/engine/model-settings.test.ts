import { describe, expect, it } from "vitest";
import {
  buildModelSettings,
  neutralExpressionFile,
  NEUTRAL_EXP3_JSON,
} from "./model-settings";
import { collectExpressions, collectMotions } from "./names";

const RAW = {
  Version: 3,
  FileReferences: {
    Moc: "IceGirl.moc3",
    Textures: ["IceGirl.8192/texture_00.png", "IceGirl.8192/texture_01.png"],
    Physics: "IceGirl.physics3.json",
    DisplayInfo: "IceGirl.cdi3.json",
  },
  Groups: [
    { Target: "Parameter", Name: "LipSync", Ids: [] },
    { Target: "Parameter", Name: "EyeBlink", Ids: [] },
  ],
};

const FILES = [
  "IceGirl.8192/texture_00.png",
  "IceGirl.8192/texture_01.png",
  "IceGirl.cdi3.json",
  "IceGirl.model3.json",
  "IceGirl.moc3",
  "IceGirl.physics3.json",
  "生气.exp3.json",
  "DaiJi.motion3.json",
  "HuiShou.motion3.json",
];

// Stand-in for the loader's rel → blob URL map: absolute URLs resolve to
// themselves, which is exactly the property the factory's url.resolve needs.
const resolvePath = (rel: string) => `blob:mock/${encodeURIComponent(rel)}`;

const settings = () =>
  buildModelSettings(
    structuredClone(RAW),
    "IceGirl.model3.json",
    FILES,
    collectExpressions(FILES),
    collectMotions(FILES),
    resolvePath,
  );

describe("buildModelSettings", () => {
  it("rewrites every FileReferences path through resolvePath", () => {
    const s = settings();
    expect(s.url).toBe(resolvePath("IceGirl.model3.json"));
    expect(s.FileReferences.Moc).toBe(resolvePath("IceGirl.moc3"));
    expect(s.FileReferences.Textures).toEqual([
      resolvePath("IceGirl.8192/texture_00.png"),
      resolvePath("IceGirl.8192/texture_01.png"),
    ]);
    expect(s.FileReferences.Physics).toBe(resolvePath("IceGirl.physics3.json"));
    expect(s.FileReferences.DisplayInfo).toBe(resolvePath("IceGirl.cdi3.json"));
  });

  it("gives every motion its own group keyed by stable id", () => {
    const motions = settings().FileReferences.Motions!;
    expect(Object.keys(motions)).toContain("idle");
    expect(motions.idle[0].File).toBe(resolvePath("DaiJi.motion3.json"));
    expect(motions.idle[0].FadeInTime).toBeGreaterThan(0);
  });

  it("adds the autoplay Idle group from the aliased idle motion", () => {
    const motions = settings().FileReferences.Motions!;
    expect(motions.Idle).toEqual(motions.idle);
  });

  it("registers expressions with synthesized neutral first", () => {
    const exprs = settings().FileReferences.Expressions!;
    expect(exprs[0].Name).toBe("neutral");
    expect(exprs[0].File).toBe(resolvePath(neutralExpressionFile()));
    expect(exprs.find((e) => e.Name === "angry")?.File).toBe(resolvePath("生气.exp3.json"));
  });

  it("fills empty EyeBlink/LipSync groups with the standard params", () => {
    const groups = settings().Groups!;
    expect(groups.find((g) => g.Name === "EyeBlink")!.Ids).toEqual([
      "ParamEyeLOpen",
      "ParamEyeROpen",
    ]);
    expect(groups.find((g) => g.Name === "LipSync")!.Ids).toEqual(["ParamMouthOpenY"]);
  });

  it("keeps non-empty groups the model declares", () => {
    const raw = structuredClone(RAW);
    (raw.Groups![0] as { Ids: string[] }).Ids = ["ParamCustom"];
    const s = buildModelSettings(raw, "IceGirl.model3.json", FILES, [], [], resolvePath);
    expect(s.Groups!.find((g) => g.Name === "LipSync")!.Ids).toEqual(["ParamCustom"]);
  });

  it("falls back to the first motion when no idle alias exists", () => {
    const files = FILES.filter((f) => !f.startsWith("DaiJi"));
    const s = buildModelSettings(
      structuredClone(RAW),
      "IceGirl.model3.json",
      files,
      [],
      collectMotions(files),
      resolvePath,
    );
    expect(s.FileReferences.Motions!.Idle[0].File).toBe(resolvePath("HuiShou.motion3.json"));
  });

  it("rejects bundles without moc or textures", () => {
    const bad = { FileReferences: { Moc: "x.moc3", Textures: [] } };
    expect(() =>
      buildModelSettings(bad, "x.model3.json", FILES, [], [], resolvePath),
    ).toThrow(/Textures/);
    expect(() =>
      buildModelSettings({}, "x.model3.json", FILES, [], [], resolvePath),
    ).toThrow(/FileReferences/);
  });

  it("rejects clips whose file is missing from the bundle", () => {
    expect(() =>
      buildModelSettings(
        structuredClone(RAW),
        "IceGirl.model3.json",
        FILES.filter((f) => f !== "DaiJi.motion3.json"),
        [],
        collectMotions(FILES),
        resolvePath,
      ),
    ).toThrow(/missing from bundle/);
  });
});

describe("NEUTRAL_EXP3_JSON", () => {
  it("is a no-op expression (no parameters)", () => {
    expect(NEUTRAL_EXP3_JSON.Parameters).toEqual([]);
    expect(NEUTRAL_EXP3_JSON.Type).toBe("Live2D Expression");
  });
});
