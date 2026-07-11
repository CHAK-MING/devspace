import { classifyCommand, type InspectionEvidenceKind } from "./command-classifier.js";

export type CheckpointTaskType = "analysis" | "diagnosis" | "code_change";
export type CheckpointStatus = "ready" | "blocked" | "advisory";

export interface CheckpointThresholds {
  analysis: number;
  diagnosis: number;
  codeChange: number;
}

export interface CheckpointEvaluation {
  ready: boolean;
  status: CheckpointStatus;
  blockers: string[];
  warnings: string[];
  requiredActions: string[];
  changedFiles: string[];
  verificationCommands: string[];
  failedVerificationCommands: string[];
  inspectionCount: number;
  inspectionScore: number;
  requiredInspectionScore: number;
  evidenceKinds: string[];
  missingEvidenceKinds: string[];
  reusedRootEvidence: number;
  taskType: CheckpointTaskType;
}

export interface CheckpointManagerOptions {
  requireShowChanges?: boolean;
  thresholds?: Partial<CheckpointThresholds>;
  rootEvidenceTtlMs?: number;
}

export interface CheckpointManager {
  initializeWorkspace(input: {
    workspaceId: string;
    root: string;
    rootKey?: string;
    freshnessKey?: string;
  }): void;
  recordInspection(input: {
    workspaceId: string;
    tool: string;
    path?: string;
    evidenceKind?: InspectionEvidenceKind;
  }): void;
  recordModification(input: { workspaceId: string; tool: string; files: string[] }): void;
  recordShellCommand(input: { workspaceId: string; command: string; success: boolean }): void;
  recordShowChanges(input: { workspaceId: string }): void;
  evaluate(input: {
    workspaceId: string;
    taskType?: CheckpointTaskType;
    verificationSteps?: string[];
  }): CheckpointEvaluation;
  resetTask(input: { workspaceId: string }): void;
}

interface EvidenceRecord {
  key: string;
  kind: InspectionEvidenceKind;
  target: string;
  tool: string;
  at: number;
  workspaceId: string;
  rootKey?: string;
  freshnessKey?: string;
}

interface ShellCommandRecord {
  command: string;
  success: boolean;
  at: number;
  verification: boolean;
}

interface WorkspaceCheckpointState {
  workspaceId: string;
  root: string;
  rootKey?: string;
  freshnessKey?: string;
  openedAt: number;
  inspectionCount: number;
  evidence: EvidenceRecord[];
  modifiedFiles: Set<string>;
  shellCommands: ShellCommandRecord[];
  lastModificationAt?: number;
  lastShowChangesAt?: number;
}

const DEFAULT_THRESHOLDS: CheckpointThresholds = {
  analysis: 4,
  diagnosis: 6,
  codeChange: 8,
};
const DEFAULT_ROOT_EVIDENCE_TTL_MS = 30 * 60 * 1000;

