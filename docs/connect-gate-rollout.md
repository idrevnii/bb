# Rolling out the bb connect gate

The gate (`apps/connect`, worker `bb-connect` on `*.getbb.app`) carries every
remote session, so it never goes to 100% in one step. Every gate change
follows this procedure.

## Every deployment disconnects every tunnel

On 2026-09-24 a gate deployment stopped tunnels for many servers for 36
minutes: dials succeeded, heartbeats went unanswered, visitors got 503, and
each server redialed every 60–80 seconds until the gate was rolled back. The
new version's code was not the cause. On staging, redeploying the unchanged
previous version while tunnels were connected did the same thing, every time:

- Every `wrangler deploy` and `wrangler versions deploy`, including a `0%`
  split and a redeploy of the same version, orphans the hibernated tunnel
  WebSockets. The bb keeps an open socket that nothing answers, and the
  Durable Object answers visitors with 503 because it has no tunnel.
- While the object keeps receiving requests (the bb redialing, visitors
  retrying), every new tunnel dial into it is orphaned the same way. Some
  objects instead fail every request with `Network connection lost.`
- An object that receives no requests for about 45 seconds recovers. Busy
  servers never go quiet, which is why production stayed down until the
  rollback.
- `wrangler rollback` behaved differently in every case we saw. It closed
  connected tunnels at once and they redialed cleanly. That held for the
  production rollback on 2026-09-24 and three staging rollbacks, one to a
  gate without the restart below and one to a version that had never been
  deployed. We don't know why.

`TunnelDO` now records when its tunnel opens and closes. When a visitor
request, a tunnel dial, or the 50-second presence alarm finds no live tunnel
socket although the last one never closed, it saves a close and calls
`ctx.abort()`. The restarted object closes the orphaned socket, the bb redials
at once, and the tunnel is back within seconds. On staging a redeploy under
load cost each tunnel about 5–10 seconds with this change, where it had cost
them indefinitely without it. Objects from before this change, which only
record `serverId` or `machineId`, are restarted once the same way.

This is a Cloudflare platform problem worth a support ticket. The staging
reproduction, with timestamps and object IDs, is in the pull request that
added this section.

## How Cloudflare splits a Worker with Durable Objects

A gradual deployment serves two versions at once. The gate worker and its
`TunnelDO` class live in one script, and the two halves split differently:

- **Requests to the worker entrypoint are assigned per request.** Each request
  is routed to a version at random according to the percentages, unless it
  carries a `Cloudflare-Workers-Version-Key` header (version affinity).
  Consecutive dials from the same bb can hit different versions. The tunnel
  ticket check runs here, before the Durable Object.
- **Each Durable Object is pinned to one version per deployment.** Cloudflare
  assigns every object a version from the percentages; all requests to that
  object use it until the next deployment. Raising the new version's share
  with the versions listed in the same order never moves an object back, and
  an object is reset only when its version changes, so each tunnel reconnects
  once per step it moves in.
- **`Cloudflare-Workers-Version-Overrides: bb-connect="<version-id>"`** sends a
  request to a specific version in the current deployment, including one at
  0%. It applies to the entrypoint; the Durable Object still runs its assigned
  version.
- Versions that change a Durable Object class lifecycle (the `migrations`
  array) can't be uploaded. Ship those with `wrangler deploy`, alone.
- Rollback (`wrangler rollback <version-id>`) replaces a split deployment with
  one version at 100% immediately. Only the 100 most recent versions can be
  deployed or rolled back to.

