import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket as NodeWebSocket } from "ws";
import { z } from "zod";
import { TunnelSession } from "@bb/tunnel-client";
import {
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  PROTOCOL_VERSION,
  TUNNEL_PROTOCOL_QUERY_PARAM,
} from "@bb/tunnel-contract";

export const CANARY_PROBE_PATH = "/install/version";
export const VERSION_OVERRIDES_HEADER = "Cloudflare-Workers-Version-Overrides";
const TUNNEL_OFFLINE_HEADER = "x-bb-tunnel-offline";
const PROBE_TIMEOUT_MS = 10_000;
const MAX_CONSECUTIVE_PROBE_ERRORS = 2;
const WATCHDOG_INTERVAL_MS = 250;

export type CanaryMode = "raw" | "ticket";

export interface CanaryOptions {
  serverUrl: string;
  apiBaseUrl: string;
  credential: string;
  mode: CanaryMode;
  durationMs: number;
  probeIntervalMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  dialTimeoutMs: number;
  versionOverride: string | null;
  recoverWithinMs: number | null;
  log(line: string): void;
}

export type CanaryFailureKind =
  | "ticket"
  | "dial"
  | "heartbeat"
  | "probe"
  | "closed";

export interface CanaryFailure {
  kind: CanaryFailureKind;
  detail: string;
}

export interface CanaryResult {
  ok: boolean;
  failure: CanaryFailure | null;
  heartbeats: { sent: number; acked: number; maxAckMs: number };
  probes: { ok: number; failed: number; statuses: Record<string, number> };
  recoveries: number[];
  connectedMs: number;
}

const ticketResponseSchema = z.object({
  ticket: z.string().min(1),
  tunnelUrl: z.string().url(),
});

class CanaryFailed extends Error {
  constructor(readonly failure: CanaryFailure) {
    super(`${failure.kind}: ${failure.detail}`);
  }
}

export function tunnelDialUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = "/__tunnel";
  url.search = "";
  url.searchParams.set(TUNNEL_PROTOCOL_QUERY_PARAM, String(PROTOCOL_VERSION));
  return url.toString();
}

