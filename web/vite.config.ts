import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@spec": new URL("../spec", import.meta.url).pathname } },
  server: { host: "127.0.0.1", port: 5180, proxy: { "/api": "http://127.0.0.1:8765" }, fs: { allow: [".."] } },
  build: { outDir: "dist", sourcemap: false },
})
