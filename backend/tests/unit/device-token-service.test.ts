import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import {
  DeviceTokenError,
  DeviceTokenService,
} from "../../src/services/device-token-service.js";
import { PagingError } from "../../src/services/paging.js";
import { TEST_NOW, testDatabase } from "../helpers/service.js";

/** A well-formed 64-character hex APNs token. */
function token(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

const IPHONE = token("9c0d2e41");

describe("DeviceTokenService", () => {
  let db: SylDatabase;
  let devices: DeviceTokenService;

  beforeEach(() => {
    db = testDatabase();
    devices = new DeviceTokenService({ db: db.handle, clock: fixedClock(TEST_NOW) });
  });

  afterEach(() => {
    db.close();
  });

  describe("register", () => {
    it("should register a device and expose only the token suffix", () => {
      const result = devices.register({
        token: IPHONE,
        environment: "production",
        platform: "ios",
        name: "Commander's iPhone",
        appVersion: "0.1.0 (14)",
        osVersion: "26.1",
      });

      expect(result.created).toBe(true);
      expect(result.device.tokenSuffix).toBe(IPHONE.slice(-8));
      expect(result.device.active).toBe(true);
      expect(result.device.environment).toBe("production");
      // The full token is a credential for pushing to his phone. Nothing that
      // leaves this service may carry it.
      expect(JSON.stringify(result.device)).not.toContain(IPHONE);
    });

    it("should update the existing row when the same token registers again", () => {
      const first = devices.register({
        token: IPHONE,
        environment: "sandbox",
        platform: "ios",
        name: "Commander's iPhone",
        appVersion: "0.1.0 (14)",
        osVersion: "26.0",
      });

      const second = devices.register({
        token: IPHONE,
        environment: "production",
        platform: "ios",
        name: "Commander's iPhone",
        appVersion: "0.2.0 (21)",
        osVersion: "26.1",
      });

      expect(second.created).toBe(false);
      expect(second.device.id).toBe(first.device.id);
      // The environment is a property of the token and moves with it: the same
      // phone re-registers as production the moment it stops being an Xcode
      // build, and a stale sandbox row would fail every send afterwards.
      expect(second.device.environment).toBe("production");
      expect(second.device.appVersion).toBe("0.2.0 (21)");
      expect(devices.list().items).toHaveLength(1);
    });

    it("should re-activate a token that was unregistered and has come back", () => {
      const first = devices.register({
        token: IPHONE,
        environment: "production",
        platform: "ios",
        name: "iPhone",
        appVersion: "1",
        osVersion: "26.1",
      });
      devices.deactivate(first.device.id);

      const again = devices.register({
        token: IPHONE,
        environment: "production",
        platform: "ios",
        name: "iPhone",
        appVersion: "1",
        osVersion: "26.1",
      });
      expect(again.device.active).toBe(true);
    });

    it("should refuse a token that is not hex of a plausible length", () => {
      for (const bad of ["", "zzzz", "abc", token("a").slice(0, 63), `${token("a")}!`]) {
        expect(() =>
          devices.register({
            token: bad,
            environment: "production",
            platform: "ios",
            name: "iPhone",
            appVersion: "1",
            osVersion: "26.1",
          }),
        ).toThrow(DeviceTokenError);
      }
    });

    it("should normalise token case so one phone cannot register twice", () => {
      devices.register({
        token: IPHONE.toUpperCase(),
        environment: "production",
        platform: "ios",
        name: "iPhone",
        appVersion: "1",
        osVersion: "26.1",
      });
      const second = devices.register({
        token: IPHONE.toLowerCase(),
        environment: "production",
        platform: "ios",
        name: "iPhone",
        appVersion: "1",
        osVersion: "26.1",
      });
      expect(second.created).toBe(false);
      expect(devices.list().items).toHaveLength(1);
    });
  });

  describe("reading", () => {
    beforeEach(() => {
      devices.register({
        token: IPHONE,
        environment: "production",
        platform: "ios",
        name: "iPhone",
        appVersion: "1",
        osVersion: "26.1",
      });
      devices.register({
        token: token("11111111"),
        environment: "sandbox",
        platform: "ios",
        name: "Simulator",
        appVersion: "1",
        osVersion: "26.1",
      });
    });

    it("should return a device by id", () => {
      const listed = devices.list().items;
      const first = listed[0];
      expect(first).toBeDefined();
      expect(devices.get(first?.id ?? "")?.id).toBe(first?.id);
    });

    it("should return null for an id it does not have", () => {
      expect(devices.get("syl:device:00000000-0000-7000-8000-00000000ffff")).toBeNull();
    });

    it("should page", () => {
      const first = devices.list({ limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.hasMore).toBe(true);

      const second = devices.list({ limit: 1, cursor: first.nextCursor });
      expect(second.items).toHaveLength(1);
      expect(second.hasMore).toBe(false);
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    });

    it("should refuse a cursor it did not issue", () => {
      expect(() => devices.list({ cursor: "nope" })).toThrow(PagingError);
    });
  });

  describe("targets", () => {
    it("should hand the send path a token and its environment together", () => {
      devices.register({
        token: IPHONE,
        environment: "production",
        platform: "ios",
        name: "iPhone",
        appVersion: "1",
        osVersion: "26.1",
      });
      devices.register({
        token: token("22222222"),
        environment: "sandbox",
        platform: "ios",
        name: "Simulator",
        appVersion: "1",
        osVersion: "26.1",
      });

      const targets = devices.targets();
      expect(targets).toHaveLength(2);
      // Routing is per token. A global setting would break one of these two,
      // and the only symptom would be BadDeviceToken on every send.
      expect(targets.map((target) => target.environment).sort()).toEqual([
        "production",
        "sandbox",
      ]);
      expect(targets.map((target) => target.token)).toContain(IPHONE);
    });

    it("should exclude a device that was unregistered", () => {
      const registered = devices.register({
        token: IPHONE,
        environment: "production",
        platform: "ios",
        name: "iPhone",
        appVersion: "1",
        osVersion: "26.1",
      });
      devices.deactivate(registered.device.id);
      expect(devices.targets()).toHaveLength(0);
    });
  });

  describe("deactivate", () => {
    it("should mark the row inactive rather than deleting it", () => {
      const registered = devices.register({
        token: IPHONE,
        environment: "production",
        platform: "ios",
        name: "iPhone",
        appVersion: "1",
        osVersion: "26.1",
      });

      const after = devices.deactivate(registered.device.id);
      expect(after?.active).toBe(false);
      // Still readable: the admin's device viewer shows what stopped working.
      expect(devices.get(registered.device.id)).not.toBeNull();
    });

    it("should return null for an unknown id", () => {
      expect(devices.deactivate("syl:device:00000000-0000-7000-8000-00000000ffff")).toBeNull();
    });

    it("should unregister by token, which is what a 410 hands us", () => {
      // APNs reports a dead token by token, never by our id.
      devices.register({
        token: IPHONE,
        environment: "production",
        platform: "ios",
        name: "iPhone",
        appVersion: "1",
        osVersion: "26.1",
      });

      expect(devices.deactivateByToken(IPHONE.toUpperCase())).toBe(true);
      expect(devices.targets()).toHaveLength(0);
      // A token we have never seen is not an error; the row may already be gone.
      expect(devices.deactivateByToken(token("33333333"))).toBe(false);
    });
  });

  describe("touch", () => {
    it("should move lastSeenAt forward without disturbing registeredAt", () => {
      const later = TEST_NOW + 3_600_000;
      const service = new DeviceTokenService({ db: db.handle, clock: fixedClock(TEST_NOW) });
      const registered = service.register({
        token: IPHONE,
        environment: "production",
        platform: "ios",
        name: "iPhone",
        appVersion: "1",
        osVersion: "26.1",
      });

      const touched = new DeviceTokenService({ db: db.handle, clock: fixedClock(later) });
      touched.touch(registered.device.id);

      const after = service.get(registered.device.id);
      expect(after?.registeredAt).toBe(registered.device.registeredAt);
      expect(after?.lastSeenAt).toBe(new Date(later).toISOString());
    });
  });
});
