import { defineConfig } from "vitest/config";

import { sharedTestConfig } from "../vitest.shared.js";

/** Focused runs: `npm test -w shared`. The root config runs every workspace. */
export default defineConfig(sharedTestConfig);
