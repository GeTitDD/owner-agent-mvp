import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";

// 只暴露三个工具给模型：读取摘要、列 Job、提交 Job。
// 审批/应用/沙箱批准不在这里注册：它们由 Control UI 直接带“审批令牌”调用 sidecar，
// 插件后端与模型都拿不到该令牌。
const jobSummary = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  jobType: Type.String(),
  title: Type.String(),
  status: Type.String(),
  createdAt: Type.String()
});

const patchSummary = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  status: Type.String(),
  proposalHash: Type.String(),
  baseSha: Type.String(),
  paths: Type.Array(Type.String())
});

const repairSummary = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  status: Type.String(),
  approvalHash: Type.String(),
  sourceSandboxRunId: Type.String()
});

const sandboxSummary = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  proposalId: Type.String(),
  repairCycleId: Type.String(),
  status: Type.String(),
  executionStatus: Type.String(),
  testStatus: Type.String(),
  approvalHash: Type.String()
});

const projectSummary = Type.Object({
  id: Type.String(),
  name: Type.String(),
  baseSha: Type.String()
});

const taskSummary = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  title: Type.String(),
  status: Type.String()
});

const workerStatus = Type.Object({
  configured: Type.Boolean(),
  running: Type.Boolean(),
  currentKind: Type.String(),
  currentStartedAt: Type.String(),
  lastKind: Type.String(),
  lastOutcome: Type.String(),
  lastError: Type.String(),
  lastAt: Type.String()
});

const statusSummary = Type.Object({
  projectCount: Type.Number(),
  totalJobs: Type.Number(),
  activeJobs: Type.Number(),
  pendingJobApprovals: Type.Number(),
  patchProposals: Type.Number(),
  pendingPatchApprovals: Type.Number(),
  repairCycles: Type.Number(),
  pendingRepairApprovals: Type.Number(),
  sandboxRuns: Type.Number(),
  pendingSandboxApprovals: Type.Number()
});

const listInput = Type.Object({
  projectId: Type.Optional(Type.String({ maxLength: 90 })),
  status: Type.Optional(Type.String({ maxLength: 40 })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 }))
}, { additionalProperties: false });

