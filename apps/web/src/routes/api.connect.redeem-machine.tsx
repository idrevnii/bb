import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  connectApiResponse,
  depsFromEnv,
  redeemMachineCode,
} from "@/server/api";
import { getEnv } from "@/server/env";

export const Route = createFileRoute("/api/connect/redeem-machine")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = z
          .object({
            code: z.string(),
            name: z.string().trim().max(120).optional(),
          })
          .safeParse(await request.json().catch(() => null));
        if (!body.success) {
          return Response.json({ error: "invalid-request" }, { status: 400 });
        }
        const result = await redeemMachineCode(
          depsFromEnv(getEnv()),
          body.data.code,
          body.data.name,
        );
        return connectApiResponse(result);
      },
    },
  },
});