Sources: Cloudflare's [gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/),
[with Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/),
[version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/),
and [rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

Because the ticket path isn't pinned per object, it is behind a flag:
`TUNNEL_TICKETS` in `apps/connect/wrangler.jsonc`. When it isn't `"on"` the
gate refuses tickets with 401 and bb falls back to its raw credential (see
`plugins/connect/README.md`). Ship gate code with the flag off, and turn it on
later in its own one-line change that goes through the same steps.

## Steps

The first version that contains the tunnel restart goes straight to 100%,
without the 0% smoke: at any share below 100% the objects stay on the old
version, which cannot restart orphaned tunnels, so busy servers would stay
down until the next step. Ship it with
`pnpm exec wrangler rollback <new-version-id> -m "<reason>"`, which put a
never-deployed version live on staging and closed every tunnel cleanly. Then
run the canary by hand. `percentage: 100` in the workflow also works: it
orphans the tunnels, and the new code restarts them within seconds.
Every later gate change uses all the steps below, and each step costs every
connected tunnel a few seconds.

1. **Merge.** `Deploy Connect (upload only)` applies pending connect-db
   migrations and runs `wrangler versions upload`. The new version serves no
   traffic. Its ID is in the run summary and in
   `pnpm --filter @bb/connect exec wrangler versions list`.
2. **Smoke at 0%.** Run **Roll out Connect gate** with the version ID and
   `percentage: 0`. It deploys `<new>@0% <old>@100%` and runs the canary
   through a version override. No real traffic reaches the new version.
3. **5%, then 25%, then 100%.** Run the workflow again for each step. Hold 15
   to 30 minutes at 5% and 25% and check the signals below before moving on.
   Each run connects the canary before deploying, so it has a tunnel open
   when the deployment lands, like every real server. The canary must be
   answering heartbeats and serving its hostname again within 120 seconds and
   then hold for `canary_minutes`. If it doesn't, the workflow rolls back to
   the previous version (unless `auto_rollback` is off).
4. **Tickets.** Once the code has served 100% for a day, change
   `TUNNEL_TICKETS` to `"on"` in the production `vars` and roll that version
   out the same way, with `ticket_canary` checked.

The workflow refuses to start a new version while a different split is still
deployed; finish or roll back the old one first. Add `--env staging` (or pick
`staging` in the workflow) to rehearse on `bb-connect-staging`.

By hand, the same step is:

```sh
cd apps/connect
pnpm exec wrangler deployments status --json          # the version serving traffic now
pnpm exec wrangler versions deploy <new>@5% <old>@95% --yes --message "gate <new> to 5%"
```

## What to watch at each step

- **Canary.** The workflow's canary holds a tunnel as a dedicated server,
  sends a heartbeat every 10 seconds, and fetches its own hostname every 5
  seconds. With `--recover-within`, it treats a heartbeat unanswered for 15
  seconds, a 503, or a dropped tunnel as a disconnect and redials. It fails
  if it isn't back within the window. Without the flag, any of those fails it
  at once.
- **503s per host** (zone `getbb.app`, `d1d0008731a858c96e3cd4013d720ce6`).
  Compare the same window before the step. A normal step shows one reconnect
  burst that settles within 5 minutes, and a steady 7–10% 503 share across
  `*.getbb.app`.

  ```graphql
  query ($zone: String!, $since: Time!, $until: Time!) {
    viewer { zones(filter: { zoneTag: $zone }) {
      httpRequestsAdaptiveGroups(limit: 50, orderBy: [count_DESC], filter: {
        datetime_geq: $since, datetime_leq: $until,
        clientRequestHTTPHost_like: "%.getbb.app", edgeResponseStatus: 503
      }) { count dimensions { clientRequestHTTPHost } }
    } }
  }
  ```

  For the share over time, drop the status filter and group by
  `datetimeFiveMinutes` and `edgeResponseStatus`.
- **Durable Object outcomes** (account `7bb84c630057dafa53e2aacbe6bd094f`).
  `clientDisconnected` ran about 200 per 5 minutes before the incident and
  about 1,250 during it.

  ```graphql
  query ($account: String!, $since: Time!, $until: Time!) {
    viewer { accounts(filter: { accountTag: $account }) {
      durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: {
        scriptName: "bb-connect", datetime_geq: $since, datetime_leq: $until
      }) { sum { requests } dimensions { datetimeFiveMinutes status } }
    } }
  }
  ```

  Add `objectId` to the dimensions to see whether one object dominates.
- **A real server.** `grep 'plugin:connect\] tunnel' ~/.bb/logs/server-stdio.log`
  shows each dial, how it authenticated, and any `tunnel heartbeat missed`.

Send the queries to `https://api.cloudflare.com/client/v4/graphql` with a
token that can read analytics, for example the wrangler OAuth token in
`~/.config/.wrangler/config/default.toml`.

## Rollback

```sh
cd apps/connect
pnpm exec wrangler rollback <previous-version-id> -m "<reason>"              # production
pnpm exec wrangler rollback <previous-version-id> --env staging -m "<reason>"
```

The workflow's summary prints the previous version for each step. Rolling back
never locks a bb out: bb builds with bb account dial with the raw credential
whenever the gate refuses their ticket. `wrangler rollback` closed connected
tunnels cleanly in every case we saw, including a rollback to a gate without
the tunnel restart, so it's the tool to reach for in an emergency. Never
"roll back" with `wrangler versions deploy <old>@100%`: that orphans tunnels
like any other deployment.

## Canary setup

The canary needs its own server on the account it runs under, because every
dial replaces the tunnel already open on that label. Create a server on the
getbb.app dashboard (for example `bb-canary`), create a pairing code for it,
and redeem the code from a checkout:

```sh
pnpm --silent --filter @bb/connect-rollout run rollout redeem --code <CODE> --api-base-url https://getbb.app
```

Store the printed values as the `CONNECT_CANARY_SERVER_URL` repository variable
and the `CONNECT_CANARY_CREDENTIAL` secret (`CONNECT_CANARY_STAGING_*` for
staging). To run it by hand, for example after a manual rollback:

```sh
CONNECT_CANARY_CREDENTIAL=<credential> pnpm --silent --filter @bb/connect-rollout run rollout canary \
  --server-url https://bb-canary.getbb.app --minutes 10 \
  [--mode ticket] [--version-override 'bb-connect="<version-id>"']
```
