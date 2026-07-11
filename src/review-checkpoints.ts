import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { git, getGitEligibility, safeWorkspaceRefSegment } from "./git.js";
import { decodeText } from "./text-codec.js";

export type ReviewSince = "last_shown" | "last_review" | "workspace_open";

export interface ReviewSummary {
  files: number;
  additions: number;
  removals: number;
}

export interface ReviewFile {
  path: string;
  previousPath?: string;
  type: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  additions: number;
  removals: number;
}

export interface ReviewChangesResult {
  result: string;
  summary: ReviewSummary;
  files: ReviewFile[];
  patch: string;
}

interface WorkspaceReviewState {
  root: string;
  gitRoot?: string;
  openRef: string;
  baselineRef: string;
  diagnostic?: string;
}

export interface ReviewCheckpointManager {
  initializeWorkspace(input: { workspaceId: string; root: string }): Promise<void>;
  reviewChanges(input: {
    workspaceId: string;
    root: string;
    since?: ReviewSince;
    markReviewed?: boolean;
  }): Promise<ReviewChangesResult>;
}

const REVIEW_REF_PREFIX = "refs/devspace/review";
const MAX_DIFF_BUFFER = 50 * 1024 * 1024;

export function createReviewCheckpointManager(): ReviewCheckpointManager {
  const states = new Map<string, WorkspaceReviewState>();

  return {
    async initializeWorkspace({ workspaceId, root }) {
      const refs = reviewRefs(workspaceId);
      const state: WorkspaceReviewState = { root, ...refs };
      states.set(workspaceId, state);

      try {
        const eligibility = await getGitEligibility(root);
        if (!eligibility.ok || !eligibility.gitRoot) {
          state.diagnostic = eligibility.message ?? "show_changes requires a Git workspace in this version.";
          return;
        }

        state.gitRoot = eligibility.gitRoot;
        const commit = await createWorkingTreeSnapshot(eligibility.gitRoot);
        await git(eligibility.gitRoot, ["update-ref", state.openRef, commit]);
        await git(eligibility.gitRoot, ["update-ref", state.baselineRef, commit]);
      } catch (error) {
        state.diagnostic = error instanceof Error ? error.message : String(error);
      }
    },

    async reviewChanges({ workspaceId, root, since = "last_shown", markReviewed = true }) {
      let state = states.get(workspaceId);
      if (!state) {
        await this.initializeWorkspace({ workspaceId, root });
        state = states.get(workspaceId);
      }

      if (!state?.gitRoot) {
        throw new Error(state?.diagnostic ?? "show_changes requires a Git workspace in this version.");
      }

      const baselineRef = since === "workspace_open" ? state.openRef : state.baselineRef;
      const baseline = (await git(state.gitRoot, ["rev-parse", "--verify", `${baselineRef}^{commit}`])).stdout.trim();
      const current = await createWorkingTreeSnapshot(state.gitRoot);
      const numstat = (await git(state.gitRoot, ["diff", "--numstat", "-z", baseline, current], {
        maxBuffer: MAX_DIFF_BUFFER,
      })).stdout;
      const files = parseNumstat(numstat);
      const summary = summarizeFiles(files);
      const patch = await unicodePatch(state.gitRoot, baseline, current, files);

      if (markReviewed) {
        await git(state.gitRoot, ["update-ref", state.baselineRef, current]);
      }

      return {
        result:
          summary.files === 0
            ? `No changes since ${since === "workspace_open" ? "workspace open" : "last shown changes"}.`
            : `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`,
        summary,
        files,
        patch,
      };
    },
  };
}

function reviewRefs(workspaceId: string): Pick<WorkspaceReviewState, "openRef" | "baselineRef"> {
  const segment = safeWorkspaceRefSegment(workspaceId);
  return {
    openRef: `${REVIEW_REF_PREFIX}/${segment}/open`,
    baselineRef: `${REVIEW_REF_PREFIX}/${segment}/baseline`,
  };
}

