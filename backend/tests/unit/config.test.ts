import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AUTO_MEMORY_ENV_VAR,
  DEFAULT_AUTO_MEMORY_PATH,
} from "../../src/memory/auto-memory.js";
import {
  ConfigError,
  DEFAULT_ADJUTANT_AGENT_ID,
  DEFAULT_ATTACHMENT_DIR,
  DEFAULT_DATABASE_PATH,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_QUIET_HOURS,
  SERVICE_VERSION,
  isIanaTimeZone,
  loadConfig,
  loadQuietHours,
  resolveCredentialSource,
} from "../../src/config.js";
import { DEFAULT_ADMIN_DIR } from "../../src/ops/admin-bundle.js";
import { ReminderService } from "../../src/services/reminder-service.js";
import { testDatabase } from "../helpers/service.js";

/**
 * `loadConfig` is deliberately a pure function of an environment object rather
 * than a reader of `process.env`, so every one of these cases is a plain call
 * with no global mutation and no cleanup to forget.
 */
describe("resolveCredentialSource", () => {
  it("should report 'none' when no credential variable is set", () => {
    expect(resolveCredentialSource({})).toBe("none");
  });

  it("should name ANTHROPIC_API_KEY when it is set", () => {
    expect(resolveCredentialSource({ ANTHROPIC_API_KEY: "sk-ant-whatever" })).toBe(
      "ANTHROPIC_API_KEY",
    );
  });

  it("should name ANTHROPIC_AUTH_TOKEN when it is the only one set", () => {
    expect(resolveCredentialSource({ ANTHROPIC_AUTH_TOKEN: "tok" })).toBe(
      "ANTHROPIC_AUTH_TOKEN",
    );
  });

  it("should prefer ANTHROPIC_API_KEY when both are set", () => {
    expect(
      resolveCredentialSource({ ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t" }),
    ).toBe("ANTHROPIC_API_KEY");
  });

  it("should treat an empty value as unset", () => {
    expect(resolveCredentialSource({ ANTHROPIC_API_KEY: "" })).toBe("none");
    expect(resolveCredentialSource({ ANTHROPIC_API_KEY: "   " })).toBe("none");
  });
});

describe("loadConfig", () => {
  describe("happy path", () => {
    it("should fall back to defaults when the environment is empty", () => {
      const config = loadConfig({});

      expect(config).toEqual({
        host: DEFAULT_HOST,
        port: DEFAULT_PORT,
        nodeEnv: "development",
        version: SERVICE_VERSION,
        databasePath: DEFAULT_DATABASE_PATH,
        // Absolute, because Claude Code discards a relative auto-memory
        // directory without saying so.
        autoMemoryDirectory: resolve(process.cwd(), DEFAULT_AUTO_MEMORY_PATH),
        credentialSource: "none",
        subscriptionRails: true,
        quietHours: DEFAULT_QUIET_HOURS,
        pushEnvironment: null,
        allowSandboxPush: false,
        // No HOME in the supplied environment, so both fall back to the
        // repository's own dot-directory rather than to somebody's real
        // `~/Library/Logs`.
        logDirectory: ".syl/logs",
        certStatusPath: ".syl/cert-status.json",
        // Absolute, and derived from this file's own location rather than from
        // the environment: the admin bundle is a build artefact of this
        // checkout, not a deployment setting.
        adminDir: DEFAULT_ADMIN_DIR,
        attachmentDir: DEFAULT_ATTACHMENT_DIR,
        // Off. She is the Commander's assistant first and a fleet client
        // second, so an empty environment is a machine that boots without ever
        // looking for Adjutant.
        adjutant: null,
      });
    });

    it("should read the admin bundle directory from SYL_ADMIN_DIR", () => {
      expect(loadConfig({ SYL_ADMIN_DIR: "/srv/syl/admin" }).adminDir).toBe("/srv/syl/admin");
    });

    it("should read the database path from SYL_DB_PATH", () => {
      expect(loadConfig({ SYL_DB_PATH: "/var/lib/syl/syl.db" }).databasePath).toBe(
        "/var/lib/syl/syl.db",
      );
    });

    it("should keep the store under .syl/ by default, which is already gitignored", () => {
      // The Commander's to-dos must not be one `git add .` away from a commit.
      expect(loadConfig({}).databasePath.startsWith(".syl/")).toBe(true);
    });

    it("should treat a blank SYL_DB_PATH as unset rather than as the empty path", () => {
      expect(loadConfig({ SYL_DB_PATH: "   " }).databasePath).toBe(DEFAULT_DATABASE_PATH);
    });

    it("should read the auto-memory directory from SYL_AUTO_MEMORY_DIR", () => {
      expect(loadConfig({ [AUTO_MEMORY_ENV_VAR]: "/var/lib/syl/memory" }).autoMemoryDirectory).toBe(
        "/var/lib/syl/memory",
      );
    });

    it("should make a relative auto-memory directory absolute, never passing it on as given", () => {
      // Verified on Claude Code 2.1.226: a relative `autoMemoryDirectory` is
      // discarded in silence and memory goes to the CLI's own default instead.
      // Nothing warns, nothing exits non-zero, and the next session reads from
      // the same wrong place — so it even looks like it worked.
      const config = loadConfig({ [AUTO_MEMORY_ENV_VAR]: "var/memory" });

      expect(config.autoMemoryDirectory).toBe(resolve(process.cwd(), "var/memory"));
    });

    it("should keep memory under .syl/ by default, which is already gitignored", () => {
      // Same reasoning as the database: the Commander's private memory must not
      // be one `git add .` from a commit.
      expect(loadConfig({}).autoMemoryDirectory.endsWith("/.syl/memory")).toBe(true);
    });

    it("should refuse to start on an auto-memory directory the CLI would discard", () => {
      // A misconfigured service must refuse to start rather than quietly write
      // the Commander's memory somewhere Syl never reads.
      expect(() => loadConfig({ [AUTO_MEMORY_ENV_VAR]: "/srv/syl\0/memory" })).toThrow(ConfigError);
    });

    it("should report an unusable memory directory together with every other problem", () => {
      // One throw listing everything, so misconfiguration is not fixed one
      // restart at a time.
      try {
        loadConfig({ [AUTO_MEMORY_ENV_VAR]: "\0", SYL_QUIET_START: "nope" });
        expect.unreachable("expected a ConfigError");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        const { problems } = error as ConfigError;
        expect(problems.some((p) => p.includes(AUTO_MEMORY_ENV_VAR))).toBe(true);
        expect(problems.some((p) => p.includes("SYL_QUIET_START"))).toBe(true);
      }
    });

    it("should read HOST, PORT and NODE_ENV from the environment", () => {
      const config = loadConfig({ HOST: "0.0.0.0", SYL_PORT: "8080", NODE_ENV: "production" });

      expect(config.host).toBe("0.0.0.0");
      expect(config.port).toBe(8080);
      expect(config.nodeEnv).toBe("production");
    });

    it("should default the port to 8888, which is Syl's own and not Adjutant's", () => {
      // This asserted 4201 and named `.mcp.json` as the reason. Both were
      // wrong: that file configures the ADJUTANT MCP server Syl's agents talk
      // to, and Adjutant's backend holds 4201 on this machine. Installed as a
      // LaunchAgent, Syl would have failed to bind on every boot forever.
      //
      // The test name carried the misconception, which is why it survived — it read
      // as a documented decision rather than a mistake. Asserting the number
      // alone would have been safer than asserting a wrong reason for it.
      expect(loadConfig({}).port).toBe(8888);
      expect(loadConfig({}).port).not.toBe(4201);
    });

    it("should bind loopback by default rather than every interface", () => {
      expect(loadConfig({}).host).toBe("127.0.0.1");
    });

    it("should report a real semver version taken from the package manifest", () => {
      expect(loadConfig({}).version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe("credential source", () => {
    it("should report subscription rails when no key variable is present", () => {
      const config = loadConfig({});

      expect(config.credentialSource).toBe("none");
      expect(config.subscriptionRails).toBe(true);
    });

    it("should clear subscriptionRails when a metered key is in the environment", () => {
      const config = loadConfig({ ANTHROPIC_API_KEY: "sk-ant-oops" });

      expect(config.credentialSource).toBe("ANTHROPIC_API_KEY");
      expect(config.subscriptionRails).toBe(false);
    });

    it("should never leak the credential value itself", () => {
      const secret = "sk-ant-super-secret-value";
      const config = loadConfig({ ANTHROPIC_API_KEY: secret });

      expect(JSON.stringify(config)).not.toContain(secret);
    });
  });

  describe("error path", () => {
    it("should reject a PORT that is not a number", () => {
      expect(() => loadConfig({ SYL_PORT: "not-a-port" })).toThrow(ConfigError);
      expect(() => loadConfig({ SYL_PORT: "not-a-port" })).toThrow(/PORT/);
    });

    it("should reject a fractional PORT", () => {
      expect(() => loadConfig({ SYL_PORT: "8080.5" })).toThrow(ConfigError);
    });

    it("should reject a PORT outside 1-65535", () => {
      expect(() => loadConfig({ SYL_PORT: "0" })).toThrow(ConfigError);
      expect(() => loadConfig({ SYL_PORT: "-1" })).toThrow(ConfigError);
      expect(() => loadConfig({ SYL_PORT: "65536" })).toThrow(ConfigError);
    });

    it("should accept the boundary ports 1 and 65535", () => {
      expect(loadConfig({ SYL_PORT: "1" }).port).toBe(1);
      expect(loadConfig({ SYL_PORT: "65535" }).port).toBe(65535);
    });

    it("should reject a NODE_ENV outside the known set", () => {
      expect(() => loadConfig({ NODE_ENV: "staging" })).toThrow(ConfigError);
      expect(() => loadConfig({ NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
    });

    it("should reject a HOST that is only whitespace", () => {
      expect(() => loadConfig({ HOST: "   " })).toThrow(ConfigError);
      expect(() => loadConfig({ HOST: "   " })).toThrow(/HOST/);
    });

    it("should report every problem at once rather than one per run", () => {
      let thrown: unknown;
      try {
        loadConfig({ SYL_PORT: "nope", NODE_ENV: "staging", HOST: " " });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ConfigError);
      const problems = (thrown as ConfigError).problems;
      expect(problems).toHaveLength(3);
      expect(problems.join("\n")).toMatch(/PORT/);
      expect(problems.join("\n")).toMatch(/NODE_ENV/);
      expect(problems.join("\n")).toMatch(/HOST/);
    });
  });

  describe("edge cases", () => {
    it("should treat an empty string as unset, not as an invalid value", () => {
      const config = loadConfig({ SYL_PORT: "", HOST: "", NODE_ENV: "" });

      expect(config.port).toBe(DEFAULT_PORT);
      expect(config.host).toBe(DEFAULT_HOST);
      expect(config.nodeEnv).toBe("development");
    });

    it("should trim surrounding whitespace off values", () => {
      const config = loadConfig({ SYL_PORT: " 8080 ", HOST: " localhost ", NODE_ENV: " test " });

      expect(config.port).toBe(8080);
      expect(config.host).toBe("localhost");
      expect(config.nodeEnv).toBe("test");
    });

    it("should not treat a numeric-looking string with a suffix as a port", () => {
      expect(() => loadConfig({ SYL_PORT: "8080abc" })).toThrow(ConfigError);
    });

    it("should ignore unrelated environment variables", () => {
      const config = loadConfig({ PATH: "/usr/bin", TZ: "America/Chicago", SHELL: "/bin/zsh" });

      expect(config.port).toBe(DEFAULT_PORT);
      expect(config.nodeEnv).toBe("development");
    });
  });
});

/**
 * `syl-085` — the quiet window is configuration, and configuration is checked
 * at boot.
 *
 * The failure this closes is not "a bad value is accepted". It is that a bad
 * value was accepted here and first parsed inside the reminder-delivery
 * handler, where a throw is recorded as a job failure and five of those open a
 * circuit breaker nothing closes. A misconfigured service must refuse to start
 * rather than start happily and die silently, hours later, in the dark.
 */
describe("quiet hours", () => {
  describe("isIanaTimeZone", () => {
    it("should accept a zone that names a place", () => {
      expect(isIanaTimeZone("America/Chicago")).toBe(true);
      expect(isIanaTimeZone("Europe/London")).toBe(true);
      expect(isIanaTimeZone("UTC")).toBe(true);
    });

    it("should refuse a bare UTC offset, however well-formed", () => {
      // Constraint 5. An offset is a property of an instant, not of a place —
      // and `Intl` accepts several of these, which is exactly why the `Intl`
      // check alone is not the whole rule.
      expect(isIanaTimeZone("-06:00")).toBe(false);
      expect(isIanaTimeZone("+05:30")).toBe(false);
    });

    it("should refuse a zone no runtime knows", () => {
      expect(isIanaTimeZone("Mars/Olympus")).toBe(false);
      expect(isIanaTimeZone("")).toBe(false);
    });

    it("should agree with ReminderService about every string it is given", () => {
      // The defect was one rule in two places: `assertTimezone` refused
      // "-06:00" for a reminder while `SYL_TZ` took it without a word. The
      // same value must not be valid in one half of the service and invalid in
      // the other, so this asserts the two agree rather than asserting each
      // separately and hoping.
      const db = testDatabase();
      try {
        const reminders = new ReminderService({ db: db.handle });

        for (const tz of ["America/Chicago", "UTC", "-06:00", "+05:30", "Mars/Olympus"]) {
          let reminderAccepts = true;
          try {
            reminders.create({ text: "Probe.", wallTime: "09:00", tz, date: "2099-01-01" });
          } catch {
            reminderAccepts = false;
          }
          expect([tz, isIanaTimeZone(tz)]).toEqual([tz, reminderAccepts]);
        }
      } finally {
        db.close();
      }
    });
  });

  describe("loadQuietHours", () => {
    it("should fall back to 23:00–07:00 in the Commander's zone", () => {
      // His machine sets neither variable, so this fallback IS the window the
      // service runs on. The value itself is asserted in `quiet-window.test.ts`.
      expect(loadQuietHours({})).toEqual(DEFAULT_QUIET_HOURS);
    });

    it("should read a well-formed window from the environment", () => {
      expect(
        loadQuietHours({
          SYL_QUIET_START: "21:30",
          SYL_QUIET_END: "06:15",
          SYL_TZ: "Europe/London",
        }),
      ).toEqual({ quiet: { start: "21:30", end: "06:15" }, tz: "Europe/London" });
    });

    it("should refuse a wall time that is not 24-hour HH:MM", () => {
      expect(() => loadQuietHours({ SYL_QUIET_START: "25:00" })).toThrow(ConfigError);
      expect(() => loadQuietHours({ SYL_QUIET_START: "9:00" })).toThrow(ConfigError);
      expect(() => loadQuietHours({ SYL_QUIET_END: "22:60" })).toThrow(ConfigError);
      expect(() => loadQuietHours({ SYL_QUIET_END: "10pm" })).toThrow(ConfigError);
    });

    it("should refuse a timezone that is not an IANA zone", () => {
      expect(() => loadQuietHours({ SYL_TZ: "-06:00" })).toThrow(ConfigError);
    });

    it("should treat a blank variable as unset rather than as a bad value", () => {
      expect(loadQuietHours({ SYL_QUIET_START: "  ", SYL_TZ: "" })).toEqual(DEFAULT_QUIET_HOURS);
    });
  });

  describe("loadConfig", () => {
    it("should carry the validated window onto the config", () => {
      // One end overridden and the other left alone, so this asserts both that
      // the override lands and that the default fills the gap. The start is
      // deliberately not the default's, or an override that did nothing would
      // pass.
      expect(loadConfig({ SYL_QUIET_START: "21:30" }).quietHours).toEqual({
        quiet: { start: "21:30", end: DEFAULT_QUIET_HOURS.quiet.end },
        tz: DEFAULT_QUIET_HOURS.tz,
      });
    });

    it("should refuse to start on a malformed window, naming the variable", () => {
      let thrown: unknown;
      try {
        loadConfig({ SYL_QUIET_START: "25:00" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ConfigError);
      // The operator reading this is looking at an environment, not at a
      // source file, so the message has to name the variable.
      expect((thrown as ConfigError).problems.join("\n")).toMatch(/SYL_QUIET_START/u);
    });

    it("should report a bad port and a bad window in one throw", () => {
      let thrown: unknown;
      try {
        loadConfig({ SYL_PORT: "nope", SYL_QUIET_START: "25:00", SYL_TZ: "-06:00" });
      } catch (error) {
        thrown = error;
      }

      expect((thrown as ConfigError).problems).toHaveLength(3);
    });
  });
});

/**
 * Whether she may reach the rest of the fleet at all.
 *
 * Two states matter and they are not "on" and "broken". **Absent is off**, and
 * off must be silent — a machine without Adjutant is not misconfigured, and she
 * is the Commander's assistant first and a fleet client second. **Present and
 * unusable refuses the start**, which is this module's contract for every other
 * setting and matters more here: `SYL_ADJUTANT_AGENT_ID=user` is a
 * configuration that would have her speak to the treasurer in his voice.
 */
describe("reaching the fleet", () => {
  it("should be off when nothing says otherwise", () => {
    expect(loadConfig({}).adjutant).toBeNull();
  });

  it("should stay off without complaining when only the identity is set", () => {
    // Half a configuration is not a broken one. Nobody has asked for the fleet.
    expect(loadConfig({ SYL_ADJUTANT_AGENT_ID: "syl" }).adjutant).toBeNull();
  });

  it("should call her syl when the URL is set and nobody says who she is", () => {
    const config = loadConfig({ SYL_ADJUTANT_URL: "http://127.0.0.1:4201" });

    expect(config.adjutant).toEqual({
      baseUrl: "http://127.0.0.1:4201",
      agentId: DEFAULT_ADJUTANT_AGENT_ID,
      projectRoot: undefined,
    });
  });

  it("should carry the project root Adjutant scopes an agent by", () => {
    const config = loadConfig({
      SYL_ADJUTANT_URL: "http://127.0.0.1:4201",
      SYL_ADJUTANT_PROJECT_ROOT: "/Users/Reason/code/ai/syl",
    });

    expect(config.adjutant?.projectRoot).toBe("/Users/Reason/code/ai/syl");
  });

  it("should refuse to start as the Commander rather than quietly turning off", () => {
    // The whole epic is shaped around this identity. Degrading it to "off"
    // would hide the one mistake most worth shouting about.
    expect(() =>
      loadConfig({ SYL_ADJUTANT_URL: "http://127.0.0.1:4201", SYL_ADJUTANT_AGENT_ID: "User" }),
    ).toThrow(/SYL_ADJUTANT_AGENT_ID/u);
  });

  it("should refuse an Adjutant that is not on this machine", () => {
    // What she asks the treasurer is a question about the Commander's money.
    expect(() => loadConfig({ SYL_ADJUTANT_URL: "https://adjutant.example.com" })).toThrow(
      /loopback/iu,
    );
  });

  it("should refuse a URL that is not a URL", () => {
    expect(() => loadConfig({ SYL_ADJUTANT_URL: "127.0.0.1:4201" })).toThrow(/SYL_ADJUTANT_URL/u);
  });

  it("should report a bad fleet setting alongside every other problem", () => {
    let thrown: unknown;
    try {
      loadConfig({ SYL_PORT: "nope", SYL_ADJUTANT_URL: "https://elsewhere.example.com" });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as ConfigError).problems).toHaveLength(2);
  });
});
