/**
 * What the device viewer decides, as pure functions.
 *
 * The field that earns its own treatment is `environment`. It is carried
 * **per token**, not as a server-wide setting: Xcode-installed builds produce
 * `sandbox` tokens, TestFlight and App Store builds produce `production`
 * ones, and during development both exist at once. A global setting breaks one
 * of them, and the only symptom is `BadDeviceToken` on every send — a failure
 * that looks like a broken key rather than a mismatched environment. So the
 * environment is shown on every row, and a mixed fleet is called out rather
 * than left to be noticed.
 */

import type { Device, PushEnvironment } from "@syl/shared/types";

import { elapsedMs } from "../../format/time";
import type { Tone } from "../../ui/Badge";

/** A device that has not been heard from in this long is probably not there. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type DeviceStanding =
  /** Unregistered. The row is kept, not deleted — history matters. */
  | "inactive"
  /** Active, but silent for longer than a day. */
  | "stale"
  | "healthy";

export function standingOf(device: Device, now: Date): DeviceStanding {
  if (!device.active) return "inactive";
  const silence = elapsedMs(device.lastSeenAt, now.toISOString());
  return silence !== null && silence >= STALE_AFTER_MS ? "stale" : "healthy";
}

const STANDING_TONE: Record<DeviceStanding, Tone> = {
  inactive: "muted",
  stale: "warn",
  healthy: "ok",
};

export function standingTone(standing: DeviceStanding): Tone {
  return STANDING_TONE[standing];
}

const STANDING_LABEL: Record<DeviceStanding, string> = {
  inactive: "unregistered",
  stale: "not seen recently",
  healthy: "active",
};

export function standingLabel(standing: DeviceStanding): string {
  return STANDING_LABEL[standing];
}

/**
 * `sandbox` is not a lesser `production` — it is a different APNs host, and
 * sending to the wrong one fails every time with the same opaque error.
 */
export function environmentTone(environment: PushEnvironment): Tone {
  return environment === "production" ? "accent" : "warn";
}

export function silenceMs(device: Device, now: Date): number | null {
  return elapsedMs(device.lastSeenAt, now.toISOString());
}

/** Active devices first, then the most recently seen. */
export function sortDevices(items: readonly Device[]): Device[] {
  return [...items].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.lastSeenAt.localeCompare(a.lastSeenAt);
  });
}

export interface FleetSummary {
  readonly total: number;
  readonly active: number;
  readonly sandbox: number;
  readonly production: number;
  /** Both environments registered at once — normal in development, and worth saying. */
  readonly mixedEnvironments: boolean;
}

export function summariseFleet(items: readonly Device[]): FleetSummary {
  let active = 0;
  let sandbox = 0;
  let production = 0;

  for (const device of items) {
    if (device.active) active += 1;
    if (device.environment === "sandbox") sandbox += 1;
    else production += 1;
  }

  return {
    total: items.length,
    active,
    sandbox,
    production,
    mixedEnvironments: sandbox > 0 && production > 0,
  };
}

/**
 * The sentence above the table. A fleet with no active device cannot be
 * pushed to at all, which is the one fact that must not be buried.
 */
export function fleetHeadline(summary: FleetSummary): string {
  if (summary.total === 0) return "No device is registered. Nothing can be pushed to.";
  if (summary.active === 0) {
    return `All ${summary.total} registered devices are unregistered. Nothing can be pushed to.`;
  }
  const mixed = summary.mixedEnvironments
    ? ` Both APNs environments are in use (${summary.sandbox} sandbox, ${summary.production} production).`
    : "";
  return `${summary.active} of ${summary.total} devices active.${mixed}`;
}

export function fleetTone(summary: FleetSummary): Tone {
  return summary.active === 0 ? "fail" : "ok";
}
