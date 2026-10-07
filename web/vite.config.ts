import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: {
    port: 5173,
    proxy: {
      "/rpc": "http://127.0.0.1:7317",
      "/ws": { target: "ws://127.0.0.1:7317", ws: true }
    }
  }
});
