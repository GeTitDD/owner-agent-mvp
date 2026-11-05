// Deterministic, closed-world eligibility checks. These are not evidence that a claim is true.
import { canonical, requireId } from './utils.mjs';

export const APPLICABILITY_VERSION = '1.0.0';
const OPS = new Set(['eq', 'ne', 'contains', 'in']);
const SOURCES = new Set(['environment', 'requirements']);
const SAFE_KEY = /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/;
const MISSING = Symbol('missing');

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
}
function validScalar(value) {
  return value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean';
}
export function validateProjectProfile(project) {
  assertPlainObject(project, 'project');
  const id = requireId(project.id, 'project id');
  const primaryDomain = project.primaryDomain === undefined ? null : requireId(project.primaryDomain, 'primary domain');
  const environment = project.environment ?? {};
  const requirements = project.requirements ?? {};
  const decisions = project.decisions ?? [];
  assertPlainObject(environment, 'environment');
  assertPlainObject(requirements, 'requirements');
  if (!Array.isArray(decisions) || decisions.length > 100) throw new Error('Invalid project decisions');
  for (const field of ['runtime', 'platform']) {
    if (environment[field] !== undefined && (typeof environment[field] !== 'string' || environment[field].length > 120)) throw new Error(`Invalid environment.${field}`);
  }
  for (const field of ['capabilities', 'dependencies', 'properties']) {
    const map = environment[field] ?? {};
    assertPlainObject(map, `environment.${field}`);
    for (const [k, v] of Object.entries(map)) {
      if (!SAFE_KEY.test(k) || !validScalar(v) || (field === 'capabilities' && typeof v !== 'boolean') || (field === 'dependencies' && typeof v !== 'string')) throw new Error(`Invalid environment.${field}.${k}`);
    }
  }
  const ids = requirements.ids ?? [];
  if (!Array.isArray(ids) || ids.length > 100 || ids.some((x) => typeof x !== 'string' || !SAFE_KEY.test(x))) throw new Error('Invalid requirements.ids');
  const constraints = requirements.constraints ?? {};
  assertPlainObject(constraints, 'requirements.constraints');
  for (const [k, v] of Object.entries(constraints)) if (!SAFE_KEY.test(k) || !validScalar(v)) throw new Error(`Invalid requirements.constraints.${k}`);
  const goals = requirements.goals ?? [];
  if (!Array.isArray(goals) || goals.length > 100 || goals.some((x) => typeof x !== 'string' || x.length > 400)) throw new Error('Invalid requirements.goals');
  if (new Set(decisions.map((d) => d?.id)).size !== decisions.length) throw new Error('Duplicate project decision id');
  for (const dec of decisions) {
    assertPlainObject(dec, 'decision');
    requireId(dec.id, 'decision id');
    if (typeof dec.summary !== 'string' || dec.summary.length > 500) throw new Error('Invalid decision summary');
    if (dec.evidenceRefs !== undefined && (!Array.isArray(dec.evidenceRefs) || dec.evidenceRefs.some((x) => typeof x !== 'string' || x.length > 300))) throw new Error('Invalid decision evidenceRefs');
  }
  return {
    id, primaryDomain, notes: String(project.notes ?? ''),
    environment: {
      runtime: environment.runtime ?? null, platform: environment.platform ?? null,
      capabilities: { ...(environment.capabilities ?? {}) },
      dependencies: { ...(environment.dependencies ?? {}) },
      properties: { ...(environment.properties ?? {}) }
    },
    requirements: { ids: [...new Set(ids)].sort(), goals: [...goals], constraints: { ...constraints } },
    decisions: decisions.map((d) => ({ id: d.id, summary: d.summary, rationale: String(d.rationale ?? ''), evidenceRefs: [...(d.evidenceRefs ?? [])] })).sort((a, b) => a.id.localeCompare(b.id))
  };
}

