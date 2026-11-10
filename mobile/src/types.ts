export interface Project {
  id: string;
  name: string;
  root?: string;
  domain?: string;
}

export interface Brief {
  oneLiner: string;
  whatItIs: string;
  howToRun: string[];
  modules: Array<{ path?: string; title?: string; detail?: string } | string>;
  verify: { commands?: string[]; criteria?: string[] };
  risks: string[];
  evidence: string[];
  generatedAt?: string;
  stale?: boolean;
}

export interface NextAction {
  title?: string;
  detail?: string;
  label?: string;
  command?: string;
}

export interface Idea {
  id: string;
  title: string;
  body: string;
  status: 'todo' | 'doing' | 'blocked' | 'done' | 'failed' | string;
  source: string;
  createdAt: string;
  updatedAt?: string;
}

export interface KnowledgeCounts {
  experiences?: number;
  pendingHarvest?: number;
  knowledge?: number;
  verified?: number;
  candidates?: number;
  usages?: number;
  sharedKnowledge?: number;
}

export interface DiagramSummary {
  kind: string;
  title: string;
  version: number;
  confidence?: string;
  updatedAt?: string;
}

export interface Overview {
  version: string;
  generatedAt: string;
  projects: Project[];
  activeProjectId: string;
  project: Project | null;
  brief: Brief | null;
  nextAction: NextAction | null;
  knowledge: KnowledgeCounts;
  ideas: Idea[];
  diagrams: DiagramSummary[];
}

export interface ChatResult {
  mode: 'answer' | 'write-request' | 'triage-error' | string;
  summary?: string;
  advice?: string;
  findings?: Array<{ title: string; detail?: string; evidence?: string[] }>;
  questions?: string[];
  capturedIdea?: Idea | null;
  durationMs?: number;
}

export interface PairResult {
  token: string;
  deviceId: string;
  version: string;
}
