import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@spec": fileURLToPath(new URL("../spec", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 5180, proxy: { "/api": "http://127.0.0.1:8765" }, fs: { allow: [".."] } },
  build: { outDir: "dist", sourcemap: false },
})