async function createWorkingTreeSnapshot(gitRoot: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "devspace-review-index-"));
  const indexPath = join(tempDir, "index");
  const env = checkpointEnv(indexPath);

  try {
    await git(gitRoot, ["read-tree", "HEAD"], { env });
    await git(gitRoot, ["add", "-A", "--", "."], { env });
    const tree = (await git(gitRoot, ["write-tree"], { env })).stdout.trim();
    const parent = (await git(gitRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    return (await git(gitRoot, ["commit-tree", tree, "-p", parent, "-m", "DevSpace review snapshot"], { env })).stdout.trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function checkpointEnv(indexPath: string): NodeJS.ProcessEnv {
  return {
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "DevSpace",
    GIT_AUTHOR_EMAIL: "devspace@users.noreply.local",
    GIT_COMMITTER_NAME: "DevSpace",
    GIT_COMMITTER_EMAIL: "devspace@users.noreply.local",
  };
}

async function unicodePatch(
  gitRoot: string,
  baseline: string,
  current: string,
  files: ReviewFile[],
): Promise<string> {
  const patches: string[] = [];
  const blobRequests = new Map<string, string>();
  for (const file of files) {
    const oldPath = file.previousPath ?? file.path;
    if (file.type !== "new") blobRequests.set(blobKey(baseline, oldPath), `${baseline}:${oldPath}`);
    if (file.type !== "deleted") blobRequests.set(blobKey(current, file.path), `${current}:${file.path}`);
  }
  const blobs = await readBlobBatch(gitRoot, blobRequests);

  for (const file of files) {
    if (file.type === "rename-pure" && file.previousPath) {
      patches.push([
        `diff --git a/${file.previousPath} b/${file.path}`,
        "similarity index 100%",
        `rename from ${file.previousPath}`,
        `rename to ${file.path}`,
      ].join("\n"));
      continue;
    }

    const oldPath = file.previousPath ?? file.path;
    const oldText = file.type === "new" ? null : blobs.get(blobKey(baseline, oldPath));
    const newText = file.type === "deleted" ? null : blobs.get(blobKey(current, file.path));

    if ((file.type !== "new" && oldText === undefined) || (file.type !== "deleted" && newText === undefined)) {
      patches.push(binaryFilePatch(file));
      continue;
    }

    const patch = createTwoFilesPatch(
      oldText === null ? "/dev/null" : `a/${oldPath}`,
      newText === null ? "/dev/null" : `b/${file.path}`,
      oldText ?? "",
      newText ?? "",
      "",
      "",
      { context: 3 },
    ).trimEnd();

    if (!patch) continue;
    const withRename = file.previousPath && file.previousPath !== file.path
      ? insertRenameHeaders(patch, file.previousPath, file.path)
      : patch;
    patches.push(withRename);
  }

  return patches.join("\n");
}

function blobKey(commit: string, path: string): string {
  return `${commit}\0${path}`;
}

async function readBlobBatch(
  cwd: string,
  requests: Map<string, string>,
): Promise<Map<string, string | undefined>> {
  if (requests.size === 0) return new Map();
  const specs = [...requests.values()];
  const bytes = await runCatFileBatch(cwd, specs);
  const objects = parseCatFileBatch(bytes, specs.length);
  const decoded = new Map<string, string | undefined>();
  let index = 0;
  for (const key of requests.keys()) {
    const object = objects[index++];
    if (!object) {
      decoded.set(key, undefined);
      continue;
    }
    try {
      decoded.set(key, decodeText(object).content);
    } catch {
      decoded.set(key, undefined);
    }
  }
  return decoded;
}

function runCatFileBatch(cwd: string, specs: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch"], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    let stdoutBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_DIFF_BUFFER) {
        settled = true;
        child.kill();
        reject(new Error(`git cat-file output exceeded ${MAX_DIFF_BUFFER} bytes.`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8") || `git cat-file exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
    child.stdin.end(`${specs.join("\n")}\n`);
  });
}

function parseCatFileBatch(output: Buffer, expected: number): Array<Buffer | undefined> {
  const objects: Array<Buffer | undefined> = [];
  let offset = 0;

  while (objects.length < expected) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) throw new Error("Incomplete git cat-file batch header.");
    const header = output.subarray(offset, headerEnd).toString("utf8");
    offset = headerEnd + 1;

    if (header.endsWith(" missing")) {
      objects.push(undefined);
      continue;
    }

    const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!match) throw new Error(`Unexpected git cat-file batch header: ${header}`);
    const size = Number(match[1]);
    const end = offset + size;
    if (end >= output.length) throw new Error("Incomplete git cat-file batch object.");
    objects.push(output.subarray(offset, end));
    offset = end + 1;
  }

  return objects;
}

function binaryFilePatch(file: ReviewFile): string {
  const oldPath = file.previousPath ?? file.path;
  return [
    `diff --git a/${oldPath} b/${file.path}`,
    "Binary files differ",
  ].join("\n");
}

function insertRenameHeaders(patch: string, previousPath: string, path: string): string {
  const lines = patch.split("\n");
  if (lines.length === 0) return patch;
  return [
    lines[0],
    `rename from ${previousPath}`,
    `rename to ${path}`,
    ...lines.slice(1),
  ].join("\n");
}

function parseNumstat(output: string): ReviewFile[] {
  const fields = output.split("\0").filter((field) => field.length > 0);
  const files: ReviewFile[] = [];

  for (let index = 0; index < fields.length;) {
    const header = fields[index++] ?? "";
    const parts = header.split("\t");
    const additions = parseStatNumber(parts[0]);
    const removals = parseStatNumber(parts[1]);

    if (parts.length >= 3) {
      const path = parts[2] ?? "";
      if (path) files.push({ path, type: fileType(path, undefined, additions, removals), additions, removals });
      continue;
    }

    const previousPath = fields[index++];
    const path = fields[index++];
    if (!path) continue;

    files.push({
      path,
      previousPath,
      type: fileType(path, previousPath, additions, removals),
      additions,
      removals,
    });
  }

  return files;
}

function parseStatNumber(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fileType(
  path: string,
  previousPath: string | undefined,
  additions: number,
  removals: number,
): ReviewFile["type"] {
  if (previousPath) return additions === 0 && removals === 0 ? "rename-pure" : "rename-changed";
  if (additions > 0 && removals === 0) return "new";
  if (additions === 0 && removals > 0) return "deleted";
  return "change";
}

function summarizeFiles(files: ReviewFile[]): ReviewSummary {
  return files.reduce<ReviewSummary>(
    (summary, file) => ({
      files: summary.files + 1,
      additions: summary.additions + file.additions,
      removals: summary.removals + file.removals,
    }),
    { files: 0, additions: 0, removals: 0 },
  );
}
