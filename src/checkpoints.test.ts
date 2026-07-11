import assert from "node:assert/strict";
import { createCheckpointManager } from "./checkpoints.js";

let tick = 1;
const checkpoints = createCheckpointManager(() => tick++, {
  requireShowChanges: true,
  thresholds: { analysis: 3, diagnosis: 4, codeChange: 5 },
  rootEvidenceTtlMs: 100,
});

function recordDiverseEvidence(workspaceId: string): void {
  checkpoints.recordInspection({ workspaceId, tool: "read", path: "src/server.ts" });
  checkpoints.recordInspection({ workspaceId, tool: "grep", path: "src" });
  checkpoints.recordShellCommand({ workspaceId, command: "journalctl -u devspace.service --no-pager", success: true });
}

checkpoints.initializeWorkspace({ workspaceId: "ws", root: "/repo", rootKey: "/repo", freshnessKey: "a" });
let clean = checkpoints.evaluate({ workspaceId: "ws", taskType: "analysis" });
assert.equal(clean.ready, false);
assert.equal(clean.inspectionScore, 0);
assert.match(clean.blockers.join("\n"), /Insufficient workspace investigation/);

checkpoints.recordInspection({ workspaceId: "ws", tool: "read", path: "src/server.ts" });
checkpoints.recordInspection({ workspaceId: "ws", tool: "read", path: "src/server.ts" });
checkpoints.recordInspection({ workspaceId: "ws", tool: "read", path: "src/server.ts" });
const repeated = checkpoints.evaluate({ workspaceId: "ws", taskType: "analysis" });
assert.equal(repeated.inspectionCount, 3);
assert.equal(repeated.inspectionScore, 1);
assert.equal(repeated.ready, false);

checkpoints.recordInspection({ workspaceId: "ws", tool: "grep", path: "src" });
checkpoints.recordShellCommand({ workspaceId: "ws", command: "cat README.md", success: true });
const enoughAnalysis = checkpoints.evaluate({ workspaceId: "ws", taskType: "analysis" });
assert.equal(enoughAnalysis.ready, true);
assert.equal(enoughAnalysis.inspectionScore >= 3, true);

checkpoints.resetTask({ workspaceId: "ws" });
recordDiverseEvidence("ws");
const diagnosis = checkpoints.evaluate({ workspaceId: "ws", taskType: "diagnosis" });
assert.equal(diagnosis.ready, true);
assert.equal(diagnosis.evidenceKinds.includes("runtime-log-inspected"), true);

checkpoints.resetTask({ workspaceId: "ws" });
recordDiverseEvidence("ws");
checkpoints.recordInspection({ workspaceId: "ws", tool: "read", path: "src/checkpoints.test.ts" });
checkpoints.recordInspection({ workspaceId: "ws", tool: "read", path: "package.json" });
checkpoints.recordModification({ workspaceId: "ws", tool: "edit", files: ["src/server.ts"] });
let afterEdit = checkpoints.evaluate({ workspaceId: "ws", taskType: "code_change" });
assert.equal(afterEdit.ready, false);
assert.match(afterEdit.blockers.join("\n"), /no successful verification/);

checkpoints.recordShellCommand({ workspaceId: "ws", command: "npx tsc -p tsconfig.json --noEmit", success: true });
afterEdit = checkpoints.evaluate({ workspaceId: "ws", taskType: "code_change" });
assert.equal(afterEdit.ready, false);
assert.match(afterEdit.blockers.join("\n"), /show_changes/);

checkpoints.recordShowChanges({ workspaceId: "ws" });
const readyCodeChange = checkpoints.evaluate({ workspaceId: "ws", taskType: "code_change" });
assert.equal(readyCodeChange.ready, true);
assert.equal(readyCodeChange.verificationCommands.length > 0, true);

checkpoints.resetTask({ workspaceId: "ws" });
recordDiverseEvidence("ws");
checkpoints.recordModification({ workspaceId: "ws", tool: "edit", files: ["src/app.ts"] });
checkpoints.recordShowChanges({ workspaceId: "ws" });
const missingDeclared = checkpoints.evaluate({ workspaceId: "ws", taskType: "code_change", verificationSteps: ["npm test"] });
assert.equal(missingDeclared.ready, false);
assert.match(missingDeclared.blockers.join("\n"), /not found in executed commands/);

checkpoints.initializeWorkspace({ workspaceId: "ws2", root: "/repo-worktree", rootKey: "/repo", freshnessKey: "a" });
const reused = checkpoints.evaluate({ workspaceId: "ws2", taskType: "analysis" });
assert.equal(reused.reusedRootEvidence > 0, true);
assert.equal(reused.ready, true);

const downgradedCodeChange = checkpoints.evaluate({ workspaceId: "ws2", taskType: "code_change" });
assert.equal(downgradedCodeChange.taskType, "analysis");
assert.equal(downgradedCodeChange.ready, true);
assert.equal(downgradedCodeChange.warnings.some((warning) => warning.includes("no recorded file modifications")), true);

const reuseCounter = createCheckpointManager(() => tick++, {
  thresholds: { analysis: 1, diagnosis: 2, codeChange: 3 },
  rootEvidenceTtlMs: 100,
});
reuseCounter.initializeWorkspace({ workspaceId: "source", root: "/repo", rootKey: "/repo", freshnessKey: "a" });
reuseCounter.recordInspection({ workspaceId: "source", tool: "read", path: "src/a.ts" });
reuseCounter.recordInspection({ workspaceId: "source", tool: "read", path: "src/a.ts" });
reuseCounter.recordInspection({ workspaceId: "source", tool: "grep", path: "src" });
reuseCounter.initializeWorkspace({ workspaceId: "consumer", root: "/repo-worktree", rootKey: "/repo", freshnessKey: "a" });
assert.equal(reuseCounter.evaluate({ workspaceId: "consumer", taskType: "analysis" }).reusedRootEvidence, 2);
reuseCounter.recordInspection({ workspaceId: "consumer", tool: "read", path: "src/a.ts" });
assert.equal(reuseCounter.evaluate({ workspaceId: "consumer", taskType: "analysis" }).reusedRootEvidence, 1);

checkpoints.initializeWorkspace({ workspaceId: "stale-source", root: "/repo-stale", rootKey: "/repo", freshnessKey: "b" });
const stale = checkpoints.evaluate({ workspaceId: "stale-source", taskType: "analysis" });
assert.equal(stale.reusedRootEvidence, 0);

console.log("All checkpoint tests passed.");
