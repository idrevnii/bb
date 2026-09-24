import { z } from "zod";

export const ROLLOUT_PERCENTAGES = [0, 5, 25, 100] as const;

export type RolloutPercentage = (typeof ROLLOUT_PERCENTAGES)[number];

export const deploymentStatusSchema = z.object({
  versions: z
    .array(
      z.object({
        version_id: z.string().min(1),
        percentage: z.number().min(0).max(100),
      }),
    )
    .min(1)
    .max(2),
});

export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;

export interface RolloutPlan {
  versionSpecs: string[];
  stableVersionId: string;
}

export class RolloutPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RolloutPlanError";
  }
}

export function parseRolloutPercentage(raw: string): RolloutPercentage {
  const value = Number(raw);
  const match = ROLLOUT_PERCENTAGES.find((percentage) => percentage === value);
  if (match === undefined) {
    throw new RolloutPlanError(
      `percentage must be one of ${ROLLOUT_PERCENTAGES.join(", ")}`,
    );
  }
  return match;
}

export function planRollout(
  status: DeploymentStatus,
  targetVersionId: string,
  percentage: RolloutPercentage,
): RolloutPlan {
  const others = status.versions.filter(
    (version) => version.version_id !== targetVersionId,
  );
  if (others.length === 0) {
    throw new RolloutPlanError(
      `${targetVersionId} already serves 100% of traffic; there is no older version to split with`,
    );
  }
  if (others.length > 1) {
    throw new RolloutPlanError(
      `the current deployment splits ${others.map((version) => version.version_id).join(" and ")}; finish or roll back that rollout before starting ${targetVersionId}`,
    );
  }
  const stableVersionId = others[0].version_id;
  const versionSpecs =
    percentage === 100
      ? [`${targetVersionId}@100%`]
      : [
          `${targetVersionId}@${percentage}%`,
          `${stableVersionId}@${100 - percentage}%`,
        ];
  return { versionSpecs, stableVersionId };
}
