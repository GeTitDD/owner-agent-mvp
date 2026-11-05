// Pi-compatible extension; no direct dependency on Pi's internals.
// Usage: pi -e /absolute/path/to/domain-context-pi-starter/adapters/pi/extension.mjs
import { createDomainEngine } from '../../src/engine.mjs';

const BEGIN = '<domain_context_extension>';
const END = '</domain_context_extension>';

export async function registerPiDomainContext(pi, options = {}) {
  // Pi uses TypeBox TSchema internally. Use the real schema factory at runtime.
  const Type = options.Type ?? (await import('typebox')).Type;
  // The Pi factory may be invoked without a session; defer opening SQLite until session_start.
  let engine = null;
  let snapshot = null;
  let activeRunId = null;

  // The recorder never stores prompt text, tool arguments or tool results.
  function ensureRun(ctx) {
    if (!snapshot || snapshot.profile.captureMode !== 'metadata') return null;
    if (activeRunId) return activeRunId;
    const manager = ctx.sessionManager;
    const sessionId = manager?.getSessionId?.();
    if (!sessionId) return null;
    const leafId = manager?.getLeafId?.() ?? manager?.getBranch?.()?.at?.(-1)?.id ?? 'unknown';
    activeRunId = engine.evolution.beginRun({
      sessionId, branchLeafId: String(leafId),
      projectId: snapshot.profile.id, projectRoot: snapshot.profile.root, snapshotId: snapshot.projectSnapshotId ?? snapshot.id
    });
    return activeRunId;
  }

  pi.on('session_start', async (_event, ctx) => {
    activeRunId = null;
    engine?.close();
    engine = null;
    snapshot = null;
    if (typeof ctx.isProjectTrusted === 'function' && !ctx.isProjectTrusted()) return;
    engine = createDomainEngine(options);
    snapshot = await engine.resolve({
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager?.getSessionId?.()
    });
  });

  pi.on('agent_start', async (_event, ctx) => { ensureRun(ctx); });

  pi.on('tool_execution_end', async (event, ctx) => {
    const runId = ensureRun(ctx);
    if (!runId || !event?.toolCallId || !event?.toolName) return;
    engine.evolution.recordTool({
      runId,
      toolCallId: String(event.toolCallId),
      toolName: String(event.toolName),
      parentToolCallId: event.parentToolCallId ? String(event.parentToolCallId) : null,
      isError: !!event.isError,
      durationMs: Number.isSafeInteger(event.durationMs) && event.durationMs >= 0 ? event.durationMs : null
    });
  });

  pi.on('agent_settled', async (event, ctx) => {
    const runId = activeRunId;
    if (!runId) return;
    engine.evolution.settleRun(runId, { aborted: !!event?.aborted });
    activeRunId = null;
  });

  pi.on('resources_discover', async () => {
    return snapshot ? { skillPaths: snapshot.skillPaths } : undefined;
  });

  pi.on('before_agent_start', async (event, ctx) => {
    if (!snapshot) return;
    if (event.messageType && event.messageType !== 'user') return;
    if (typeof event.prompt !== 'string' || !event.prompt.trim()) return;
    const plan = engine.compile({ snapshot, task: event.prompt });
    // Current Pi supports structured sections and can patch only changed parts.
    // Check feature at runtime to support earlier Pi versions as well.
    const sections = event.systemPromptOptions?.sections;
    if (sections && typeof sections === 'object') {
      sections.domain_context_stable = plan.stableContext;
      sections.domain_context_task = plan.dynamicContext;
      return;
    }
    // Older Pi: systemPrompt replacement. This is safe but less cache-efficient.
    const original = event.systemPrompt ?? ctx.getSystemPrompt?.() ?? '';
    const trimmed = original.replace(/\n?<domain_context_extension>[\s\S]*?<\/domain_context_extension>/g, '');
    return {
      systemPrompt: `${trimmed}\n\n${BEGIN}\n${plan.stableContext}\n\n${plan.dynamicContext}\n${END}`
    };
  });

  pi.registerTool({
    name: 'domain_recall',
    label: 'Domain Recall',
    description: 'Retrieve applicable, published shared or project-scoped knowledge; inspect verification status before use.',
    promptSnippet: 'Look up domain and project knowledge with provenance and applicability notes',
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 }))
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      if (signal?.aborted) return { content: [{ type: 'text', text: 'Cancelled' }] };
      if (!snapshot) return { content: [{ type: 'text', text: 'No domain-context.json in this project.' }] };
      const records = engine.retrieve({ snapshot, query: params.query, limit: params.limit ?? 5 });
      return {
        content: [{ type: 'text', text: engine.renderEvidence(records) }],
        details: { sharedSnapshotId: snapshot.id, projectSnapshotId: snapshot.projectSnapshotId, knowledgeRefs: records.map((rec) => rec.key), applicability: records.map((rec) => ({key: rec.key, state: rec.applicabilityState})) }
      };
    }
  });

  pi.registerCommand('domain-info', {
    description: 'Show active domain context snapshot and knowledge count',
    handler: async (_args, ctx) => {
      const msg = snapshot
        ? `Domain shared ${snapshot.id.slice(0, 12)} / project ${snapshot.projectSnapshotId.slice(0, 12)} · ${snapshot.profile.id} · ${snapshot.records.length} shared + ${snapshot.projectRecords.length} local records · ${snapshot.skillPaths.length} skills`
        : 'No domain-context.json found for this project.';
      if (ctx.hasUI) ctx.ui.notify(msg, 'info');
      else console.log(msg);
    }
  });

  pi.on('session_shutdown', () => {
    engine?.close();
    engine = null;
    snapshot = null;
    activeRunId = null;
  });
}

export default async function extension(pi) {
  await registerPiDomainContext(pi);
}