export function createCheckpointManager(
  now: () => number = Date.now,
  options: CheckpointManagerOptions = {},
): CheckpointManager {
  const states = new Map<string, WorkspaceCheckpointState>();
  const rootEvidence = new Map<string, EvidenceRecord[]>();
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...options.thresholds,
  };
  const rootEvidenceTtlMs = options.rootEvidenceTtlMs ?? DEFAULT_ROOT_EVIDENCE_TTL_MS;
  const requireShowChanges = options.requireShowChanges ?? false;

  function ensureState(workspaceId: string): WorkspaceCheckpointState {
    let state = states.get(workspaceId);
    if (!state) {
      const at = now();
      state = {
        workspaceId,
        root: "",
        openedAt: at,
        inspectionCount: 0,
        evidence: [],
        modifiedFiles: new Set(),
        shellCommands: [],
      };
      states.set(workspaceId, state);
    }
    return state;
  }

  function addEvidence(
    state: WorkspaceCheckpointState,
    kind: InspectionEvidenceKind,
    tool: string,
    target: string,
  ): void {
    const normalizedTarget = normalizeTarget(target || tool);
    const key = `${kind}:${tool}:${normalizedTarget}`;
    const evidence: EvidenceRecord = {
      key,
      kind,
      target: normalizedTarget,
      tool,
      at: now(),
      workspaceId: state.workspaceId,
      rootKey: state.rootKey,
      freshnessKey: state.freshnessKey,
    };
    state.evidence.push(evidence);
    if (state.rootKey) {
      const existing = rootEvidence.get(state.rootKey) ?? [];
      existing.push(evidence);
      rootEvidence.set(state.rootKey, pruneRootEvidence(existing, evidence.at, state.freshnessKey));
    }
  }

  function evaluateEvidence(state: WorkspaceCheckpointState): {
    score: number;
    kinds: string[];
    reusedRootEvidence: number;
  } {
    const current = now();
    const records = [...state.evidence];
    const localKeys = new Set(state.evidence.map((record) => record.key));
    let reusedRootEvidence = 0;
    if (state.rootKey) {
      const reusable = pruneRootEvidence(rootEvidence.get(state.rootKey) ?? [], current, state.freshnessKey)
        .filter((record) => record.workspaceId !== state.workspaceId);
      records.push(...reusable);
      reusedRootEvidence = new Set(reusable.map((record) => record.key).filter((key) => !localKeys.has(key))).size;
    }

    const byKey = new Map<string, EvidenceRecord>();
    for (const record of records) byKey.set(record.key, record);
    const unique = [...byKey.values()];
    return {
      score: scoreEvidence(unique),
      kinds: Array.from(new Set(unique.map((record) => record.kind))).sort(),
      reusedRootEvidence,
    };
  }

  function pruneRootEvidence(records: EvidenceRecord[], current: number, freshnessKey: string | undefined): EvidenceRecord[] {
    return records.filter((record) => {
      if (current - record.at > rootEvidenceTtlMs) return false;
      if (freshnessKey && record.freshnessKey && freshnessKey !== record.freshnessKey) return false;
      return true;
    });
  }

  return {
    initializeWorkspace({ workspaceId, root, rootKey, freshnessKey }) {
      const state = states.get(workspaceId);
      if (state) {
        state.root = root;
        state.rootKey = rootKey ?? root;
        state.freshnessKey = freshnessKey;
        return;
      }
      const at = now();
      states.set(workspaceId, {
        workspaceId,
        root,
        rootKey: rootKey ?? root,
        freshnessKey,
        openedAt: at,
        inspectionCount: 0,
        evidence: [],
        modifiedFiles: new Set(),
        shellCommands: [],
      });
    },

    recordInspection({ workspaceId, tool, path, evidenceKind }) {
      const state = states.get(workspaceId);
      if (!state) return;
      state.inspectionCount += 1;
      addEvidence(state, evidenceKind ?? evidenceKindForToolPath(tool, path), tool, path ?? tool);
    },

    recordModification({ workspaceId, files }) {
      const state = states.get(workspaceId);
      if (!state) return;
      for (const file of files) state.modifiedFiles.add(file);
      state.lastModificationAt = now();
    },

    recordShellCommand({ workspaceId, command, success }) {
      const state = states.get(workspaceId);
      if (!state) return;
      const classification = classifyCommand(command);
      const at = now();
      state.shellCommands.push({
        command,
        success,
        at,
        verification: classification.isVerification,
      });
      if (success && classification.kind === "inspection" && classification.evidenceKind) {
        state.inspectionCount += 1;
        addEvidence(state, classification.evidenceKind, "bash", command);
      }
    },

    recordShowChanges({ workspaceId }) {
      const state = states.get(workspaceId);
      if (!state) return;
      state.lastShowChangesAt = now();
    },

    evaluate({ workspaceId, taskType, verificationSteps }) {
      const state = ensureState(workspaceId);
      const changedFiles = Array.from(state.modifiedFiles).sort();
      const hasModifications = changedFiles.length > 0;
      const codeChangeWithoutRecordedModifications = taskType === "code_change" && !hasModifications;
      const resolvedTaskType = codeChangeWithoutRecordedModifications
        ? "analysis"
        : (taskType ?? (hasModifications ? "code_change" : "analysis"));
      const requiredInspectionScore = thresholdFor(resolvedTaskType, thresholds);
      const evidence = evaluateEvidence(state);
      const blockers: string[] = [];
      const warnings: string[] = [];
      const requiredActions: string[] = [];
      if (codeChangeWithoutRecordedModifications) {
        warnings.push("Requested code_change, but this checkpoint has no recorded file modifications; using the analysis threshold.");
      }
      const missingEvidenceKinds = missingKindsFor(resolvedTaskType, evidence.kinds);

      if (evidence.score < requiredInspectionScore) {
        const message = `Insufficient workspace investigation for a substantive ${resolvedTaskType.replace("_", " ")} task: evidence score ${evidence.score}, need ${requiredInspectionScore}.`;
        if (canDowngradeInspectionGap(resolvedTaskType, evidence.score, requiredInspectionScore, hasModifications)) {
          warnings.push(`${message} Proceed only with an explicit uncertainty note.`);
        } else {
          blockers.push(message);
          requiredActions.push(...nextInspectionActions(missingEvidenceKinds, requiredInspectionScore - evidence.score));
        }
      }

      const verification = evaluateVerification(state, verificationSteps, hasModifications);
      if (hasModifications) {
        if (verification.successful.length === 0) {
          blockers.push("Files were modified, but no successful verification command is recorded after the latest relevant modification.");
          requiredActions.push(...recommendedVerificationActions(changedFiles));
        }
        if (requireShowChanges && (!state.lastShowChangesAt || state.lastShowChangesAt < (state.lastModificationAt ?? 0))) {
          blockers.push("Files were modified, but show_changes has not been called after the latest modification.");
          requiredActions.push("Call show_changes exactly once for this workspace before the final response.");
        }
      }

      for (const missing of verification.missingDeclared) {
        blockers.push(`Declared verification step was not found in executed commands: ${missing}`);
        requiredActions.push(`Run the declared verification step or remove it from verificationSteps: ${missing}`);
      }
      for (const failed of verification.failedDeclared) {
        blockers.push(`Declared verification step failed: ${failed}`);
        requiredActions.push(`Fix the failure and rerun: ${failed}`);
      }

      const status: CheckpointStatus = blockers.length === 0
        ? (warnings.length > 0 ? "advisory" : "ready")
        : "blocked";

      return {
        ready: blockers.length === 0,
        status,
        blockers,
        warnings,
        requiredActions: Array.from(new Set(requiredActions)).slice(0, 6),
        changedFiles,
        verificationCommands: verification.successful,
        failedVerificationCommands: verification.failed,
        inspectionCount: state.inspectionCount,
        inspectionScore: evidence.score,
        requiredInspectionScore,
        evidenceKinds: evidence.kinds,
        missingEvidenceKinds,
        reusedRootEvidence: evidence.reusedRootEvidence,
        taskType: resolvedTaskType,
      };
    },

    resetTask({ workspaceId }) {
      const state = states.get(workspaceId);
      if (!state) return;
      state.inspectionCount = 0;
      state.evidence = [];
      state.modifiedFiles.clear();
      state.shellCommands = [];
      state.lastModificationAt = undefined;
      state.lastShowChangesAt = undefined;
    },
  };
}

