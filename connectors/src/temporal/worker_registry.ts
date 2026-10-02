import { runBigQueryWorker } from "@connectors/connectors/bigquery/temporal/worker";
import { runConfluenceWorker } from "@connectors/connectors/confluence/temporal/worker";
import { runDustProjectWorker } from "@connectors/connectors/dust_project/temporal/worker";
import { runGithubWorker } from "@connectors/connectors/github/temporal/worker";
import { runGongWorker } from "@connectors/connectors/gong/temporal/worker";
import { runGoogleWorkers } from "@connectors/connectors/google_drive/temporal/worker";
import { runIntercomWorker } from "@connectors/connectors/intercom/temporal/worker";
import { runMicrosoftWorker } from "@connectors/connectors/microsoft/temporal/worker";
import {
  runNotionGarbageCollectWorker,
  runNotionWorker,
} from "@connectors/connectors/notion/temporal/worker";
import { runSalesforceWorker } from "@connectors/connectors/salesforce/temporal/worker";
import { runSlackWorker } from "@connectors/connectors/slack/temporal/worker";
import { runSnowflakeWorker } from "@connectors/connectors/snowflake/temporal/worker";
import { runWebCrawlerWorker } from "@connectors/connectors/webcrawler/temporal/worker";
import { runZendeskWorkers } from "@connectors/connectors/zendesk/temporal/worker";
import { PROVIDER_GROUPS } from "@connectors/lib/enabled_connector_providers";
import type { ConnectorProvider } from "@dust-tt/client";

export type WorkerName =
  | "bigquery"
  | "confluence"
  | "dust_project"
  | "github"
  | "gong"
  | "google_drive"
  | "intercom"
  | "microsoft"
  | "notion"
  | "notion_garbage_collector"
  | "salesforce"
  | "slack"
  | "snowflake"
  | "webcrawler"
  | "zendesk";

export const workerFunctions: Record<WorkerName, () => Promise<void>> = {
  bigquery: runBigQueryWorker,
  confluence: runConfluenceWorker,
  dust_project: runDustProjectWorker,
  github: runGithubWorker,
  gong: runGongWorker,
  google_drive: runGoogleWorkers,
  intercom: runIntercomWorker,
  microsoft: runMicrosoftWorker,
  notion: runNotionWorker,
  notion_garbage_collector: runNotionGarbageCollectWorker,
  salesforce: runSalesforceWorker,
  slack: runSlackWorker,
  snowflake: runSnowflakeWorker,
  webcrawler: runWebCrawlerWorker,
  zendesk: runZendeskWorkers,
};

// Keyed by `WorkerName` so that a worker added upstream fails type-checking here until it is
// mapped.
/**
 * @cc [owner:jchen0824,label:security] connectors-worker-providers
 * `WORKER_PROVIDERS[worker]` MUST list every connector provider whose connectors the workflows and
 * activities run by `workerFunctions[worker]` can do work for, such as `slack_bot` as well as
 * `slack` for the `slack` worker. A worker that lists more than one provider shares its code
 * between them, so its providers MUST be exactly its entry in `PROVIDER_GROUPS`: a list then
 * enables all of them or none, and the worker starts only under a list that enables all of them.
 */
export const WORKER_PROVIDERS: Record<
  WorkerName,
  readonly [ConnectorProvider, ...ConnectorProvider[]]
> = {
  bigquery: ["bigquery"],
  confluence: ["confluence"],
  dust_project: ["dust_project"],
  github: ["github"],
  gong: ["gong"],
  google_drive: ["google_drive"],
  intercom: ["intercom"],
  microsoft: ["microsoft"],
  notion: ["notion"],
  notion_garbage_collector: ["notion"],
  salesforce: ["salesforce"],
  // The Slack queue runs workflows and activities for connectors of both Slack providers.
  slack: PROVIDER_GROUPS.slack,
  snowflake: ["snowflake"],
  webcrawler: ["webcrawler"],
  zendesk: ["zendesk"],
};

export const ALL_WORKERS = Object.keys(workerFunctions);
