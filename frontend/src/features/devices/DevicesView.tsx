import { useCallback, useMemo, type ReactElement } from "react";

import type { Device, DevicePage } from "@syl/shared/types";

import { useAdminClient } from "../../api/use-admin-client";
import { useResource, type Loader } from "../../api/use-resource";
import { formatDuration, formatInstant } from "../../format/time";
import { shortId } from "../../format/text";
import { Badge } from "../../ui/Badge";
import { Empty, ErrorNotice, Loading } from "../../ui/feedback";
import {
  environmentTone,
  fleetHeadline,
  fleetTone,
  silenceMs,
  sortDevices,
  standingLabel,
  standingOf,
  standingTone,
  summariseFleet,
} from "./device-model";

/**
 * Registered push targets and how recently each was heard from.
 *
 * The environment column is the point. It is carried per token — Xcode builds
 * are `sandbox`, TestFlight and App Store builds are `production`, and during
 * development both exist at once. Sending to the wrong host fails every time
 * with `BadDeviceToken`, which looks like a broken key rather than a
 * mismatched environment, so this surface names it on every row.
 */
export function DevicesView(): ReactElement {
  const client = useAdminClient();

  const load = useCallback<Loader<DevicePage>>(
    (signal) => {
      if (client === null) return Promise.reject(new Error("signed out"));
      return client.listDevices({}, { signal });
    },
    [client],
  );
  const devices = useResource<DevicePage>(client === null ? null : load);

  const items = devices.data?.items ?? [];
  const now = useMemo(() => new Date(), [devices.data]);
  const rows = useMemo(() => sortDevices(items), [items]);
  const summary = useMemo(() => summariseFleet(items), [items]);

  return (
    <section className="view view--wide">
      <h1 className="view__title">Devices</h1>
      <p className="view__lede">
        Every registered push target. <code>environment</code> is carried per token, never
        server-wide — a sandbox token sent to the production host fails with{" "}
        <code>BadDeviceToken</code>, which looks like a broken key rather than the wrong host.
      </p>

      {devices.data !== null && (
        <div className="banner" data-testid="fleet-summary">
          <Badge tone={fleetTone(summary)}>{fleetHeadline(summary)}</Badge>
        </div>
      )}

      <div className="toolbar">
        <button className="button" type="button" onClick={devices.reload} disabled={devices.loading}>
          {devices.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {devices.error !== null && <ErrorNotice error={devices.error} onRetry={devices.reload} />}
      {devices.error === null && devices.loading && devices.data === null && (
        <Loading label="Loading devices…" />
      )}
      {devices.error === null && devices.data !== null && rows.length === 0 && (
        <Empty>No device has ever registered.</Empty>
      )}

      {rows.length > 0 && (
        <table className="table table--dense">
          <caption className="table__caption">Devices</caption>
          <thead>
            <tr>
              <th scope="col">Standing</th>
              <th scope="col">Name</th>
              <th scope="col">APNs environment</th>
              <th scope="col">Token</th>
              <th scope="col">App</th>
              <th scope="col">OS</th>
              <th scope="col">Last seen</th>
              <th scope="col">Registered</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((device) => (
              <DeviceRow key={device.id} device={device} now={now} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function DeviceRow({ device, now }: { device: Device; now: Date }): ReactElement {
  const standing = standingOf(device, now);
  const silent = silenceMs(device, now);

  return (
    <tr className="row">
      <th scope="row">
        <Badge tone={standingTone(standing)} title={device.id}>
          {standingLabel(standing)}
        </Badge>
      </th>
      <td>
        {device.name}
        <span className="row__sub mono">{shortId(device.id)}</span>
      </td>
      <td>
        <Badge tone={environmentTone(device.environment)} title={device.environment}>
          {device.environment}
        </Badge>
        <span className="row__sub">{device.platform}</span>
      </td>
      <td className="mono" title="the last bytes of the APNs token — the whole one never leaves the server">
        …{device.tokenSuffix}
      </td>
      <td className="mono">{device.appVersion}</td>
      <td className="mono">{device.osVersion}</td>
      <td className="mono">
        {formatInstant(device.lastSeenAt)}
        {silent !== null && <span className="row__sub">{formatDuration(silent)} ago</span>}
      </td>
      <td className="mono">{formatInstant(device.registeredAt)}</td>
    </tr>
  );
}
