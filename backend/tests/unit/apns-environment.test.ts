import { describe, expect, it } from "vitest";

import {
  ALLOW_SANDBOX_VAR,
  assertPushEnvironment,
  assessPushEnvironment,
  describePushEnvironment,
  isPushEnvironment,
  PushEnvironmentError,
  pushEnvironmentProbe,
  PUSH_ENVIRONMENT_VAR,
  type PushEnvironmentInput,
} from "../../src/ops/apns-environment.js";

/**
 * The APNs environment assertion.
 *
 * The failure this prevents has one symptom and no others: `BadDeviceToken` on
 * every send, which is correctly classified as a dead token, so the device is
 * unregistered and every subsequent reminder is lost too. One wrong build
 * channel silently and permanently ends push. Every branch below is therefore a
 * refusal or a loud warning, and none of them is a default.
 */

function input(overrides: Partial<PushEnvironmentInput> = {}): PushEnvironmentInput {
  return {
    declared: null,
    nodeEnv: "development",
    pushConfigured: false,
    ...overrides,
  };
}

describe("assessPushEnvironment", () => {
  it("should refuse a production service that has not said which Apple it means", () => {
    const assessment = assessPushEnvironment(
      input({ nodeEnv: "production", pushConfigured: true }),
    );

    expect(assessment.problems).toHaveLength(1);
    expect(assessment.problems[0]).toContain(PUSH_ENVIRONMENT_VAR);
    expect(assessment.problems[0]).toContain("BadDeviceToken");
  });

  it("should accept a production service that declared production", () => {
    const assessment = assessPushEnvironment(
      input({ nodeEnv: "production", pushConfigured: true, declared: "production" }),
    );

    expect(assessment.problems).toEqual([]);
    expect(assessment.environment).toBe("production");
    expect(assessment.declared).toBe(true);
  });

  it("should refuse a production service pointed at sandbox", () => {
    // The TestFlight trap in its exact shape: the app he installs comes through
    // TestFlight, which produces production tokens.
    const assessment = assessPushEnvironment(
      input({ nodeEnv: "production", pushConfigured: true, declared: "sandbox" }),
    );

    expect(assessment.problems.join("\n")).toContain("TestFlight");
    expect(assessment.problems.join("\n")).toContain(ALLOW_SANDBOX_VAR);
  });

  it("should allow sandbox in production when it is said out loud", () => {
    const assessment = assessPushEnvironment(
      input({ nodeEnv: "production", pushConfigured: true, declared: "sandbox", allowSandbox: true }),
    );

    expect(assessment.problems).toEqual([]);
    expect(assessment.environment).toBe("sandbox");
  });

  it("should refuse a value that is neither of the two words", () => {
    const assessment = assessPushEnvironment(input({ declared: "prod" }));

    expect(assessment.problems.join("\n")).toContain('must be "production" or "sandbox"');
  });

  it("should not demand a declaration from a machine with no APNs key", () => {
    // A developer machine with no `.p8` still has to boot; the conversation
    // surface and the harness do not need push.
    const assessment = assessPushEnvironment(input({ nodeEnv: "production", pushConfigured: false }));

    expect(assessment.problems).toEqual([]);
  });

  it("should default to sandbox outside production, and say it was a default", () => {
    const assessment = assessPushEnvironment(input({ nodeEnv: "development", pushConfigured: true }));

    expect(assessment.environment).toBe("sandbox");
    expect(assessment.declared).toBe(false);
    expect(assessment.problems).toEqual([]);
  });

  it("should warn, not refuse, about a device registered from the other channel", () => {
    // Routing is per token, so that device still works. What it means is that a
    // build from the other channel is installed somewhere.
    const assessment = assessPushEnvironment(
      input({
        nodeEnv: "production",
        pushConfigured: true,
        declared: "production",
        registered: [{ deviceId: "dev_1", environment: "sandbox" }],
      }),
    );

    expect(assessment.problems).toEqual([]);
    expect(assessment.warnings).toHaveLength(1);
    expect(assessment.warnings[0]).toContain("dev_1");
    expect(assessment.warnings[0]).toContain("sandbox");
  });

  it("should say nothing about devices that agree with the declaration", () => {
    const assessment = assessPushEnvironment(
      input({
        nodeEnv: "production",
        pushConfigured: true,
        declared: "production",
        registered: [
          { deviceId: "dev_1", environment: "production" },
          { deviceId: "dev_2", environment: "production" },
        ],
      }),
    );

    expect(assessment.warnings).toEqual([]);
  });
});

