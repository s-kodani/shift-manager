import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Compile the public reset page's CSS without a runtime bundle or extra public paths.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [tailwindcss()],
  build: {
    outDir: "../../dist/app/assets",
    emptyOutDir: false,
    rolldownOptions: {
      input: fileURLToPath(new URL("reset.css", import.meta.url)),
      output: { assetFileNames: "reset.css" },
    },
  },
});
