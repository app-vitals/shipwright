// Re-exports for backward compatibility — shared toolbar now lives in @shipwright/lib.
export {
  baseStyles,
  renderShipwrightToolbar as renderToolbar,
} from "@shipwright/lib/web/toolbar.ts";
export type { ShipwrightToolbarOptions as ToolbarOptions } from "@shipwright/lib/web/toolbar.ts";
