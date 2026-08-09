import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // The admin talks to the backend on 4201 (see .mcp.json). Proxying in dev
    // keeps the browser same-origin, so there is no CORS configuration to get
    // wrong and the API base URL is the same string in dev and prod.
    //
    // 4211, not 4210: `npm run mock` binds 4210 and the contract's own
    // `servers[]` entry names it, so a dev server there collides with the
    // thing this workspace is meant to be developed against.
    port: 4211,
    proxy: {
      "/api": {
        target: process.env["SYL_API_ORIGIN"] ?? "http://localhost:4201",
        changeOrigin: true,
      },
    },
  },
});
