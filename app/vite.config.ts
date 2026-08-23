import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev-mode only: proxy the WS to a locally running bridge so the app can
    // be developed without being served BY the bridge. In production the
    // bridge serves app/dist same-origin and no proxy exists.
    proxy: {
      "/ws": {
        target: "ws://localhost:8484",
        ws: true,
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
