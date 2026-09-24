import { describe, expect, it } from "vitest";
import {
  RolloutPlanError,
  parseRolloutPercentage,
  planRollout,
} from "../src/plan.js";

const OLD = "6f79c289-9e43-4697-b056-78e31bc3e6ad";
const NEW = "11111111-2222-3333-4444-555555555555";

describe("planRollout", () => {
  it("splits the new version against the one serving 100%", () => {
    expect(
      planRollout({ versions: [{ version_id: OLD, percentage: 100 }] }, NEW, 5),
    ).toEqual({
      versionSpecs: [`${NEW}@5%`, `${OLD}@95%`],
      stableVersionId: OLD,
    });
  });

  it("keeps the new version first when raising its share, so Durable Objects already on it stay there", () => {
    expect(
      planRollout(
        {
          versions: [
            { version_id: OLD, percentage: 95 },
            { version_id: NEW, percentage: 5 },
          ],
        },
        NEW,
        25,
      ),
    ).toEqual({
      versionSpecs: [`${NEW}@25%`, `${OLD}@75%`],
      stableVersionId: OLD,
    });
  });

  it("deploys only the new version at 100%", () => {
    expect(
      planRollout(
        {
          versions: [
            { version_id: NEW, percentage: 25 },
            { version_id: OLD, percentage: 75 },
          ],
        },
        NEW,
        100,
      ),
    ).toEqual({ versionSpecs: [`${NEW}@100%`], stableVersionId: OLD });
  });

  it("supports a 0% smoke step that only version overrides reach", () => {
    expect(
      planRollout({ versions: [{ version_id: OLD, percentage: 100 }] }, NEW, 0)
        .versionSpecs,
    ).toEqual([`${NEW}@0%`, `${OLD}@100%`]);
  });

  it("refuses when the target already serves all traffic", () => {
    expect(() =>
      planRollout({ versions: [{ version_id: NEW, percentage: 100 }] }, NEW, 25),
    ).toThrow(RolloutPlanError);
  });

  it("refuses while two other versions split traffic", () => {
    expect(() =>
      planRollout(
        {
          versions: [
            { version_id: OLD, percentage: 50 },
            { version_id: "third", percentage: 50 },
          ],
        },
        NEW,
        5,
      ),
    ).toThrow(/finish or roll back that rollout/u);
  });
});

describe("parseRolloutPercentage", () => {
  it("accepts only the documented steps", () => {
    expect(parseRolloutPercentage("25")).toBe(25);
    expect(() => parseRolloutPercentage("50")).toThrow(RolloutPlanError);
  });
});
