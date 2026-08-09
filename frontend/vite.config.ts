import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // The admin talks to SYL's service, which is 8888 (`DEFAULT_PORT` in
    // backend/src/config.ts, overridden by SYL_PORT). Proxying in dev keeps the
    // browser same-origin, so there is no CORS configuration to get wrong and
    // the API base URL is the same string in dev and prod.
    //
    // **NOT 4201.** That is ADJUTANT's backend, and the comment here used to say
    // so — it named .mcp.json, which points at Adjutant because that is where
    // agents send messages, not where Syl serves its API. This is the same
    // two-backends confusion CLAUDE.md records as having already cost a real
    // failure, arriving a second time in a different file.
    //
    // It failed quietly, which is why it survived: 4201 is usually LISTENING,
    // so the proxy connected happily and Adjutant answered every /api call with
    // an Express HTML error page. The admin got `<!DOCTYPE html>` where it
    // expected Syl's JSON envelope — a parse error at the client, nowhere near
    // the misconfiguration. A wrong port that is closed costs a minute; a wrong
    // port that answers costs an afternoon.
    //
    // 127.0.0.1 rather than "localhost" on purpose: DEFAULT_HOST is 127.0.0.1,
    // and Node resolves "localhost" with Happy Eyeballs, so it can pick ::1 and
    // reach nothing.
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