describe("assertPushEnvironment", () => {
  it("should throw, listing every problem, when the environment is not asserted", () => {
    expect(() =>
      assertPushEnvironment(assessPushEnvironment(input({ nodeEnv: "production", pushConfigured: true }))),
    ).toThrow(PushEnvironmentError);
  });

  it("should name the variable in the message, so the fix is in the error", () => {
    try {
      assertPushEnvironment(assessPushEnvironment(input({ nodeEnv: "production", pushConfigured: true })));
      expect.unreachable("it should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(PushEnvironmentError);
      expect((error as Error).message).toContain(PUSH_ENVIRONMENT_VAR);
    }
  });

  it("should hand the assessment straight back when there is nothing wrong", () => {
    const assessment = assessPushEnvironment(input({ declared: "sandbox" }));
    expect(assertPushEnvironment(assessment)).toBe(assessment);
  });
});

describe("describePushEnvironment", () => {
  it("should name the environment and where it came from", () => {
    const assessment = assessPushEnvironment(input({ declared: "production", pushConfigured: true }));
    const lines = describePushEnvironment(assessment, { pushConfigured: true });

    expect(lines[0]).toContain("production");
    expect(lines[0]).toContain(PUSH_ENVIRONMENT_VAR);
  });

  it("should credit NODE_ENV when nothing was declared", () => {
    const assessment = assessPushEnvironment(input({ pushConfigured: true }));
    expect(describePushEnvironment(assessment, { pushConfigured: true })[0]).toContain("NODE_ENV");
  });

  it("should say push is off rather than pretend it is on", () => {
    const assessment = assessPushEnvironment(input());
    expect(describePushEnvironment(assessment, { pushConfigured: false })[0]).toContain("not configured");
  });

  it("should repeat every mismatch warning where a person will see it", () => {
    const assessment = assessPushEnvironment(
      input({
        declared: "production",
        pushConfigured: true,
        registered: [{ deviceId: "dev_1", environment: "sandbox" }],
      }),
    );

    const lines = describePushEnvironment(assessment, { pushConfigured: true });
    expect(lines.join("\n")).toContain("WARNING");
    expect(lines.join("\n")).toContain("dev_1");
  });
});

describe("pushEnvironmentProbe", () => {
  it("should report ok when every registered token agrees", () => {
    const probe = pushEnvironmentProbe({
      environment: "production",
      pushConfigured: true,
      targets: () => [{ deviceId: "dev_1", environment: "production" }],
    });

    expect(probe.run()).toEqual({ status: "ok", detail: "production" });
  });

  it("should report degraded when a token is from the other environment", () => {
    const probe = pushEnvironmentProbe({
      environment: "production",
      pushConfigured: true,
      targets: () => [{ deviceId: "dev_1", environment: "sandbox" }],
    });

    expect(probe.run().status).toBe("degraded");
  });

  it("should re-read the devices on every request", () => {
    // A device registered an hour after boot is the one most likely to be from
    // the wrong channel. A probe that captured the list at startup would never
    // see it.
    let targets: { deviceId: string; environment: "sandbox" | "production" }[] = [];
    const probe = pushEnvironmentProbe({
      environment: "production",
      pushConfigured: true,
      targets: () => targets,
    });

    expect(probe.run().status).toBe("ok");
    targets = [{ deviceId: "dev_late", environment: "sandbox" }];
    expect(probe.run().status).toBe("degraded");
  });

  it("should report degraded when push is not configured at all", () => {
    const probe = pushEnvironmentProbe({
      environment: "production",
      pushConfigured: false,
      targets: () => [],
    });

    expect(probe.run().status).toBe("degraded");
  });

  it("should be named so a health response can be read at a glance", () => {
    const probe = pushEnvironmentProbe({ environment: "sandbox", pushConfigured: true, targets: () => [] });
    expect(probe.name).toBe("apns-environment");
  });
});

describe("isPushEnvironment", () => {
  it("should accept exactly the two Apple environments", () => {
    expect(isPushEnvironment("production")).toBe(true);
    expect(isPushEnvironment("sandbox")).toBe(true);
    expect(isPushEnvironment("development")).toBe(false);
    expect(isPushEnvironment("")).toBe(false);
  });
});
