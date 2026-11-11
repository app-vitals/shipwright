// Re-exports for backward compatibility — shared toolbar now lives in @app-vitals/agent-lib.

export type { ShipwrightToolbarOptions as ToolbarOptions } from "@app-vitals/agent-lib/web/toolbar.ts";
export {
  baseStyles,
  renderShipwrightToolbar as renderToolbar,
} from "@app-vitals/agent-lib/web/toolbar.ts";
