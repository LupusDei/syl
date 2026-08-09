import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useNavigate, useParams } from "react-router-dom";

import type { Job, JobPage, JobState, RunPage } from "@syl/shared/types";

import { useAdminClient } from "../../api/use-admin-client";
import { useResource, type Loader } from "../../api/use-resource";
import { formatInstant, formatRelative } from "../../format/time";
import { humanise, shortId } from "../../format/text";
import { Badge } from "../../ui/Badge";
import { Empty, ErrorNotice, Loading } from "../../ui/feedback";
import {
  breakerTone,
  describeBreaker,
  describeBudget,
  describeLease,
  describeTrigger,
  jobStateTone,
  JOB_STATES,
  sortJobs,
} from "./job-model";
import { RunList } from "./RunList";

/**
 * The primary debugging surface: what is scheduled, what is running, and what
 * happened last time — including overnight, which is the part nobody was
 * awake for.
 *
 * Master and detail share one route (`/jobs` and `/jobs/:jobId`) so the
 * selected job is in the URL and a run can be linked to from anywhere.
 */
export function JobsView(): ReactElement {
  const client = useAdminClient();
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<JobState | "">("");

  const loadJobs = useCallback<Loader<JobPage>>(
    (signal) => {
      if (client === null) return Promise.reject(new Error("signed out"));
      return client.listJobs(state === "" ? {} : { state }, { signal });
    },
    [client, state],
  );
  const jobs = useResource<JobPage>(client === null ? null : loadJobs);

  const selectedId = jobId ?? null;
  const loadRuns = useCallback<Loader<RunPage>>(
    (signal) => {
      if (client === null || selectedId === null) return Promise.reject(new Error("no job"));
      return client.listJobRuns(selectedId, {}, { signal });
    },
    [client, selectedId],
  );
  const runs = useResource<RunPage>(client === null || selectedId === null ? null : loadRuns);

  // Recomputed whenever a page lands, so "in 3h" is relative to the data on
  // screen rather than to whenever this component last happened to render.
  const now = useMemo(() => new Date(), [jobs.data]);
  const rows = useMemo(() => sortJobs(jobs.data?.items ?? []), [jobs.data]);
  const selected = rows.find((job) => job.id === selectedId) ?? null;

  return (
    <section className="view view--wide">
      <h1 className="view__title">Jobs and runs</h1>
      <p className="view__lede">
        What is scheduled, what is holding a lease, and how every run ended. Sorted by trouble
        first — failures, then a tripped breaker, then work in flight.
      </p>

      <div className="toolbar">
        <label className="field field--inline">
          State
          <select
            className="field__select"
            value={state}
            onChange={(event) => {
              setState(event.target.value as JobState | "");
            }}
          >
            <option value="">any</option>
            {JOB_STATES.map((option) => (
              <option key={option} value={option}>
                {humanise(option)}
              </option>
            ))}
          </select>
        </label>

        <button className="button" type="button" onClick={jobs.reload} disabled={jobs.loading}>
          {jobs.loading ? "Refreshing…" : "Refresh"}
        </button>

        <span className="toolbar__count">
          {jobs.data === null ? "" : `${rows.length} of ${jobs.data.items.length} shown`}
        </span>
      </div>

      {jobs.error !== null && <ErrorNotice error={jobs.error} onRetry={jobs.reload} />}
      {jobs.error === null && jobs.loading && jobs.data === null && <Loading label="Loading jobs…" />}
      {jobs.error === null && jobs.data !== null && rows.length === 0 && (
        <Empty>No job matches this filter. Nothing is being hidden — the server returned none.</Empty>
      )}

      {rows.length > 0 && (
        <table className="table table--dense">
          <caption className="table__caption">Jobs</caption>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">State</th>
              <th scope="col">Trigger</th>
              <th scope="col">Next run</th>
              <th scope="col">Budget</th>
              <th scope="col">Breaker</th>
              <th scope="col">Lease</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                now={now}
                selected={job.id === selectedId}
                onSelect={() => {
                  navigate(job.id === selectedId ? "/jobs" : `/jobs/${encodeURIComponent(job.id)}`);
                }}
              />
            ))}
          </tbody>
        </table>
      )}

      {selectedId !== null && (
        <RunList
          jobId={selectedId}
          jobKind={selected?.kind ?? null}
          runs={runs}
          onClose={() => {
            navigate("/jobs");
          }}
        />
      )}
    </section>
  );
}

interface JobRowProps {
  readonly job: Job;
  readonly now: Date;
  readonly selected: boolean;
  onSelect(): void;
}

function JobRow({ job, now, selected, onSelect }: JobRowProps): ReactElement {
  return (
    <tr className={selected ? "row row--selected" : "row"}>
      <th scope="row">
        <button className="link" type="button" onClick={onSelect} title={job.id}>
          {humanise(job.kind)}
        </button>
        <span className="row__sub mono">{shortId(job.id)}</span>
      </th>
      <td>
        <Badge tone={jobStateTone(job.state)} title={job.state}>
          {humanise(job.state)}
        </Badge>
        {!job.speaks && <span className="row__sub">silent</span>}
      </td>
      <td className="mono">{describeTrigger(job.trigger)}</td>
      <td>
        <span className="mono">{formatInstant(job.nextRunAt)}</span>
        <span className="row__sub">{formatRelative(job.nextRunAt, now)}</span>
      </td>
      <td>{describeBudget(job.budget)}</td>
      <td>
        <Badge tone={breakerTone(job.circuitBreaker)} title={job.circuitBreaker.openedAt ?? undefined}>
          {describeBreaker(job.circuitBreaker)}
        </Badge>
      </td>
      <td className="mono">{describeLease(job.lease)}</td>
    </tr>
  );
}