function thresholdFor(taskType: CheckpointTaskType, thresholds: CheckpointThresholds): number {
  switch (taskType) {
    case "analysis":
      return thresholds.analysis;
    case "diagnosis":
      return thresholds.diagnosis;
    case "code_change":
      return thresholds.codeChange;
  }
}

function evidenceKindForToolPath(tool: string, path: string | undefined): InspectionEvidenceKind {
  if (tool === "grep" || tool === "glob") return "targeted-search";
  if (tool === "ls") return "directory-inspected";
  if (path && /(^|\/)(test|tests|__tests__)\b|\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return "test-file-read";
  if (path && /(^|\/)(package\.json|tsconfig|vite\.config|\.env|config|docs)\b/.test(path)) return "config-inspected";
  return "source-file-read";
}

function normalizeTarget(target: string): string {
  return target.trim().replace(/\\/g, "/").replace(/\s+/g, " ");
}

function scoreEvidence(records: EvidenceRecord[]): number {
  let score = 0;
  const perKind = new Map<InspectionEvidenceKind, number>();
  for (const record of records) {
    const used = perKind.get(record.kind) ?? 0;
    const cap = scoreCapForKind(record.kind);
    if (used >= cap) continue;
    perKind.set(record.kind, used + 1);
    score += 1;
  }
  return score;
}

function scoreCapForKind(kind: InspectionEvidenceKind): number {
  switch (kind) {
    case "source-file-read":
      return 4;
    case "targeted-search":
      return 3;
    case "test-file-read":
    case "runtime-log-inspected":
    case "config-inspected":
    case "directory-inspected":
      return 2;
  }
}

function missingKindsFor(taskType: CheckpointTaskType, evidenceKinds: string[]): string[] {
  const kinds = new Set(evidenceKinds);
  const missing: string[] = [];
  if (!kinds.has("source-file-read") && !kinds.has("targeted-search")) missing.push("source-or-search-evidence");
  if (taskType === "diagnosis" && !kinds.has("runtime-log-inspected") && !kinds.has("config-inspected")) {
    missing.push("runtime-or-config-evidence");
  }
  if (taskType === "code_change" && !kinds.has("test-file-read") && !kinds.has("targeted-search")) {
    missing.push("test-or-callsite-evidence");
  }
  return missing;
}

function canDowngradeInspectionGap(
  taskType: CheckpointTaskType,
  score: number,
  required: number,
  hasModifications: boolean,
): boolean {
  if (hasModifications || taskType === "code_change") return false;
  return score > 0 && required - score <= 1;
}

function nextInspectionActions(missingEvidenceKinds: string[], remainingScore: number): string[] {
  const actions: string[] = [];
  if (missingEvidenceKinds.includes("source-or-search-evidence")) {
    actions.push("Read the most relevant source file or run a targeted search for the symbol, route, or rule being evaluated.");
  }
  if (missingEvidenceKinds.includes("runtime-or-config-evidence")) {
    actions.push("Inspect relevant runtime logs, service status, or configuration before diagnosing the issue.");
  }
  if (missingEvidenceKinds.includes("test-or-callsite-evidence")) {
    actions.push("Inspect related tests, call sites, or search results for the modified behavior.");
  }
  actions.push(`Collect ${remainingScore} more point(s) of distinct investigation evidence.`);
  return actions.slice(0, 3);
}

function evaluateVerification(
  state: WorkspaceCheckpointState,
  verificationSteps: string[] | undefined,
  hasModifications: boolean,
): {
  successful: string[];
  failed: string[];
  missingDeclared: string[];
  failedDeclared: string[];
} {
  const minAt = hasModifications ? (state.lastModificationAt ?? 0) : 0;
  const verificationCommands = state.shellCommands
    .filter((command) => command.verification && command.at >= minAt);
  const successful = verificationCommands
    .filter((command) => command.success)
    .map((command) => command.command);
  const failed = verificationCommands
    .filter((command) => !command.success)
    .map((command) => command.command);
  const missingDeclared: string[] = [];
  const failedDeclared: string[] = [];

  for (const step of verificationSteps ?? []) {
    const matching = state.shellCommands.filter((command) => commandMatches(command.command, step));
    if (matching.length === 0) {
      missingDeclared.push(step);
      continue;
    }
    if (!matching.some((command) => command.success)) failedDeclared.push(step);
    if (matching.some((command) => command.success) && !successful.some((command) => commandMatches(command, step))) {
      successful.push(step);
    }
  }

  return {
    successful: Array.from(new Set(successful)),
    failed: Array.from(new Set(failed)),
    missingDeclared,
    failedDeclared,
  };
}

function commandMatches(actual: string, expected: string): boolean {
  const normalizedActual = normalizeCommandForMatch(actual);
  const normalizedExpected = normalizeCommandForMatch(expected);
  return normalizedActual.includes(normalizedExpected) || normalizedExpected.includes(normalizedActual);
}

function normalizeCommandForMatch(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

function recommendedVerificationActions(changedFiles: string[]): string[] {
  if (changedFiles.some((file) => file.endsWith(".ts") || file.endsWith(".tsx"))) {
    return ["Run npm run typecheck and the relevant test command for the changed TypeScript files."];
  }
  if (changedFiles.some((file) => file.endsWith(".md"))) {
    return ["Run the relevant documentation or specification validation command for the changed Markdown files."];
  }
  return ["Run the relevant tests, linter, type-check, build, or validation command for the modified files."];
}
