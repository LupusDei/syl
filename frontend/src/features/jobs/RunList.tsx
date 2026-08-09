import { useState, type ReactElement } from "react";

import type { JobKind, Run, RunPage, RunStep } from "@syl/shared/types";

import type { Resource } from "../../api/use-resource";
import { elapsedMs, formatDuration, formatInstant, formatLateness } from "../../format/time";
import { firstLine, formatCost, humanise, pluralise, shortId } from "../../format/text";
import { Badge } from "../../ui/Badge";
import { Empty, ErrorNotice, Loading } from "../../ui/feedback";
import { runDetail, runDurationMs, runIsLate, runOutcomeTone } from "./job-model";

export interface RunListProps {
  readonly jobId: string;
  readonly jobKind: JobKind | null;
  readonly runs: Resource<RunPage>;
  onClose(): void;
}

/**
 * Every run of one job, newest first, with the gap between scheduled and
 * actual on every row.
 *
 * That gap is not a detail: a run that fired late is a nuisance and one that
 * pretended to be on time is a lie, so lateness gets its own column and is
 * flagged past a minute rather than being buried in two timestamps the reader
 * has to subtract.
 */
export function RunList({ jobId, jobKind, runs, onClose }: RunListProps): ReactElement {
  const items = runs.data?.items ?? [];

  return (
    <section className="detail">
      <div className="detail__head">
        <h2 className="detail__title">
          Runs of {jobKind === null ? "job" : humanise(jobKind)}{" "}
          <span className="mono detail__id" title={jobId}>
            {shortId(jobId)}
          </span>
        </h2>
        <button className="button" type="button" onClick={runs.reload} disabled={runs.loading}>
          {runs.loading ? "Refreshing…" : "Refresh"}
        </button>
        <button className="button" type="button" onClick={onClose}>
          Close
        </button>
      </div>

      {runs.error !== null && <ErrorNotice error={runs.error} onRetry={runs.reload} />}
      {runs.error === null && runs.loading && runs.data === null && <Loading label="Loading runs…" />}
      {runs.error === null && runs.data !== null && items.length === 0 && (
        <Empty>This job has never run.</Empty>
      )}

      {items.length > 0 && (
        <table className="table table--dense">
          <caption className="table__caption">{pluralise(items.length, "run")}</caption>
          <thead>
            <tr>
              <th scope="col">Outcome</th>
              <th scope="col">Scheduled</th>
              <th scope="col">Late by</th>
              <th scope="col">Took</th>
              <th scope="col">Turns</th>
              <th scope="col">Cost</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {items.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RunRow({ run }: { run: Run }): ReactElement {
  const [open, setOpen] = useState(false);
  const late = runIsLate(run);
  const detail = runDetail(run);

  return (
    <>
      <tr className="row">
        <th scope="row">
          <Badge tone={runOutcomeTone(run.outcome)} title={run.id}>
            {humanise(run.outcome)}
          </Badge>
          {!run.spoke && <span className="row__sub">silent</span>}
        </th>
        <td className="mono">{formatInstant(run.triggerInstant)}</td>
        <td className={late ? "mono cell--late" : "mono"}>{formatLateness(run.latenessMs)}</td>
        <td className="mono">{formatDuration(runDurationMs(run))}</td>
        <td className="mono">{run.turns}</td>
        <td className="mono">{formatCost(run.costUsd)}</td>
        <td className="table__prose">
          {run.error !== null && <span className="cell--error">{firstLine(detail)}</span>}
          {run.error === null && firstLine(detail)}
          {run.attempts > 1 && <span className="row__sub">{pluralise(run.attempts, "attempt")}</span>}
          {run.steps.length > 0 && (
            <button
              className="link"
              type="button"
              onClick={() => {
                setOpen((previous) => !previous);
              }}
            >
              {open ? "hide" : `${pluralise(run.steps.length, "step")}`}
            </button>
          )}
        </td>
      </tr>
      {open &&
        run.steps.map((step) => <StepRow key={step.id} step={step} />)}
    </>
  );
}

/**
 * One turn of a run.
 *
 * The session id is the point of this row: it is what `claude --resume` takes,
 * so it is the difference between reading about a failed overnight run and
 * being able to pick it up.
 */
function StepRow({ step }: { step: RunStep }): ReactElement {
  return (
    <tr className="row row--step">
      <th scope="row">
        <span className="row__sub">step {step.index}</span>
      </th>
      <td className="mono">{formatInstant(step.startedAt)}</td>
      <td className="mono" title="session id — what `claude --resume` takes">
        {step.sessionId ?? "—"}
      </td>
      <td className="mono">{formatDuration(elapsedMs(step.startedAt, step.finishedAt))}</td>
      <td className="mono">{step.numTurns}</td>
      <td className="mono">{formatCost(step.costUsd)}</td>
      <td className="table__prose">
        <Badge tone={runOutcomeTone(step.outcome)}>{humanise(step.outcome)}</Badge>{" "}
        {firstLine(step.summary)}
      </td>
    </tr>
  );
}
