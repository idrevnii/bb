import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  decodeFrame,
  encodeFrame,
} from "@bb/tunnel-contract";
import {
  VERSION_OVERRIDES_HEADER,
  runCanary,
  type CanaryOptions,
} from "../src/canary.js";

const CREDENTIAL = "bbcred_canary";
const TICKET = "bbtkt_canary";

interface FakeGateOptions {
  answerHeartbeats: boolean;
  offline: boolean;
  closeAfterMs: number | null;
  orphanAfterFirstClose: boolean;
}

interface FakeGate {
  url: string;
  dialHeaders: Record<string, string | string[] | undefined>[];
  probeHeaders: Record<string, string | string[] | undefined>[];
  close(): Promise<void>;
}

const gates: FakeGate[] = [];

afterEach(async () => {
  await Promise.all(gates.splice(0).map((gate) => gate.close()));
});

async function startFakeGate(
  overrides: Partial<FakeGateOptions> = {},
): Promise<FakeGate> {
  const options: FakeGateOptions = {
    answerHeartbeats: true,
    offline: false,
    closeAfterMs: null,
    orphanAfterFirstClose: false,
    ...overrides,
  };
  let connections = 0;
  let broken = false;
  let tunnel: WebSocket | null = null;
  let nextStreamId = 1;
  const pending = new Map<
    number,
    { status: number; chunks: Buffer[]; done: (status: number, body: string) => void }
  >();
  const dialHeaders: FakeGate["dialHeaders"] = [];
  const probeHeaders: FakeGate["probeHeaders"] = [];

  const server: Server = createServer((request, response) => {
    if (request.url?.startsWith("/api/connect/tunnel-ticket")) {
      const authorized = request.headers.authorization === `Bearer ${CREDENTIAL}`;
      response.writeHead(authorized ? 200 : 401, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          authorized
            ? { ticket: TICKET, tunnelUrl: `${gate.url.replace(/^http/u, "ws")}/__tunnel`, expiresAt: 0 }
            : { error: "unauthorized" },
        ),
      );
      return;
    }
    probeHeaders.push(request.headers);
    if (options.offline || broken || tunnel === null) {
      response.writeHead(503, { "x-bb-tunnel-offline": "1" });
      response.end("offline");
      return;
    }
    const streamId = nextStreamId++;
    pending.set(streamId, {
      status: 0,
      chunks: [],
      done: (status, body) => {
        response.writeHead(status);
        response.end(body);
      },
    });
    tunnel.send(
      encodeFrame({
        type: "open-http",
        streamId,
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: [],
        hasBody: false,
      }),
    );
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    dialHeaders.push(request.headers);
    const bearer = request.headers.authorization;
    if (bearer !== `Bearer ${CREDENTIAL}` && bearer !== `Bearer ${TICKET}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      tunnel = ws;
      connections += 1;
      const first = connections === 1;
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary) {
          if (
            data.toString() === HEARTBEAT_REQUEST &&
            options.answerHeartbeats &&
            !broken
          ) {
            ws.send(HEARTBEAT_RESPONSE);
          }
          return;
        }
        const frame = decodeFrame(data);
        const entry = pending.get(frame.streamId);
        if (!entry) return;
        if (frame.type === "resp-head") entry.status = frame.status;
        if (frame.type === "body-chunk") entry.chunks.push(Buffer.from(frame.data));
        if (frame.type === "body-end") {
          pending.delete(frame.streamId);
          entry.done(entry.status, Buffer.concat(entry.chunks).toString());
        }
      });
      if (options.closeAfterMs !== null && first) {
        setTimeout(() => {
          broken = options.orphanAfterFirstClose;
          ws.close(1012, "gate restarted");
        }, options.closeAfterMs);
      }
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    );
  });
  const gate: FakeGate = {
    url: `http://127.0.0.1:${port}`,
    dialHeaders,
    probeHeaders,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  gates.push(gate);
  return gate;
}

function canaryOptions(
  gate: FakeGate,
  overrides: Partial<CanaryOptions> = {},
): CanaryOptions {
  return {
    serverUrl: gate.url,
    apiBaseUrl: gate.url,
    credential: CREDENTIAL,
    mode: "raw",
    durationMs: 1_200,
    probeIntervalMs: 100,
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 400,
    dialTimeoutMs: 2_000,
    versionOverride: null,
    recoverWithinMs: null,
    log: () => {},
    ...overrides,
  };
}

describe("runCanary", () => {
  it("passes while heartbeats are answered and the hostname relays through its tunnel", async () => {
    const gate = await startFakeGate();
    const result = await runCanary(canaryOptions(gate));
    expect(result.failure).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.probes.ok).toBeGreaterThan(3);
    expect(result.probes.failed).toBe(0);
    expect(result.heartbeats.acked).toBeGreaterThan(3);
  });

  it("fails when the gate stops answering heartbeats", async () => {
    const gate = await startFakeGate({ answerHeartbeats: false });
    const result = await runCanary(canaryOptions(gate));
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("heartbeat");
  });

  it("fails on a 503 from the hostname even though the tunnel is open", async () => {
    const gate = await startFakeGate({ offline: true });
    const result = await runCanary(canaryOptions(gate));
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({
      kind: "probe",
      detail: expect.stringContaining("503 (tunnel offline)"),
    });
  });

  it("fails when the gate refuses the dial", async () => {
    const gate = await startFakeGate();
    const result = await runCanary(
      canaryOptions(gate, { credential: "bbcred_wrong" }),
    );
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({
      kind: "dial",
      detail: expect.stringContaining("HTTP 401"),
    });
  });

  it("fails when the tunnel drops before the hold ends", async () => {
    const gate = await startFakeGate({ closeAfterMs: 300 });
    const result = await runCanary(canaryOptions(gate));
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({
      kind: "closed",
      detail: expect.stringContaining("code 1012"),
    });
  });

  it("redials after a drop and passes once the tunnel serves again within the recovery window", async () => {
    const gate = await startFakeGate({ closeAfterMs: 300 });
    const result = await runCanary(
      canaryOptions(gate, { durationMs: 2_000, recoverWithinMs: 1_500 }),
    );
    expect(result.failure).toBeNull();
    expect(result.recoveries).toHaveLength(1);
    expect(result.recoveries[0]).toBeLessThan(1_500);
    expect(gate.dialHeaders).toHaveLength(2);
  });

  it("fails when a dropped tunnel stays broken past the recovery window", async () => {
    const gate = await startFakeGate({
      closeAfterMs: 300,
      orphanAfterFirstClose: true,
    });
    const result = await runCanary(
      canaryOptions(gate, { durationMs: 4_000, recoverWithinMs: 1_200 }),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.detail).toContain("not recovered within 1200 ms");
    expect(gate.dialHeaders.length).toBeGreaterThan(1);
  });

  it("dials with a minted ticket in ticket mode", async () => {
    const gate = await startFakeGate();
    const result = await runCanary(
      canaryOptions(gate, { mode: "ticket", durationMs: 400 }),
    );
    expect(result.ok).toBe(true);
    expect(gate.dialHeaders[0]?.authorization).toBe(`Bearer ${TICKET}`);
  });

  it("sends the version override on the dial and on every probe", async () => {
    const gate = await startFakeGate();
    const override = 'bb-connect="0000-new"';
    const result = await runCanary(
      canaryOptions(gate, { versionOverride: override, durationMs: 400 }),
    );
    expect(result.ok).toBe(true);
    const header = VERSION_OVERRIDES_HEADER.toLowerCase();
    expect(gate.dialHeaders[0]?.[header]).toBe(override);
    expect(gate.probeHeaders.length).toBeGreaterThan(0);
    expect(gate.probeHeaders.every((headers) => headers[header] === override)).toBe(
      true,
    );
  });
});
