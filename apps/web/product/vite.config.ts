import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/app-assets/",
  build: { outDir: "../../../dist/app", emptyOutDir: true, sourcemap: false },
});
