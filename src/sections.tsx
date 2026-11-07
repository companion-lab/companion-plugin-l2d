// Live2D settings sections (Settings → Live2D): status with the VRM
// coexistence notice, expression and motion galleries, and display
// transforms. Sections run in the settings window where the avatar bus is
// no-ops, so tests flow through plugin events to the main-window engine —
// the same responder pattern the vrm plugin's sections use.

import { useEffect, useState, type ChangeEvent } from "react";
import type { PluginContext } from "@companion-lab/plugin";
import { callWithRetry } from "./retry";
import { tauriInvoke } from "./vendor/tauri-events";
import { fetchActiveModelClips, type ModelClips } from "./library";
import { coerceDisplay, type DisplaySettings } from "./engine/display";

const DISPLAY_STORAGE_KEY = "display";

/** Engine state mirrored into the Status section via the l2d-status event. */
type EngineStatus =
  | { ok: true; id?: string; name?: string; empty?: boolean }
  | { ok: false; error: string }
  | null;

export function StatusSection({ ctx }: { ctx: PluginContext }) {
  const { SectionCard } = ctx.ui;
  const [backend, setBackend] = useState<"checking" | "ok" | string>("checking");
  const [status, setStatus] = useState<EngineStatus>(null);

  useEffect(() => {
    void (async () => {
      try {
        await callWithRetry(
          () => ctx.backend.call("companion-plugin-l2d.ping"),
          ctx.log,
          "companion-plugin-l2d.ping",
        );
        setBackend("ok");
      } catch (e) {
        setBackend(e instanceof Error ? e.message : String(e));
      }
    })();
    return ctx.events.on("l2d-status", (payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      if (p.ok === true) {
        setStatus({
          ok: true,
          id: typeof p.id === "string" ? p.id : undefined,
          name: typeof p.name === "string" ? p.name : undefined,
          empty: p.empty === true,
        });
      } else {
        setStatus({
          ok: false,
          error: String(p.error ?? "unknown error"),
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SectionCard title="Live2D Avatar" badge={backend === "ok" ? "backend ready" : "backend error"}>
      <p style={{ margin: "0 0 10px", opacity: 0.75 }}>
        Renders a Live2D model on the desktop overlay and answers the avatar
        bus (chat emotions, TTS lip sync, click-through). Model switching and
        imports live in the Models section below.
      </p>
      <div className="item-row">
        <div className="item-title">
          {status === null
            ? "Engine: waiting for the main window…"
            : status.ok
              ? status.empty
                ? "No model in the library — import one in Models below."
                : `Loaded: ${status.name || status.id}`
              : `Load failed: ${status.error}`}
        </div>
        {backend !== "ok" && (
          <div className="error-banner" style={{ marginTop: 8 }}>
            Backend unreachable: {backend}
          </div>
        )}
      </div>
      <VrmNotice ctx={ctx} />
    </SectionCard>
  );
}

/** The avatar bus is single-owner (last engine to install handlers wins), and
 *  both plugins mount a backdrop canvas — with vrm also enabled the two
 *  avatars render stacked and bus calls land on whichever activated last.
 *  Point it out instead of fighting silently. */
function VrmNotice({ ctx }: { ctx: PluginContext }) {
  const [vrmEnabled, setVrmEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void tauriInvoke<Array<{ id?: string; enabled?: boolean }>>("plugin_list")
      .then((list) => {
        if (!cancelled) {
          setVrmEnabled(
            Array.isArray(list) && list.some((p) => p?.id === "vrm" && p?.enabled === true),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setVrmEnabled(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (vrmEnabled !== true) return null;
  return (
    <div className="error-banner" style={{ marginTop: 10 }}>
      ⚠ VRM Avatar plugin is also enabled — both avatar engines would render
      stacked and share the avatar bus. Disable one in Settings → Plugins.
    </div>
  );
}

/** Shared gallery: clip buttons; the expression gallery also gets a neutral
 *  reset. Buttons emit plugin events the main-window engine answers. */
function ClipGallery({
  ctx,
  title,
  clips,
  kind,
}: {
  ctx: PluginContext;
  title: string;
  clips: ModelClips | null;
  kind: "expression" | "motion";
}) {
  const { SectionCard, Button } = ctx.ui;
  const list = clips ? (kind === "expression" ? clips.expressions : clips.motions) : [];
  return (
    <SectionCard title={title} badge={clips ? `${list.length} clips` : "…"}>
      {list.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {kind === "expression" && (
            <Button
              variant="ghost"
              onClick={() => ctx.events.emit("l2d-expression-test", "neutral")}
              style={{ padding: "5px 10px", fontSize: 11 }}
            >
              neutral
            </Button>
          )}
          {list.map((clip) => (
            <Button
              key={clip.file}
              variant="ghost"
              onClick={() => ctx.events.emit(
                kind === "expression" ? "l2d-expression-test" : "l2d-motion-test",
                clip.id,
              )}
              style={{ padding: "5px 10px", fontSize: 11 }}
            >
              {clip.native !== clip.id ? `${clip.id} (${clip.native})` : clip.id}
            </Button>
          ))}
        </div>
      ) : (
        <p style={{ margin: 0, opacity: 0.6 }}>
          {clips ? `No ${kind} files in the bundled model.` : "Loading model clips…"}
        </p>
      )}
    </SectionCard>
  );
}

export function ExpressionsSection({ ctx }: { ctx: PluginContext }) {
  const [clips, setClips] = useState<ModelClips | null>(null);
  useEffect(() => {
    void fetchActiveModelClips(ctx)
      .then(setClips)
      .catch((e) =>
        ctx.log.warn(`clip listing failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <ClipGallery ctx={ctx} title="Expressions" clips={clips} kind="expression" />;
}

export function MotionsSection({ ctx }: { ctx: PluginContext }) {
  const [clips, setClips] = useState<ModelClips | null>(null);
  useEffect(() => {
    void fetchActiveModelClips(ctx)
      .then(setClips)
      .catch((e) =>
        ctx.log.warn(`clip listing failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <ClipGallery ctx={ctx} title="Motions" clips={clips} kind="motion" />;
}

export function DisplaySection({ ctx }: { ctx: PluginContext }) {
  const { SectionCard, RangeSlider, FormField } = ctx.ui;
  const [display, setDisplay] = useState<DisplaySettings | null>(null);

  useEffect(() => {
    void ctx.storage
      .get<DisplaySettings>(DISPLAY_STORAGE_KEY)
      .then((stored) => setDisplay(coerceDisplay(stored)))
      .catch(() => setDisplay(coerceDisplay(null)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!display) {
    return (
      <SectionCard title="Display" badge="…">
        <p style={{ margin: 0, opacity: 0.6 }}>Loading…</p>
      </SectionCard>
    );
  }

  const update = (patch: Partial<DisplaySettings>) => {
    setDisplay((prev) => {
      const next = coerceDisplay({ ...(prev ?? {}), ...patch });
      void ctx.storage.set(DISPLAY_STORAGE_KEY, next).catch(() => undefined);
      ctx.events.emit("l2d-display-changed", next);
      return next;
    });
  };

  return (
    <SectionCard title="Display" badge="saved">
      <RangeSlider
        label="Scale"
        valueLabel={`${display.scale.toFixed(2)}×`}
        min={0.4}
        max={2.5}
        step={0.05}
        value={display.scale}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          update({ scale: parseFloat(e.target.value) })
        }
      />
      <RangeSlider
        label="Horizontal offset"
        valueLabel={`${Math.round(display.x)} px`}
        min={-160}
        max={160}
        step={2}
        value={display.x}
        onChange={(e: ChangeEvent<HTMLInputElement>) => update({ x: parseFloat(e.target.value) })}
      />
      <RangeSlider
        label="Vertical offset"
        valueLabel={`${Math.round(display.y)} px`}
        min={-220}
        max={160}
        step={2}
        value={display.y}
        onChange={(e: ChangeEvent<HTMLInputElement>) => update({ y: parseFloat(e.target.value) })}
      />
      <FormField label="Cursor tracking" hint="The character's head and eyes follow your cursor.">
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={display.tracking}
            onChange={(e) => update({ tracking: e.target.checked })}
            style={{ width: 16, height: 16, accentColor: "var(--accent, #7c6cf6)" }}
          />
          Follow the cursor
        </label>
      </FormField>
    </SectionCard>
  );
}
