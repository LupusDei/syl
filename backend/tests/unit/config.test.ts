import { describe, expect, it } from "vitest";

import {
  ConfigError,
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
        credentialSource: "none",
        subscriptionRails: true,
        quietHours: DEFAULT_QUIET_HOURS,
      });
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

    it("should read HOST, PORT and NODE_ENV from the environment", () => {
      const config = loadConfig({ HOST: "0.0.0.0", PORT: "8080", NODE_ENV: "production" });

      expect(config.host).toBe("0.0.0.0");
      expect(config.port).toBe(8080);
      expect(config.nodeEnv).toBe("production");
    });

    it("should default the port to 4201, the port .mcp.json already points at", () => {
      expect(loadConfig({}).port).toBe(4201);
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
      expect(() => loadConfig({ PORT: "not-a-port" })).toThrow(ConfigError);
      expect(() => loadConfig({ PORT: "not-a-port" })).toThrow(/PORT/);
    });

    it("should reject a fractional PORT", () => {
      expect(() => loadConfig({ PORT: "8080.5" })).toThrow(ConfigError);
    });

    it("should reject a PORT outside 1-65535", () => {
      expect(() => loadConfig({ PORT: "0" })).toThrow(ConfigError);
      expect(() => loadConfig({ PORT: "-1" })).toThrow(ConfigError);
      expect(() => loadConfig({ PORT: "65536" })).toThrow(ConfigError);
    });

    it("should accept the boundary ports 1 and 65535", () => {
      expect(loadConfig({ PORT: "1" }).port).toBe(1);
      expect(loadConfig({ PORT: "65535" }).port).toBe(65535);
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
        loadConfig({ PORT: "nope", NODE_ENV: "staging", HOST: " " });
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
      const config = loadConfig({ PORT: "", HOST: "", NODE_ENV: "" });

      expect(config.port).toBe(DEFAULT_PORT);
      expect(config.host).toBe(DEFAULT_HOST);
      expect(config.nodeEnv).toBe("development");
    });

    it("should trim surrounding whitespace off values", () => {
      const config = loadConfig({ PORT: " 8080 ", HOST: " localhost ", NODE_ENV: " test " });

      expect(config.port).toBe(8080);
      expect(config.host).toBe("localhost");
      expect(config.nodeEnv).toBe("test");
    });

    it("should not treat a numeric-looking string with a suffix as a port", () => {
      expect(() => loadConfig({ PORT: "8080abc" })).toThrow(ConfigError);
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
    it("should fall back to 22:00–08:00 in the Commander's zone", () => {
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
      expect(loadConfig({ SYL_QUIET_START: "23:00" }).quietHours).toEqual({
        quiet: { start: "23:00", end: "08:00" },
        tz: "America/Chicago",
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
        loadConfig({ PORT: "nope", SYL_QUIET_START: "25:00", SYL_TZ: "-06:00" });
      } catch (error) {
        thrown = error;
      }

      expect((thrown as ConfigError).problems).toHaveLength(3);
    });
  });
});
