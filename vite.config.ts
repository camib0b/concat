import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";

/**
 * The Worker is routed at /concat and /concat/*, and static assets are matched
 * on the full path. Emit the shell and hashed files under dist/concat/ so
 * /concat/assets/* resolves. SPA fallback reads dist/index.html, the same
 * shell, whose script URLs still point at /concat/.
 */
function copySpaShellToAssetRoot(): Plugin {
  return {
    name: "copy-spa-shell-to-asset-root",
    apply: "build",
    closeBundle() {
      const shellPath = path.resolve(__dirname, "dist/concat/index.html");
      const fallbackPath = path.resolve(__dirname, "dist/index.html");
      mkdirSync(path.dirname(fallbackPath), { recursive: true });
      copyFileSync(shellPath, fallbackPath);
    },
  };
}

export default defineConfig({
  base: "/concat/",
  plugins: [react(), copySpaShellToAssetRoot()],
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util", "@ffmpeg/core"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist/concat",
    emptyOutDir: true,
  },
});
