import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { deriveConnectBaseUrl, serverUrlForHandle } from "@bb/connect-client";
import { runCanary, type CanaryMode } from "./canary.js";
import {
  deploymentStatusSchema,
  parseRolloutPercentage,
  planRollout,
} from "./plan.js";

const CREDENTIAL_ENV = "CONNECT_CANARY_CREDENTIAL";

const USAGE = `Usage:
  connect-rollout canary --server-url <https://label.getbb.app> [--minutes 10]
      [--mode raw|ticket] [--api-base-url <https://getbb.app>]
      [--version-override 'bb-connect="<version-id>"'] [--recover-within <seconds>]
    Reads the canary server's credential from $${CREDENTIAL_ENV}.
    Holds a tunnel as that server and probes its hostname. Exits 1 on a
    missed heartbeat, a 503, a failed dial, or a dropped tunnel. With
    --recover-within it redials instead, and exits 1 only if the tunnel is
    not answering heartbeats and serving its hostname again within that
    many seconds. Start it before a deployment to check that connected
    tunnels come back.

  connect-rollout redeem --code <pairing-code> [--api-base-url <https://getbb.app>]
    Redeems a dashboard pairing code for a dedicated canary server and prints
    its server URL and credential. Store the credential as the
    ${CREDENTIAL_ENV} secret. The canary replaces any other tunnel on that
    label, so never point it at a server a real bb uses.

  connect-rollout plan --status-file <status.json> --version <version-id>
      --percentage 0|5|25|100
    Reads \`wrangler deployments status --json\` output and prints the
    \`wrangler versions deploy\` specs for the step, plus the version that
    serves the rest of the traffic (the rollback target).`;

const redeemResponseSchema = z.object({
  credential: z.string().min(1),
  handle: z.string().min(1),
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function canary(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "server-url": { type: "string" },
      "api-base-url": { type: "string" },
      mode: { type: "string", default: "raw" },
      minutes: { type: "string", default: "10" },
      "version-override": { type: "string" },
      "recover-within": { type: "string" },
    },
  });
  const serverUrl = values["server-url"] ?? fail(USAGE);
  const credential = process.env[CREDENTIAL_ENV]?.trim();
  if (!credential) fail(`${CREDENTIAL_ENV} is not set`);
  const mode = values.mode;
  if (mode !== "raw" && mode !== "ticket") fail("--mode must be raw or ticket");
  const minutes = Number(values.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    fail("--minutes must be a positive number");
  }
  const recoverWithin =
    values["recover-within"] === undefined
      ? null
      : Number(values["recover-within"]);
  if (
    recoverWithin !== null &&
    (!Number.isFinite(recoverWithin) || recoverWithin <= 0)
  ) {
    fail("--recover-within must be a positive number of seconds");
  }
  const result = await runCanary({
    serverUrl,
    apiBaseUrl: values["api-base-url"] ?? deriveConnectBaseUrl(serverUrl),
    credential,
    mode: mode satisfies CanaryMode,
    durationMs: minutes * 60_000,
    probeIntervalMs: 5_000,
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 15_000,
    dialTimeoutMs: 15_000,
    versionOverride: values["version-override"] ?? null,
    recoverWithinMs: recoverWithin === null ? null : recoverWithin * 1_000,
    log: (line) => console.log(line),
  });
  return result.ok ? 0 : 1;
}

async function plan(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "status-file": { type: "string" },
      version: { type: "string" },
      percentage: { type: "string" },
    },
  });
  const statusFile = values["status-file"] ?? fail(USAGE);
  const version = values.version ?? fail(USAGE);
  const percentage = parseRolloutPercentage(values.percentage ?? fail(USAGE));
  const status = deploymentStatusSchema.parse(
    JSON.parse(await readFile(statusFile, "utf8")),
  );
  console.log(JSON.stringify(planRollout(status, version, percentage)));
  return 0;
}

async function redeem(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      code: { type: "string" },
      "api-base-url": { type: "string", default: "https://getbb.app" },
    },
  });
  const code = values.code ?? fail(USAGE);
  const apiBaseUrl = values["api-base-url"];
  const response = await fetch(new URL("/api/connect/redeem", apiBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) {
    console.error(`redeem failed: HTTP ${response.status} ${await response.text()}`);
    return 1;
  }
  const redeemed = redeemResponseSchema.parse(await response.json());
  console.log(
    JSON.stringify(
      {
        serverUrl: serverUrlForHandle(apiBaseUrl, redeemed.handle),
        credential: redeemed.credential,
      },
      null,
      2,
    ),
  );
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
const exitCode =
  command === "canary"
    ? await canary(rest)
    : command === "redeem"
      ? await redeem(rest)
      : command === "plan"
        ? await plan(rest)
        : fail(USAGE);
process.exit(exitCode);
