import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // The admin talks to the backend on 4201 (see .mcp.json). Proxying in dev
    // keeps the browser same-origin, so there is no CORS configuration to get
    // wrong and the API base URL is the same string in dev and prod.
    port: 4210,
    proxy: {
      "/api": {
        target: process.env["SYL_API_ORIGIN"] ?? "http://localhost:4201",
        changeOrigin: true,
      },
    },
  },
});
