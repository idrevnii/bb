import { drizzle } from "drizzle-orm/d1";
import { schema } from "@bb/connect-db";
import { markMachineSessionSeen } from "./session.js";
import { MACHINE_CREDENTIAL_HEADER } from "./protocol-headers.js";
import type { Env } from "./tunnel-do.js";

export async function handleMachineSessionPresence(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  const body: unknown = await request.json().catch(() => null);
  if (
    typeof body !== "object" ||
    body === null ||
    !("name" in body) ||
    typeof body.name !== "string" ||
    body.name.trim().length === 0 ||
    body.name.length > 120
  ) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const db = drizzle(env.DB, { schema });
  const credential = request.headers.get(MACHINE_CREDENTIAL_HEADER) ?? "";
  const accepted = await markMachineSessionSeen(
    credential,
    body.name.trim(),
    db,
  );
  if (!accepted) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return new Response(null, { status: 204 });
}
