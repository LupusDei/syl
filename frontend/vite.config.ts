import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Syl serves this bundle from her own origin at `/admin`, over the tailnet
  // certificate the phone already trusts — so the built asset URLs have to
  // carry that prefix. It must equal `ADMIN_BASE_PATH` in
  // `backend/src/routes/admin.ts`; `backend/tests/integration/admin-bundle.
  // test.ts` builds this for real and checks that it does.
  //
  // The dev server picks the prefix up too, so `npm run dev` serves the admin
  // at http://localhost:4211/admin/ and dev and production address it the same
  // way. `scripts/check-bundle.mjs` fails the build if the emitted page ever
  // stops referencing it.
  base: "/admin/",
  server: {
    // The admin talks to Syl on **8888** — `DEFAULT_PORT` in
    // `backend/src/config.ts`. It said 4201 here, which is *Adjutant's*
    // backend and is running on this machine: the exact misreading of
    // `.mcp.json` that `docs/CONTEXT.md` §7 records, so the dev proxy was
    // pointed at the neighbour and every request 404'd against a service that
    // has never served `/api/v1`.
    //
    // Proxying in dev keeps the browser same-origin, so there is no CORS
    // configuration to get wrong and the API base URL is the same string in
    // dev and prod.
    //
    // 4211, not 4210: `npm run mock` binds 4210 and the contract's own
    // `servers[]` entry names it, so a dev server there collides with the
    // thing this workspace is meant to be developed against.
    port: 4211,
    proxy: {
      "/api": {
        target: process.env["SYL_API_ORIGIN"] ?? "http://127.0.0.1:8888",
        changeOrigin: true,
      },
    },
  },
});
