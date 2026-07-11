export type CommandKind = "inspection" | "verification" | "potential_mutation" | "unknown";
export type CommandConfidence = "high" | "medium" | "low";
export type InspectionEvidenceKind =
  | "source-file-read"
  | "test-file-read"
  | "targeted-search"
  | "runtime-log-inspected"
  | "config-inspected"
  | "directory-inspected";

export interface CommandClassification {
  kind: CommandKind;
  confidence: CommandConfidence;
  isReadOnly: boolean;
  isVerification: boolean;
  evidenceKind?: InspectionEvidenceKind;
  reasons: string[];
}

export function classifyCommand(command: string): CommandClassification {
  const normalized = normalizeCommand(command);
  if (!normalized) return unknown("empty command");

  const mutationReason = mutationReasonFor(normalized);
  if (mutationReason) {
    return {
      kind: "potential_mutation",
      confidence: "medium",
      isReadOnly: false,
      isVerification: false,
      reasons: [mutationReason],
    };
  }

  const verificationReason = verificationReasonFor(normalized);
  if (verificationReason) {
    return {
      kind: "verification",
      confidence: "high",
      isReadOnly: false,
      isVerification: true,
      reasons: [verificationReason],
    };
  }

  const inspection = inspectionReasonFor(normalized);
  if (inspection) {
    return {
      kind: "inspection",
      confidence: "high",
      isReadOnly: true,
      isVerification: false,
      evidenceKind: inspection.evidenceKind,
      reasons: [inspection.reason],
    };
  }

  return unknown("command did not match known verification or read-only inspection patterns");
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

function unknown(reason: string): CommandClassification {
  return {
    kind: "unknown",
    confidence: "low",
    isReadOnly: false,
    isVerification: false,
    reasons: [reason],
  };
}

function mutationReasonFor(command: string): string | undefined {
  if (/(^|\s)(>|>>|2>|2>>|&>)\s*\S+/.test(command)) return "shell output redirection may write files";
  if (/\b(tee|sed\s+-i|perl\s+-i)\b/.test(command)) return "command uses a known file-writing helper";
  if (/(^|[;&|]\s*)(rm|mv|cp|touch|mkdir|rmdir|chmod|chown|git\s+commit|git\s+push|npm\s+publish)\b/.test(command)) {
    return "command starts a known mutating operation";
  }
  return undefined;
}

function verificationReasonFor(command: string): string | undefined {
  if (/\b(npm|pnpm|yarn)\s+(run\s+)?(test|typecheck|lint|check|verify|validate)\b/.test(command)) {
    return "package-manager verification script";
  }
  if (/\b(npm|pnpm|yarn)\s+(test|lint)\b/.test(command)) return "package-manager verification command";
  if (/\b(npx\s+)?tsc\b/.test(command) && /--noemit\b|--no-emit\b/.test(command)) {
    return "TypeScript no-emit compile verification";
  }
  if (/\b(tsx|node)\b.*\.(test|spec)\.[cm]?[jt]sx?\b/.test(command)) return "direct JavaScript or TypeScript test file execution";
  if (/\b(vitest|jest|mocha|ava|pytest|ruff\s+check|mypy|go\s+test|cargo\s+test|cargo\s+check|gradle\s+test|mvn\s+test)\b/.test(command)) {
    return "known language or framework verification command";
  }
  if (/\b(openspec\s+validate|validate|typecheck|staticcheck|compile-check)\b/.test(command)) {
    return "known validate/check command";
  }
  if (/\bgit\s+diff\s+--check\b/.test(command)) return "git whitespace validation";
  return undefined;
}

function inspectionReasonFor(command: string): { reason: string; evidenceKind: InspectionEvidenceKind } | undefined {
  if (/\b(journalctl|dmesg|docker\s+logs|systemctl\s+(status|show))\b/.test(command)) {
    return { reason: "runtime or service diagnostic command", evidenceKind: "runtime-log-inspected" };
  }
  if (/\b(env|printenv|which|whereis|type|npm\s+ls|pip\s+(list|show))\b/.test(command)) {
    return { reason: "configuration or environment inspection command", evidenceKind: "config-inspected" };
  }
  if (/\b(grep|egrep|fgrep|rg|ag|find|fd|fdfind|git\s+(grep|log|show|blame|branch|ls-files))\b/.test(command)) {
    return { reason: "targeted search or git inspection command", evidenceKind: "targeted-search" };
  }
  if (/\b(ls|ll|tree)\b/.test(command)) return { reason: "directory listing command", evidenceKind: "directory-inspected" };
  if (/\b(cat|head|tail|less|more|stat|file|wc|sed\s+-n|awk)\b/.test(command)) {
    return { reason: "read-only file inspection command", evidenceKind: "source-file-read" };
  }
  if (/\bgit\s+(status|diff)\b/.test(command)) {
    return { reason: "read-only git workspace inspection", evidenceKind: "targeted-search" };
  }
  if (/\b(ps|uname|df|du|free|hostname|whoami|curl\s+(-i|--head)|dig|nslookup|host)\b/.test(command)) {
    return { reason: "read-only system diagnostic command", evidenceKind: "runtime-log-inspected" };
  }
  return undefined;
}
