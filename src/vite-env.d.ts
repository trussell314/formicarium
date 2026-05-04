/// <reference types="vite/client" />

declare module '*?worker' {
  const Worker: { new (options?: WorkerOptions): Worker };
  export default Worker;
}

// Build-time identifiers injected by vite.config.ts `define`. The
// HUD shows them so a running tab can be distinguished from a fresh
// deploy (refresh the tab to load the latest build; the rev string
// updates at the next page load).
declare const __BUILD_REV__: string;
declare const __BUILD_TIME__: string;
