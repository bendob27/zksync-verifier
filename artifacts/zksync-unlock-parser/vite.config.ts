import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// The dashboard is served at the root by default. Override BASE_PATH when hosting
// it under a sub-path so asset URLs resolve correctly.
const basePath = process.env.BASE_PATH ?? "/";

// Vite dev server port, and the API server it proxies /api requests to.
// Deliberately not PORT: the API server uses that, and a shared .env would collide.
const port = Number(process.env.WEB_PORT ?? 5173);
const apiTarget = process.env.API_PROXY_TARGET ?? "http://localhost:8080";

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    // The app calls relative /api/* URLs, so in development they are proxied
    // to the API server rather than hitting the Vite dev server.
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
});