export const contract = defineFeatureContract({
  pluginId: "owner-agent",
  operations: {
    status: {
      kind: "query",
      description: "Read Owner Agent summary counters.",
      input: Type.Object({}, { additionalProperties: false }),
      output: statusSummary,
      tool: { name: "owner_status", label: "Owner status" }
    },
    "projects.list": {
      kind: "query",
      description: "List Owner projects with their current git base SHA. Read-only.",
      input: Type.Object({}, { additionalProperties: false }),
      output: Type.Object({ items: Type.Array(projectSummary) }),
      tool: { name: "owner_projects", label: "List Owner projects" }
    },
    "tasks.list": {
      kind: "query",
      description: "List Owner tasks for a project. Read-only.",
      input: Type.Object({ projectId: Type.String({ maxLength: 90 }) }, { additionalProperties: false }),
      output: Type.Object({ items: Type.Array(taskSummary) }),
      tool: { name: "owner_tasks", label: "List Owner tasks" }
    },
    "task.create": {
      kind: "action",
      description: "Create an Owner task before submitting a coding job. UI only.",
      input: Type.Object({
        projectId: Type.String({ maxLength: 90 }),
        title: Type.String({ maxLength: 200 })
      }, { additionalProperties: false }),
      output: taskSummary
    },
    "jobs.list": {
      kind: "query",
      description: "List Owner Agent jobs. Read-only.",
      input: listInput,
      output: Type.Object({ items: Type.Array(jobSummary) }),
      tool: { name: "owner_jobs_list", label: "List Owner jobs" }
    },
    "job.create": {
      kind: "action",
      description: "Submit an Owner job. It still requires explicit Owner approval before it runs.",
      input: Type.Object({
        projectId: Type.String({ maxLength: 90 }),
        jobType: Type.String({ maxLength: 40 }),
        title: Type.String({ maxLength: 200 }),
        payloadJson: Type.Optional(Type.String({ maxLength: 4000 })),
        idempotencyKey: Type.String({ maxLength: 89 }),
        ownerTaskId: Type.Optional(Type.String({ maxLength: 90 }))
      }, { additionalProperties: false }),
      output: jobSummary,
      tool: { name: "owner_job_submit", label: "Submit Owner job" }
    },

    // 以下均为 UI 只读查询（不带 tool），用于审批前展示冻结内容。
    "patch.list": {
      kind: "query",
      description: "List patch proposals. UI only.",
      input: listInput,
      output: Type.Object({ items: Type.Array(patchSummary) })
    },
    "patch.detail": {
      kind: "query",
      description: "Read one patch proposal with its frozen diff. UI only.",
      input: Type.Object({ proposalId: Type.String({ maxLength: 90 }) }, { additionalProperties: false }),
      output: Type.Object({
        id: Type.String(),
        projectId: Type.String(),
        status: Type.String(),
        baseSha: Type.String(),
        proposalHash: Type.String(),
        approvedHash: Type.String(),
        paths: Type.Array(Type.String()),
        diff: Type.String(),
        appliedDiff: Type.String(),
        rejectionReason: Type.String()
      })
    },
    "repair.list": {
      kind: "query",
      description: "List repair cycles. UI only.",
      input: listInput,
      output: Type.Object({ items: Type.Array(repairSummary) })
    },
    "repair.detail": {
      kind: "query",
      description: "Read one repair cycle with its frozen scope. UI only.",
      input: Type.Object({ cycleId: Type.String({ maxLength: 90 }) }, { additionalProperties: false }),
      output: Type.Object({
        id: Type.String(),
        projectId: Type.String(),
        status: Type.String(),
        approvalHash: Type.String(),
        repairScope: Type.Array(Type.String()),
        sourceSandboxRunId: Type.String(),
        repairRunId: Type.String(),
        jobId: Type.String(),
        sourceBaseSha: Type.String(),
        contextHash: Type.String(),
        iteration: Type.Number(),
        maxIterations: Type.Number()
      })
    },
    "sandbox.list": {
      kind: "query",
      description: "List sandbox runs. UI only.",
      input: listInput,
      output: Type.Object({ items: Type.Array(sandboxSummary) })
    },
    "sandbox.detail": {
      kind: "query",
      description: "Read one sandbox run with its frozen profile and snapshot. UI only.",
      input: Type.Object({ runId: Type.String({ maxLength: 90 }) }, { additionalProperties: false }),
      output: Type.Object({
        id: Type.String(),
        projectId: Type.String(),
        proposalId: Type.String(),
        status: Type.String(),
        executionStatus: Type.String(),
        testStatus: Type.String(),
        profileId: Type.String(),
        imageDigest: Type.String(),
        profileHash: Type.String(),
        testPlanHash: Type.String(),
        snapshotHash: Type.String(),
        approvalHash: Type.String(),
        includePaths: Type.Array(Type.String())
      })
    },
    "sandbox.submit": {
      kind: "action",
      description: "Create a pending sandbox run for an applied proposal. UI only; the run still needs a hash-bound approval.",
      input: Type.Object({
        proposalId: Type.String({ maxLength: 90 }),
        profile: Type.Optional(Type.String({ maxLength: 40 })),
        includePaths: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 50 }))
      }, { additionalProperties: false }),
      output: Type.Object({ id: Type.String(), status: Type.String(), approvalHash: Type.String() })
    },
    "worker.status": {
      kind: "query",
      description: "Read the Owner worker state. UI only.",
      input: Type.Object({}, { additionalProperties: false }),
      output: workerStatus
    },
    "worker.tick": {
      kind: "action",
      description: "Advance the Owner worker by one approved step. UI only.",
      input: Type.Object({
        projectId: Type.Optional(Type.String({ maxLength: 90 }))
      }, { additionalProperties: false }),
      output: Type.Object({ started: Type.Boolean(), reason: Type.String() })
    },
    "repair.submit": {
      kind: "action",
      description: "Create a repair cycle from a failed sandbox run. UI only.",
      input: Type.Object({
        sandboxRunId: Type.String({ maxLength: 90 })
      }, { additionalProperties: false }),
      output: Type.Object({
        id: Type.String(),
        status: Type.String(),
        approvalHash: Type.String()
      })
    },
    "sandbox.logs": {
      kind: "query",
      description: "Read bounded sandbox test output. UI only.",
      input: Type.Object({ runId: Type.String({ maxLength: 90 }) }, { additionalProperties: false }),
      output: Type.Object({
        stdout: Type.String(),
        stderr: Type.String(),
        result: Type.String()
      })
    },
    "sidecar.info": {
      kind: "query",
      description: "Read the sidecar base URL used by the Control UI. UI only.",
      input: Type.Object({}, { additionalProperties: false }),
      output: Type.Object({
        baseUrl: Type.String(),
        approvalRequired: Type.Boolean(),
        connected: Type.Boolean(),
        error: Type.String()
      })
    }
  },
  events: {}
});
