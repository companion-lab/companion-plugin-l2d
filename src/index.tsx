// Live2D avatar feature plugin: the main-window canvas runtime plus settings
// sections for the bundled model (status / expressions / motions / display).
//
// The plugin activates in BOTH windows. The canvas widget only exists in the
// main window's layout, so the engine starts (and stops) with its mount; the
// settings sections run in the settings window and drive the engine through
// plugin events. Everything else no-ops outside the main window.

import { useEffect, useRef, useState } from "react";
import { definePlugin, type PluginContext } from "@companion-lab/plugin";
import {
  onEngineError,
  startLive2DEngine,
  stopLive2DEngine,
} from "./engine/engine";
import {
  DisplaySection,
  ExpressionsSection,
  MotionsSection,
  StatusSection,
} from "./sections";
import { ModelsSection } from "./ModelsSection";

export default definePlugin((ctx: PluginContext) => {
  ctx.log.info("activating companion-plugin-l2d plugin");

  // ── Main-window runtime ──
  // The backdrop canvas is a non-interactive pixel layer behind the core
  // interaction canvas (vrm's AvatarCanvas pattern); click-through probes
  // read its alpha through the avatar bus.
  ctx.main.registerWidget({
    slot: "main.backdrop",
    component: function Live2DCanvas() {
      const canvasRef = useRef<HTMLCanvasElement>(null);
      useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        startLive2DEngine(ctx, canvas);
        return () => stopLive2DEngine();
      }, []);
      return (
        <canvas
          ref={canvasRef}
          style={{
            position: "fixed",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
          }}
        />
      );
    },
  });

  // Engine / model-load failures surface here.
  ctx.main.registerWidget({
    slot: "main.overlay",
    component: function Live2DEngineError() {
      const [message, setMessage] = useState<string | null>(null);
      useEffect(() => onEngineError(setMessage), []);
      const { ErrorOverlay } = ctx.ui;
      if (!message) return null;
      return <ErrorOverlay message={message} />;
    },
  });

  // ── Settings contributions ──
  ctx.settings.registerTab({
    id: "live2d",
    label: "Live2D",
    group: "Avatar",
    order: 25,
    desc: "Live2D avatar: model, expressions, motions, display.",
    icon: ({ className }: { className?: string }) => (
      <svg
        className={className}
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M8.5 10a0.5 0.5 0 1 0 0.001 0z" fill="currentColor" />
        <path d="M15.5 10a0.5 0.5 0 1 0 0.001 0z" fill="currentColor" />
        <path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-0.6 3.5-1.8" />
      </svg>
    ),
  });

  ctx.settings.registerSection({
    id: "live2d.status",
    tabId: "live2d",
    slot: "top",
    order: 100,
    component: function Live2dStatus() {
      return <StatusSection ctx={ctx} />;
    },
  });
  ctx.settings.registerSection({
    id: "live2d.models",
    tabId: "live2d",
    slot: "top",
    order: 100,
    component: function Live2dModels() {
      return <ModelsSection ctx={ctx} />;
    },
  });
  ctx.settings.registerSection({
    id: "live2d.expressions",
    tabId: "live2d",
    slot: "top",
    order: 100,
    component: function Live2dExpressions() {
      return <ExpressionsSection ctx={ctx} />;
    },
  });
  ctx.settings.registerSection({
    id: "live2d.motions",
    tabId: "live2d",
    slot: "top",
    order: 100,
    component: function Live2dMotions() {
      return <MotionsSection ctx={ctx} />;
    },
  });
  ctx.settings.registerSection({
    id: "live2d.display",
    tabId: "live2d",
    slot: "top",
    order: 100,
    component: function Live2dDisplay() {
      return <DisplaySection ctx={ctx} />;
    },
  });
});
