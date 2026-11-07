import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";

// 只暴露三个工具给模型：读取摘要、列 Job、提交 Job。
// 所有“批准/应用/提交沙箱”操作都不带 tool 声明，只能由 Control UI 的操作员触发。
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
  approvalHash: Type.String()
});

const sandboxSummary = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  status: Type.String(),
  executionStatus: Type.String(),
  testStatus: Type.String(),
  approvalHash: Type.String()
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
    "jobs.list": {
      kind: "query",
      description: "List Owner Agent jobs. Read-only.",
      input: Type.Object({
        projectId: Type.Optional(Type.String({ maxLength: 90 })),
        status: Type.Optional(Type.String({ maxLength: 40 })),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 }))
      }, { additionalProperties: false }),
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
    "job.approve": {
      kind: "action",
      description: "Approve a pending Owner job. UI only; never exposed as a model tool.",
      input: Type.Object({ id: Type.String({ maxLength: 90 }) }, { additionalProperties: false }),
      output: Type.Object({ id: Type.String(), status: Type.String() })
    },
    "patch.list": {
      kind: "query",
      description: "List patch proposals. UI only.",
      input: Type.Object({
        projectId: Type.Optional(Type.String({ maxLength: 90 })),
        status: Type.Optional(Type.String({ maxLength: 40 })),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 }))
      }, { additionalProperties: false }),
      output: Type.Object({ items: Type.Array(patchSummary) })
    },
    "patch.approve": {
      kind: "action",
      description: "Approve and apply a patch proposal using its frozen hash. UI only.",
      input: Type.Object({
        proposalId: Type.String({ maxLength: 90 }),
        hash: Type.String({ maxLength: 64 })
      }, { additionalProperties: false }),
      output: Type.Object({ outcome: Type.String(), status: Type.String() })
    },
    "repair.list": {
      kind: "query",
      description: "List repair cycles. UI only.",
      input: Type.Object({
        projectId: Type.Optional(Type.String({ maxLength: 90 })),
        status: Type.Optional(Type.String({ maxLength: 40 })),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 }))
      }, { additionalProperties: false }),
      output: Type.Object({ items: Type.Array(repairSummary) })
    },
    "repair.approve": {
      kind: "action",
      description: "Approve a frozen repair cycle using its hash. UI only.",
      input: Type.Object({
        cycleId: Type.String({ maxLength: 90 }),
        hash: Type.String({ maxLength: 64 })
      }, { additionalProperties: false }),
      output: Type.Object({ id: Type.String(), status: Type.String() })
    },
    "sandbox.list": {
      kind: "query",
      description: "List sandbox runs. UI only.",
      input: Type.Object({
        projectId: Type.Optional(Type.String({ maxLength: 90 })),
        status: Type.Optional(Type.String({ maxLength: 40 })),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 }))
      }, { additionalProperties: false }),
      output: Type.Object({ items: Type.Array(sandboxSummary) })
    },
    "sandbox.submit": {
      kind: "action",
      description: "Create a pending sandbox run for an applied proposal. UI only.",
      input: Type.Object({
        proposalId: Type.String({ maxLength: 90 }),
        profile: Type.Optional(Type.String({ maxLength: 40 })),
        includePaths: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 50 }))
      }, { additionalProperties: false }),
      output: Type.Object({ id: Type.String(), status: Type.String(), approvalHash: Type.String() })
    },
    "sandbox.approve": {
      kind: "action",
      description: "Approve a pending sandbox run using its snapshot hash. UI only.",
      input: Type.Object({
        runId: Type.String({ maxLength: 90 }),
        hash: Type.String({ maxLength: 64 })
      }, { additionalProperties: false }),
      output: Type.Object({ id: Type.String(), status: Type.String() })
    }
  },
  events: {}
});
