import { describe, expect, it } from "vitest";

import type { Device, DevicePage, Ok } from "@syl/shared/types";

import {
  environmentTone,
  fleetHeadline,
  fleetTone,
  silenceMs,
  sortDevices,
  STALE_AFTER_MS,
  standingLabel,
  standingOf,
  standingTone,
  summariseFleet,
} from "../../src/features/devices/device-model";
import { fixture } from "../helpers/fixtures";

const devices: readonly Device[] = (fixture("http/devices.page") as Ok<DevicePage>).data.items;

function deviceIn(environment: Device["environment"]): Device {
  const found = devices.find((device) => device.environment === environment);
  if (found === undefined) throw new Error(`no ${environment} device in the fixture`);
  return found;
}

const phone = deviceIn("production");
const debugBuild = deviceIn("sandbox");

describe("standingOf", () => {
  const now = new Date("2026-08-09T07:00:00.000Z");

  it("should call a recently seen active device healthy", () => {
    expect(standingOf(phone, now)).toBe("healthy");
    expect(standingLabel("healthy")).toBe("active");
  });

  it("should call an unregistered device unregistered, not missing", () => {
    // The row is kept rather than deleted, and history is the reason.
    expect(standingOf(debugBuild, now)).toBe("inactive");
    expect(standingLabel("inactive")).toBe("unregistered");
  });

  it("should flag an active device that has gone quiet for a day", () => {
    const quiet: Device = {
      ...phone,
      lastSeenAt: new Date(now.getTime() - STALE_AFTER_MS).toISOString(),
    };
    expect(standingOf(quiet, now)).toBe("stale");
    expect(standingLabel("stale")).toBe("not seen recently");
  });

  it("should tolerate an unparseable lastSeenAt rather than throwing", () => {
    expect(standingOf({ ...phone, lastSeenAt: "nope" }, now)).toBe("healthy");
  });
});

describe("standingTone", () => {
  it("should never colour an unregistered or quiet device as healthy", () => {
    expect(standingTone("healthy")).toBe("ok");
    expect(standingTone("stale")).toBe("warn");
    expect(standingTone("inactive")).toBe("muted");
  });
});

describe("environmentTone", () => {
  it("should call out a sandbox token, which is a different APNs host", () => {
    // Sending to the wrong host fails every time with BadDeviceToken, which
    // looks like a broken key rather than the wrong environment.
    expect(environmentTone("sandbox")).toBe("warn");
    expect(environmentTone("production")).toBe("accent");
  });
});

describe("silenceMs", () => {
  it("should measure how long since the device was last seen", () => {
    const now = new Date("2026-08-09T07:58:00.000Z");
    expect(silenceMs(phone, now)).toBe(60 * 60 * 1000);
  });
});

describe("sortDevices", () => {
  it("should put active devices above unregistered ones", () => {
    expect(sortDevices(devices)[0]?.active).toBe(true);
    expect(sortDevices([...devices].reverse())[0]?.active).toBe(true);
  });

  it("should order by most recently seen within a group", () => {
    const older: Device = { ...phone, id: "syl:device:old", lastSeenAt: "2020-01-01T00:00:00.000Z" };
    expect(sortDevices([older, phone])[0]?.id).toBe(phone.id);
  });

  it("should not mutate its argument", () => {
    const original = [...devices];
    sortDevices(devices);
    expect(devices).toEqual(original);
  });
});

describe("summariseFleet", () => {
  it("should count the fixture's mixed fleet", () => {
    const summary = summariseFleet(devices);
    expect(summary.total).toBe(2);
    expect(summary.active).toBe(1);
    expect(summary.sandbox).toBe(1);
    expect(summary.production).toBe(1);
    expect(summary.mixedEnvironments).toBe(true);
  });

  it("should not call a single-environment fleet mixed", () => {
    expect(summariseFleet([phone]).mixedEnvironments).toBe(false);
    expect(summariseFleet([debugBuild]).mixedEnvironments).toBe(false);
    expect(summariseFleet([]).mixedEnvironments).toBe(false);
  });
});

describe("fleetHeadline", () => {
  it("should say plainly when nothing can be pushed to", () => {
    expect(fleetHeadline(summariseFleet([]))).toContain("Nothing can be pushed to");
    expect(fleetHeadline(summariseFleet([debugBuild]))).toContain("Nothing can be pushed to");
  });

  it("should name both environments when both are in use", () => {
    // Normal during development, and the reason a global environment setting
    // breaks one of them.
    expect(fleetHeadline(summariseFleet(devices))).toContain("Both APNs environments");
  });

  it("should stay quiet about environments when there is only one", () => {
    expect(fleetHeadline(summariseFleet([phone]))).toBe("1 of 1 devices active.");
  });
});

describe("fleetTone", () => {
  it("should fail when no device is active", () => {
    expect(fleetTone(summariseFleet([debugBuild]))).toBe("fail");
    expect(fleetTone(summariseFleet(devices))).toBe("ok");
  });
});
