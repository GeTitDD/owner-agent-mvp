import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { contract } from "./contract.js";
import { encodeId, OwnerSidecarClient, type OwnerSidecarConfig } from "./client.js";

const num = (value: unknown): number => (typeof value === "number" ? value : 0);

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
  description: "Read Owner jobs and approve patches, repair cycles and sandbox runs.",
  setup(api) {
    // Feature Plugin 的 configSchema 由宿主生成（无法自定义），因此 PoC 用环境变量配置。
    // api.pluginConfig 仍然优先，方便未来宿主支持后再切换。
    const fromPlugin = (api.pluginConfig ?? {}) as OwnerSidecarConfig;
    const config: OwnerSidecarConfig = {
      baseUrl: fromPlugin.baseUrl ?? process.env.OWNER_AGENT_SIDECAR_URL,
      token: fromPlugin.token ?? process.env.OWNER_AGENT_SIDECAR_TOKEN,
      tokenFile: fromPlugin.tokenFile ?? process.env.OWNER_AGENT_SIDECAR_TOKEN_FILE,
      operatorId: fromPlugin.operatorId ?? process.env.OWNER_AGENT_OPERATOR_ID
    };
    // 延迟创建：Owner sidecar 没起时不要拖垮 OpenClaw 的插件加载。
    let client: OwnerSidecarClient | null = null;
    const owner = (): OwnerSidecarClient => {
      client ??= new OwnerSidecarClient({
        baseUrl: config.baseUrl,
        token: config.token,
        tokenFile: config.tokenFile,
        operatorId: config.operatorId,
        pluginVersion: "0.1.0"
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

      // ---- 仅 Control UI 可达：不带 tool 声明 ----
      "job.approve": async ({ id }: { id: string }) => {
        const job = await owner().post(`/owner/v1/jobs/${encodeId(id)}/approve`);
        return { id: String(job.id), status: String(job.status) };
      },
      "patch.list": async ({ projectId, status, limit }: {
        projectId?: string;
        status?: string;
        limit?: number;
      }) => {
        const params = query({ projectId, status, limit: limit ?? 50 });
        const payload = await owner().get(`/owner/v1/patches?${params}`);
        return { items: (payload.items ?? []).map(mapPatch) };
      },
      "patch.approve": async ({ proposalId, hash }: { proposalId: string; hash: string }) => {
        const result = await owner().post(
          `/owner/v1/patches/${encodeId(proposalId)}/approve`,
          { hash }
        );
        return {
          outcome: String(result.outcome ?? "applied"),
          status: String(result.proposal?.status ?? "")
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
      "repair.approve": async ({ cycleId, hash }: { cycleId: string; hash: string }) => {
        const cycle = await owner().post(
          `/owner/v1/repair-cycles/${encodeId(cycleId)}/approve`,
          { hash }
        );
        return { id: String(cycle.id), status: String(cycle.status) };
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
            executionStatus: String(run.execution_status ?? ""),
            testStatus: String(run.test_status ?? ""),
            approvalHash: String(run.approval_hash)
          }))
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
      "sandbox.approve": async ({ runId, hash }: { runId: string; hash: string }) => {
        const run = await owner().post(
          `/owner/v1/sandbox-runs/${encodeId(runId)}/approve`,
          { hash }
        );
        return { id: String(run.id), status: String(run.status) };
      }
    };
  }
});
