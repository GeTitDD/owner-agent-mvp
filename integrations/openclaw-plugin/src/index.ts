import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { contract } from "./contract.js";
import { encodeId, OwnerSidecarClient, type OwnerSidecarConfig } from "./client.js";

const num = (value: unknown): number => (typeof value === "number" ? value : 0);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

const mapJob = (job: any) => ({
  id: String(job.id),
  projectId: String(job.project_id),
  jobType: String(job.job_type),
  title: String(job.title),
  status: String(job.status),
  createdAt: String(job.created_at)
});

const mapPatch = (patch: any) => ({
  id: String(patch.id),
  projectId: String(patch.project_id),
  status: String(patch.status),
  proposalHash: String(patch.proposal_hash),
  baseSha: String(patch.base_sha),
  paths: Array.isArray(patch.files) ? patch.files.map((file: any) => String(file.path)) : []
});

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  return search.toString();
};

const parsePayload = (json?: string): Record<string, unknown> => {
  if (!json) return {};
  const value = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("payloadJson must be a JSON object");
  }
  return value as Record<string, unknown>;
};

export default defineFeaturePlugin({
  contract,
  name: "Owner Agent",
  description: "Read Owner jobs and review frozen patches, sandbox runs and repair cycles.",
  setup(api) {
    const fromPlugin = (api.pluginConfig ?? {}) as OwnerSidecarConfig;
    const config: OwnerSidecarConfig = {
      baseUrl: fromPlugin.baseUrl ?? process.env.OWNER_AGENT_SIDECAR_URL,
      token: fromPlugin.token ?? process.env.OWNER_AGENT_SIDECAR_TOKEN,
      tokenFile: fromPlugin.tokenFile ?? process.env.OWNER_AGENT_SIDECAR_TOKEN_FILE,
      operatorId: fromPlugin.operatorId ?? process.env.OWNER_AGENT_OPERATOR_ID
    };
    let client: OwnerSidecarClient | null = null;
    const owner = (): OwnerSidecarClient => {
      client ??= new OwnerSidecarClient({
        baseUrl: config.baseUrl,
        token: config.token,
        tokenFile: config.tokenFile,
        operatorId: config.operatorId,
        pluginVersion: "0.2.0"
      });
      return client;
    };

    return {
      // ---- 模型可见：只读 + 提交（提交后仍需 Owner 批准）----
      status: async () => {
        const summary = await owner().get("/owner/v1/summary");
        return {
          projectCount: num(summary.projectCount),
          totalJobs: num(summary.totalJobs),
          activeJobs: num(summary.activeJobs),
          pendingJobApprovals: num(summary.pendingJobApprovals),
          patchProposals: num(summary.patchProposals),
          pendingPatchApprovals: num(summary.pendingPatchApprovals),
          repairCycles: num(summary.repairCycles),
          pendingRepairApprovals: num(summary.pendingRepairApprovals),
          sandboxRuns: num(summary.sandboxRuns),
          pendingSandboxApprovals: num(summary.pendingSandboxApprovals)
        };
      },
      "jobs.list": async ({ projectId, status, limit }: {
        projectId?: string;
        status?: string;
        limit?: number;
      }) => {
        const params = query({ projectId, status, limit: limit ?? 50 });
        const payload = await owner().get(`/owner/v1/jobs?${params}`);
        return { items: (payload.items ?? []).map(mapJob) };
      },
      "job.create": async (input: {
        projectId: string;
        jobType: string;
        title: string;
        payloadJson?: string;
        idempotencyKey: string;
        ownerTaskId?: string;
      }) => {
        const job = await owner().post("/owner/v1/jobs", {
          projectId: input.projectId,
          jobType: input.jobType,
          title: input.title,
          payload: parsePayload(input.payloadJson),
          idempotencyKey: input.idempotencyKey,
          ...(input.ownerTaskId ? { ownerTaskId: input.ownerTaskId } : {})
        });
        return mapJob(job);
      },

      // ---- UI 只读：审批前展示冻结内容 ----
      "patch.list": async ({ projectId, status, limit }: {
        projectId?: string;
        status?: string;
        limit?: number;
      }) => {
        const params = query({ projectId, status, limit: limit ?? 50 });
        const payload = await owner().get(`/owner/v1/patches?${params}`);
        return { items: (payload.items ?? []).map(mapPatch) };
      },
      "patch.detail": async ({ proposalId }: { proposalId: string }) => {
        const proposal = await owner().get(`/owner/v1/patches/${encodeId(proposalId)}?content=1`);
        return {
          id: String(proposal.id),
          projectId: String(proposal.project_id),
          status: String(proposal.status),
          baseSha: String(proposal.base_sha),
          proposalHash: String(proposal.proposal_hash),
          approvedHash: text(proposal.approved_hash),
          paths: Array.isArray(proposal.files)
            ? proposal.files.map((file: any) => String(file.path))
            : [],
          diff: text(proposal.proposal_diff),
          appliedDiff: text(proposal.applied_diff),
          rejectionReason: text(proposal.reject_reason ?? proposal.rejection_reason)
        };
      },
      "repair.list": async ({ projectId, status, limit }: {
        projectId?: string;
        status?: string;
        limit?: number;
      }) => {
        const params = query({ projectId, status, limit: limit ?? 50 });
        const payload = await owner().get(`/owner/v1/repair-cycles?${params}`);
        return {
          items: (payload.items ?? []).map((cycle: any) => ({
            id: String(cycle.id),
            projectId: String(cycle.project_id),
            status: String(cycle.status),
            approvalHash: String(cycle.approval_hash)
          }))
        };
      },
      "repair.detail": async ({ cycleId }: { cycleId: string }) => {
        const cycle = await owner().get(`/owner/v1/repair-cycles/${encodeId(cycleId)}`);
        return {
          id: String(cycle.id),
          projectId: String(cycle.project_id),
          status: String(cycle.status),
          approvalHash: String(cycle.approval_hash),
          repairScope: Array.isArray(cycle.repair_scope)
            ? cycle.repair_scope.map(String)
            : Array.isArray(cycle.repairScope)
              ? cycle.repairScope.map(String)
              : [],
          sourceSandboxRunId: String(cycle.source_sandbox_run_id),
          sourceBaseSha: String(cycle.source_base_sha),
          contextHash: String(cycle.context_hash),
          iteration: num(cycle.iteration),
          maxIterations: num(cycle.max_iterations)
        };
      },
      "sandbox.list": async ({ projectId, status, limit }: {
        projectId?: string;
        status?: string;
        limit?: number;
      }) => {
        const params = query({ projectId, status, limit: limit ?? 50 });
        const payload = await owner().get(`/owner/v1/sandbox-runs?${params}`);
        return {
          items: (payload.items ?? []).map((run: any) => ({
            id: String(run.id),
            projectId: String(run.project_id),
            status: String(run.status),
            executionStatus: text(run.execution_status),
            testStatus: text(run.test_status),
            approvalHash: String(run.approval_hash)
          }))
        };
      },
      "sandbox.detail": async ({ runId }: { runId: string }) => {
        const run = await owner().get(`/owner/v1/sandbox-runs/${encodeId(runId)}`);
        const profile = (run.profile ?? {}) as Record<string, unknown>;
        return {
          id: String(run.id),
          projectId: String(run.project_id),
          proposalId: String(run.proposal_id),
          status: String(run.status),
          executionStatus: text(run.execution_status),
          testStatus: text(run.test_status),
          profileId: text(profile.id),
          imageDigest: text(profile.imageDigest),
          profileHash: text(profile.profileHash),
          testPlanHash: text(profile.testPlanHash),
          snapshotHash: String(run.snapshot_hash),
          approvalHash: String(run.approval_hash),
          includePaths: Array.isArray(run.includePaths) ? run.includePaths.map(String) : []
        };
      },
      "sandbox.submit": async (input: {
        proposalId: string;
        profile?: string;
        includePaths?: string[];
      }) => {
        const run = await owner().post("/owner/v1/sandbox-runs", {
          proposalId: input.proposalId,
          ...(input.profile ? { profile: input.profile } : {}),
          ...(input.includePaths ? { includePaths: input.includePaths } : {})
        });
        return {
          id: String(run.id),
          status: String(run.status),
          approvalHash: String(run.approval_hash ?? run.approvalHash ?? "")
        };
      },
      "sidecar.info": async () => ({
        baseUrl: owner().getBaseUrl(),
        approvalRequired: true
      })
    };
  }
});