function overrideHeaders(options: CanaryOptions): Record<string, string> {
  return options.versionOverride === null
    ? {}
    : { [VERSION_OVERRIDES_HEADER]: options.versionOverride };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mintTicket(
  options: CanaryOptions,
): Promise<{ ticket: string; tunnelUrl: string }> {
  let response: Response;
  try {
    response = await fetch(
      new URL("/api/connect/tunnel-ticket", options.apiBaseUrl),
      {
        method: "POST",
        headers: { authorization: `Bearer ${options.credential}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    );
  } catch (error) {
    throw new CanaryFailed({ kind: "ticket", detail: errorMessage(error) });
  }
  if (!response.ok) {
    throw new CanaryFailed({
      kind: "ticket",
      detail: `POST /api/connect/tunnel-ticket returned HTTP ${response.status}`,
    });
  }
  const parsed = ticketResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new CanaryFailed({
      kind: "ticket",
      detail: "the tunnel-ticket response did not match the expected shape",
    });
  }
  return parsed.data;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function startOrigin(body: string): Server {
  return createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://canary").pathname;
    if (request.method === "GET" && path === CANARY_PROBE_PATH) {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(body);
      return;
    }
    response.writeHead(404);
    response.end();
  });
}

function openTunnel(
  url: string,
  bearer: string,
  options: CanaryOptions,
): Promise<NodeWebSocket> {
  return new Promise((resolve, reject) => {
    const tunnel = new NodeWebSocket(url, {
      headers: { authorization: `Bearer ${bearer}`, ...overrideHeaders(options) },
      handshakeTimeout: options.dialTimeoutMs,
    });
    const fail = (detail: string) => {
      tunnel.removeAllListeners();
      tunnel.on("error", () => {});
      tunnel.terminate();
      reject(new CanaryFailed({ kind: "dial", detail }));
    };
    tunnel.once("open", () => {
      tunnel.removeAllListeners("error");
      tunnel.removeAllListeners("unexpected-response");
      resolve(tunnel);
    });
    tunnel.once("unexpected-response", (_request, response) => {
      response.resume();
      fail(`the gate answered the tunnel dial with HTTP ${response.statusCode}`);
    });
    tunnel.once("error", (error) => fail(errorMessage(error)));
  });
}

interface CanaryRun {
  options: CanaryOptions;
  originPort: number;
  expectedBody: string;
  heartbeats: CanaryResult["heartbeats"];
  probes: CanaryResult["probes"];
  emit(event: string, fields?: Record<string, unknown>): void;
}

async function dialTunnel(run: CanaryRun): Promise<NodeWebSocket> {
  const { options } = run;
  let dialUrl = tunnelDialUrl(options.serverUrl);
  let bearer = options.credential;
  if (options.mode === "ticket") {
    const minted = await mintTicket(options);
    dialUrl = tunnelDialUrl(minted.tunnelUrl.replace(/^ws/u, "http"));
    bearer = minted.ticket;
    run.emit("ticket-minted");
  }
  run.emit("dialing", { url: dialUrl, mode: options.mode });
  return openTunnel(dialUrl, bearer, options);
}

function holdTunnel(
  run: CanaryRun,
  connected: NodeWebSocket,
  until: number,
  onHealthy: () => void,
): Promise<void> {
  const { options, heartbeats, probes } = run;
  const timers: ReturnType<typeof setInterval>[] = [];
  const session = new TunnelSession({
    tunnel: connected,
    log: {
      info: (message) => run.emit("tunnel-client", { message }),
      warn: (message) => run.emit("tunnel-client", { message }),
    },
    resolveOrigin: () => ({
      kind: "ok",
      resolved: {
        origin: `http://127.0.0.1:${run.originPort}`,
        publicOrigin: new URL(options.serverUrl).origin,
      },
    }),
  });

  return new Promise<void>((resolve, reject) => {
    const pingsInFlight: number[] = [];
    let consecutiveProbeErrors = 0;
    let probeCount = 0;
    let acked = false;
    let proxied = false;
    let settled = false;
    const finish = (failure: CanaryFailure | null) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearInterval(timer);
      session.dispose();
      connected.removeAllListeners();
      connected.on("error", () => {});
      connected.terminate();
      if (failure === null) {
        resolve();
      } else {
        reject(new CanaryFailed(failure));
      }
    };
    const markHealthy = () => {
      if (acked && proxied) onHealthy();
    };

    session.start();
    connected.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary || data.toString() !== HEARTBEAT_RESPONSE) return;
      const sentAt = pingsInFlight.shift();
      if (sentAt === undefined) return;
      heartbeats.acked += 1;
      heartbeats.maxAckMs = Math.max(heartbeats.maxAckMs, Date.now() - sentAt);
      acked = true;
      markHealthy();
    });
    connected.on("close", (code: number, reason: Buffer) => {
      finish({
        kind: "closed",
        detail: `the tunnel closed (code ${code}${reason.length > 0 ? `, ${reason.toString()}` : ""})`,
      });
    });

    const ping = () => {
      if (connected.readyState !== NodeWebSocket.OPEN) return;
      pingsInFlight.push(Date.now());
      heartbeats.sent += 1;
      connected.send(HEARTBEAT_REQUEST);
    };

    const probe = async () => {
      probeCount += 1;
      const url = new URL(CANARY_PROBE_PATH, options.serverUrl);
      url.searchParams.set("canary", String(probeCount));
      let status: number;
      let offline = false;
      let body = "";
      try {
        const response = await fetch(url, {
          headers: overrideHeaders(options),
          redirect: "manual",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        status = response.status;
        offline = response.headers.get(TUNNEL_OFFLINE_HEADER) === "1";
        body = await response.text();
      } catch (error) {
        if (settled) return;
        probes.failed += 1;
        probes.statuses.error = (probes.statuses.error ?? 0) + 1;
        consecutiveProbeErrors += 1;
        run.emit("probe", { status: "error", detail: errorMessage(error) });
        if (consecutiveProbeErrors >= MAX_CONSECUTIVE_PROBE_ERRORS) {
          finish({
            kind: "probe",
            detail: `${consecutiveProbeErrors} probes in a row failed: ${errorMessage(error)}`,
          });
        }
        return;
      }
      if (settled) return;
      probes.statuses[String(status)] =
        (probes.statuses[String(status)] ?? 0) + 1;
      if (status === 200 && body === run.expectedBody) {
        probes.ok += 1;
        consecutiveProbeErrors = 0;
        proxied = true;
        markHealthy();
        return;
      }
      probes.failed += 1;
      consecutiveProbeErrors += 1;
      run.emit("probe", { status, offline });
      if (status === 503) {
        finish({
          kind: "probe",
          detail: `${url.host} answered 503${offline ? " (tunnel offline)" : ""}`,
        });
        return;
      }
      if (status === 200) {
        finish({
          kind: "probe",
          detail: `${url.host} answered 200 with a body that did not come from this canary's tunnel`,
        });
        return;
      }
      if (consecutiveProbeErrors >= MAX_CONSECUTIVE_PROBE_ERRORS) {
        finish({
          kind: "probe",
          detail: `${consecutiveProbeErrors} probes in a row failed; last HTTP ${status}`,
        });
      }
    };

    timers.push(setInterval(ping, options.heartbeatIntervalMs));
    timers.push(setInterval(() => void probe(), options.probeIntervalMs));
    timers.push(
      setInterval(() => {
        const oldest = pingsInFlight[0];
        if (
          oldest !== undefined &&
          Date.now() - oldest > options.heartbeatTimeoutMs
        ) {
          finish({
            kind: "heartbeat",
            detail: `no heartbeat reply within ${options.heartbeatTimeoutMs} ms`,
          });
          return;
        }
        if (Date.now() >= until) finish(null);
      }, WATCHDOG_INTERVAL_MS),
    );
    ping();
    void probe();
  });
}