function conditionsFor(record) {
  // v0.2 candidates saved free-text 'applicability' arrays; they are advisory only,
  // never converted to machine-enforced predicates by guessing.
  const applicability = record.applicability;
  if (applicability === undefined || Array.isArray(applicability)) return { requires: [], excludes: [] };
  assertPlainObject(applicability, `applicability for ${record.id}`);
  const requires = applicability.requires ?? [];
  const excludes = applicability.excludes ?? [];
  if (!Array.isArray(requires) || !Array.isArray(excludes) || requires.length + excludes.length > 40) throw new Error('Invalid applicability condition list');
  for (const c of [...requires, ...excludes]) {
    assertPlainObject(c, 'condition');
    if (!SOURCES.has(c.source) || !OPS.has(c.op) || typeof c.path !== 'string' || !c.path.split('.').every((p) => SAFE_KEY.test(p))) throw new Error(`Invalid applicability predicate for ${record.id}`);
    if (c.source === 'environment') {
      if (!/^((runtime|platform)|(capabilities|dependencies|properties)\.[a-zA-Z][a-zA-Z0-9_-]*)$/.test(c.path)) throw new Error(`Unknown applicability path: ${c.path}`);
    } else if (!/^(ids|constraints\.[a-zA-Z][a-zA-Z0-9_-]*)$/.test(c.path)) throw new Error(`Unknown applicability path: ${c.path}`);
    if (!(validScalar(c.value) || Array.isArray(c.value) && c.value.length <= 30 && c.value.every(validScalar))) throw new Error('Invalid applicability value');
    if (c.op === 'in' && !Array.isArray(c.value)) throw new Error('in requires an array value');
  }
  return { requires, excludes };
}
export function validateKnowledgeApplicability(record) { return conditionsFor(record); }
function getValue(profile, c) {
  let node = profile[c.source];
  for (const segment of c.path.split('.')) {
    if (node == null || !Object.hasOwn(node, segment)) return MISSING;
    node = node[segment];
  }
  return node;
}
function evaluate(profile, c) {
  const actual = getValue(profile, c);
  if (actual === MISSING || actual === null) return 'unknown';
  const equal = (a, b) => canonical(a) === canonical(b);
  switch (c.op) {
    case 'eq': return equal(actual, c.value) ? 'yes' : 'no';
    case 'ne': return equal(actual, c.value) ? 'no' : 'yes';
    case 'contains': return Array.isArray(actual) ? actual.some((x) => equal(x, c.value)) ? 'yes' : 'no' : typeof actual === 'string' && typeof c.value === 'string' ? actual.includes(c.value) ? 'yes' : 'no' : 'no';
    case 'in': return c.value.some((x) => equal(x, actual)) ? 'yes' : 'no';
    default: throw new Error('Unsupported condition operator');
  }
}
export function resolveApplicability(record, profile) {
  const { requires, excludes } = conditionsFor(record);
  const checked = [
    ...requires.map((predicate) => ({ type: 'requires', predicate, result: evaluate(profile, predicate) })),
    ...excludes.map((predicate) => ({ type: 'excludes', predicate, result: evaluate(profile, predicate) }))
  ];
  const failed = checked.filter((c) => c.type === 'requires' && c.result === 'no' || c.type === 'excludes' && c.result === 'yes');
  const unknown = checked.filter((c) => c.result === 'unknown');
  const state = failed.length ? 'not_applicable' : unknown.length ? 'needs_verification' : 'applicable';
  return { key: record.key, state, checked, reasons: failed.length ? failed : unknown };
}
export function assessKnowledge(snapshot) {
  const all = [...snapshot.records, ...(snapshot.projectRecords ?? [])];
  const results = new Map(all.map((rec) => [rec.key, resolveApplicability(rec, snapshot.profile)]));
  const byId = new Map();
  for (const rec of all) {
    if (!byId.has(rec.id)) byId.set(rec.id, []);
    byId.get(rec.id).push(rec);
  }
  const conflicts = [];
  const seen = new Set();
  for (const rec of all) {
    for (const targetId of rec.relations?.contradicts ?? []) {
      if ((byId.get(targetId)?.length ?? 0) > 1) throw new Error(`Ambiguous contradiction reference: ${targetId}; use a full knowledge key`);
      const targets = all.filter((x) => x.key === targetId || (x.id === targetId && byId.get(targetId)?.length === 1));
      for (const target of targets) {
        if (rec.key === target.key) continue;
        const a = results.get(rec.key), b = results.get(target.key);
        if (a.state === 'not_applicable' || b.state === 'not_applicable') continue;
        const pair = [rec.key, target.key].sort();
        const id = pair.join(' <> ');
        if (seen.has(id)) continue;
        seen.add(id);
        conflicts.push({ a: pair[0], b: pair[1], state: 'unresolved' });
        a.state = 'conflict'; b.state = 'conflict';
      }
    }
  }
  conflicts.sort((a, b) => a.a.localeCompare(b.a) || a.b.localeCompare(b.b));
  return { results, conflicts };
}
