import { describe, expect, it } from "vitest";

import {
  ConfigError,
  DEFAULT_HOST,
  DEFAULT_PORT,
  SERVICE_VERSION,
  loadConfig,
  resolveCredentialSource,
} from "../../src/config.js";

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
        credentialSource: "none",
        subscriptionRails: true,
      });
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