function isAuthRejection(failure: CanaryFailure): boolean {
  return failure.kind === "ticket" || / HTTP 40[13]$/u.test(failure.detail);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCanary(options: CanaryOptions): Promise<CanaryResult> {
  const nonce = randomUUID();
  const heartbeats = { sent: 0, acked: 0, maxAckMs: 0 };
  const probes = {
    ok: 0,
    failed: 0,
    statuses: {} as Record<string, number>,
  };
  const recoveries: number[] = [];
  const emit = (event: string, fields: Record<string, unknown> = {}) => {
    options.log(
      JSON.stringify({ at: new Date().toISOString(), event, ...fields }),
    );
  };
  const origin = startOrigin(`bb-connect-canary ${nonce}\n`);
  let connectedAt = 0;
  const summary = (failure: CanaryFailure | null): CanaryResult => ({
    ok: failure === null,
    failure,
    heartbeats,
    probes,
    recoveries,
    connectedMs: connectedAt === 0 ? 0 : Date.now() - connectedAt,
  });

  try {
    const run: CanaryRun = {
      options,
      originPort: await listen(origin),
      expectedBody: `bb-connect-canary ${nonce}\n`,
      heartbeats,
      probes,
      emit,
    };
    let lostAt: number | null = null;
    let redials = 0;
    for (;;) {
      try {
        const connected = await dialTunnel(run);
        if (connectedAt === 0) connectedAt = Date.now();
        emit("connected");
        await holdTunnel(run, connected, connectedAt + options.durationMs, () => {
          if (lostAt === null) return;
          const recoveredMs = Date.now() - lostAt;
          recoveries.push(recoveredMs);
          emit("recovered", { afterMs: recoveredMs });
          lostAt = null;
          redials = 0;
        });
        if (lostAt !== null) {
          throw new CanaryFailed({
            kind: "closed",
            detail: "the hold ended before the tunnel recovered",
          });
        }
        const result = summary(null);
        emit("pass", { ...result });
        return result;
      } catch (error) {
        const failure =
          error instanceof CanaryFailed
            ? error.failure
            : { kind: "dial" as const, detail: errorMessage(error) };
        const now = Date.now();
        if (
          options.recoverWithinMs === null ||
          connectedAt === 0 ||
          isAuthRejection(failure) ||
          now >= connectedAt + options.durationMs
        ) {
          throw new CanaryFailed(failure);
        }
        lostAt ??= now;
        if (now - lostAt > options.recoverWithinMs) {
          throw new CanaryFailed({
            kind: failure.kind,
            detail: `not recovered within ${options.recoverWithinMs} ms; last: ${failure.detail}`,
          });
        }
        emit("lost", { ...failure });
        redials += 1;
        await sleep(Math.min(500 * 2 ** redials, 5_000));
      }
    }
  } catch (error) {
    const failure =
      error instanceof CanaryFailed
        ? error.failure
        : { kind: "dial" as const, detail: errorMessage(error) };
    const result = summary(failure);
    emit("fail", { ...result });
    return result;
  } finally {
    origin.close();
  }
}
