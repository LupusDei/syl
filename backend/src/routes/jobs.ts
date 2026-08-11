import { Router, type RequestHandler } from "express";

import type { JobKind, JobState } from "@syl/shared";

import { JOB_KINDS, JOB_STATES, type JobStore } from "../services/job-store.js";
import { isId } from "../services/id.js";
import { ApiFailure, sendOk } from "./envelope.js";
import { asDeviceFailure, pageOptionsOf } from "./devices.js";

/**
 * Jobs and runs, read-only.
 *
 * Three views, and they are the whole of the admin's observability surface:
 * what is scheduled, what ran, and what failed. Every run carries the gap
 * between the instant it was scheduled for and the instant it actually
 * started, because that gap is the metric that says whether the trigger design
 * is working — and it is invisible unless it is recorded from day one.
 *
 * There is deliberately no `POST`. A job is created by the service, from a
 * closed catalogue; an HTTP endpoint that minted them would be the trust
 * boundary the catalogue exists to hold.
 */

export interface JobRouterOptions {
  readonly jobs: JobStore;
  readonly authenticate: RequestHandler;
}

export function createJobRouter(options: JobRouterOptions): Router {
  const { jobs, authenticate } = options;
  const router = Router();

  router.use("/jobs", authenticate);
  router.use("/runs", authenticate);

  router.get("/jobs", (request, response) => {
    const state = oneOf(request.query["state"], JOB_STATES, "state");
    const kind = oneOf(request.query["kind"], JOB_KINDS, "kind");

    try {
      sendOk(
        response,
        jobs.list({
          ...pageOptionsOf(request),
          ...(state === undefined ? {} : { state }),
          ...(kind === undefined ? {} : { kind }),
        }),
      );
    } catch (error) {
      asDeviceFailure(error);
    }
  });

  router.get("/jobs/:jobId", (request, response) => {
    const job = jobs.get(idOf(request.params["jobId"], "job"));
    if (job === null) throw new ApiFailure("NOT_FOUND", "There is no such job.");
    sendOk(response, job);
  });

  router.get("/jobs/:jobId/runs", (request, response) => {
    const jobId = idOf(request.params["jobId"], "job");
    if (jobs.get(jobId) === null) throw new ApiFailure("NOT_FOUND", "There is no such job.");

    try {
      sendOk(response, jobs.listRuns({ ...pageOptionsOf(request), jobId }));
    } catch (error) {
      asDeviceFailure(error);
    }
  });

  router.get("/runs/:runId", (request, response) => {
    const run = jobs.run(idOf(request.params["runId"], "run"));
    if (run === null) throw new ApiFailure("NOT_FOUND", "There is no such run.");
    sendOk(response, run);
  });

  return router;
}

function idOf(raw: unknown, type: "job" | "run"): string {
  const id = typeof raw === "string" ? raw : "";
  if (!isId(id, type)) throw new ApiFailure("NOT_FOUND", `That is not a ${type} id.`);
  return id;
}

/** Read a query parameter constrained to a closed set. */
function oneOf<T extends JobState | JobKind>(
  raw: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (raw === undefined) return undefined;
  const match = allowed.find((candidate) => candidate === raw);
  if (match === undefined) {
    throw new ApiFailure("VALIDATION_FAILED", `That is not a job ${field}.`, {
      details: { field, reason: `must be one of ${allowed.join(", ")}` },
    });
  }
  return match;
}
