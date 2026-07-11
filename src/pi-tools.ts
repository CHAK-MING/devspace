import { stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type BashToolInput,
  type EditToolInput,
  type EditToolDetails,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type WriteToolInput,
  type AgentToolResult,
  generateUnifiedPatch,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { resolveAllowedPath } from "./roots.js";
import { readTextFileAuto, writeTextFileEncoded, type TextEncoding } from "./text-codec.js";
import { walkWorkspace } from "./workspace-ignore.js";

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  readRoots?: string[];
}

interface CachedTools {
  read: ReturnType<typeof createReadTool>;
  write: ReturnType<typeof createWriteTool>;
  edit: ReturnType<typeof createEditTool>;
  grep: ReturnType<typeof createGrepTool>;
  find: ReturnType<typeof createFindTool>;
  ls: ReturnType<typeof createLsTool>;
  bash: ReturnType<typeof createBashTool>;
}

const toolCache = new Map<string, CachedTools>();
const TOOL_CACHE_LIMIT = 32;
const GREP_MATCH_LIMIT = 500;
const GREP_SKIPPED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".devspace",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
]);

function getCachedTools(cwd: string): CachedTools {
  const existing = toolCache.get(cwd);
  if (existing) {
    toolCache.delete(cwd);
    toolCache.set(cwd, existing);
    return existing;
  }

  const cached = {
    read: createReadTool(cwd),
    write: createWriteTool(cwd),
    edit: createEditTool(cwd),
    grep: createGrepTool(cwd),
    find: createFindTool(cwd),
    ls: createLsTool(cwd),
    bash: createBashTool(cwd),
  };
  toolCache.set(cwd, cached);
  if (toolCache.size > TOOL_CACHE_LIMIT) {
    const oldest = toolCache.keys().next().value;
    if (oldest !== undefined) toolCache.delete(oldest);
  }
  return cached;
}

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
  return result.content.map((content) => {
    if (content.type === "text") {
      return { type: "text", text: content.text };
    }

    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
    };
  });
}

function formatToolError(error: unknown): McpContent[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{ type: "text", text: message }];
}

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  context: ToolContext,
): Promise<ToolResponse<TDetails>> {
  try {
    const result = await execute(input);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function isImageFile(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) ? IMAGE_MIME_TYPES[ext] : undefined;
}

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);

  // Images: delegate to the original pi-coding-agent read tool, which handles
  // binary detection, base64 encoding, and image resizing.
  const mimeType = isImageFile(path);
  if (mimeType) {
    const tool = getCachedTools(context.cwd).read;
    return runTool((params) => tool.execute("read_file", params), {
      path,
      offset: input.offset,
      limit: input.limit,
    }, context);
  }

  // Text files: use text-codec for multi-encoding support (GBK/UTF-16/BOM),
  // then apply line-based slicing + byte truncation for safety.
  try {
    const file = await readTextFileAuto(path);
    const text = sliceLines(file.content, input.offset, input.limit);
    const truncated = truncateHead(text);
    const parts: string[] = [];
    if (file.encoding !== "utf8") {
      parts.push(`[File decoded as ${file.encoding}]`);
    }
    parts.push(truncated.content);
    if (truncated.truncated) {
      parts.push(`\n[Truncated: ${truncated.outputLines} lines shown (${Math.round(DEFAULT_MAX_BYTES / 1024)}KB limit). Use offset to continue.]`);
    }
    return {
      content: [{ type: "text", text: parts.join("\n") }],
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

function sliceLines(content: string, offset: number | undefined, limit: number | undefined): string {
  if (offset === undefined && limit === undefined) return content;
  const lines = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const start = Math.max((offset ?? 1) - 1, 0);
  const end = limit === undefined ? lines.length : start + limit;
  return lines.slice(start, end).join("\n");
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);

  try {
    await withFileMutationQueue(path, async () => {
      let encoding: TextEncoding = "utf8";
      try {
        encoding = (await readTextFileAuto(path)).encoding;
      } catch {
        // New files are written as UTF-8; existing text files preserve their detected encoding.
      }
      await writeTextFileEncoded(path, input.content, encoding);
    });
    return { content: [{ type: "text", text: `Wrote ${input.path}.` }] };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);

  try {
    const result = await withFileMutationQueue(path, async () => {
      const file = await readTextFileAuto(path);
      const original = file.content;
      const relativePath = formatRelativePath(context.root, path);
      const updated = applyExactEdits(original, input.edits, relativePath);
      await writeTextFileEncoded(path, updated, file.encoding);

      const patch = generateUnifiedPatch(relativePath, original, updated);
      return { patch, encoding: file.encoding };
    });
    return {
      content: [{ type: "text", text: `Edited ${input.path}.` }],
      details: {
        diff: result.patch,
        patch: result.patch,
      },
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

interface PreparedEdit {
  index: number;
  start: number;
  end: number;
  newText: string;
}

function applyExactEdits(
  content: string,
  edits: Array<{ oldText: string; newText: string }>,
  path: string,
): string {
  const prepared = edits.map((edit, index) => prepareExactEdit(content, edit, index, path));
  const ordered = [...prepared].sort((a, b) => a.start - b.start || a.end - b.end);

  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.start < previous.end) {
      throw new Error(
        `edits[${current.index}] overlaps edits[${previous.index}] in ${path} ` +
          `near lines ${lineNumberAt(content, previous.start)} and ${lineNumberAt(content, current.start)}. ` +
          "Merge overlapping replacements into one edit.",
      );
    }
  }

  let updated = content;
  for (const edit of ordered.sort((a, b) => b.start - a.start)) {
    updated = updated.slice(0, edit.start) + edit.newText + updated.slice(edit.end);
  }
  return updated;
}

function prepareExactEdit(
  content: string,
  edit: { oldText: string; newText: string },
  index: number,
  path: string,
): PreparedEdit {
  if (edit.oldText.length === 0) {
    throw new Error(`edits[${index}].oldText must not be empty.`);
  }

  const occurrences = findOccurrences(content, edit.oldText);
  if (occurrences.length === 0) {
    throw new Error(
      `Could not find edits[${index}] in ${path}. oldText must match the original file exactly, ` +
        `including whitespace and line endings. Re-read the target region before retrying${oldTextPreview(edit.oldText)}.`,
    );
  }
  if (occurrences.length > 1) {
    const lines = occurrences.slice(0, 6).map((offset) => lineNumberAt(content, offset));
    const remaining = occurrences.length - lines.length;
    throw new Error(
      `Found ${occurrences.length} occurrences of edits[${index}] in ${path} at lines ${lines.join(", ")}` +
        `${remaining > 0 ? ` and ${remaining} more` : ""}. Expand oldText with surrounding context so it is unique.`,
    );
  }

  const start = occurrences[0];
  return {
    index,
    start,
    end: start + edit.oldText.length,
    newText: edit.newText,
  };
}

function findOccurrences(content: string, needle: string): number[] {
  const matches: number[] = [];
  let offset = 0;
  while (offset <= content.length - needle.length) {
    const match = content.indexOf(needle, offset);
    if (match === -1) break;
    matches.push(match);
    offset = match + 1;
  }
  return matches;
}

function lineNumberAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) {
    if (content.charCodeAt(index) === 10) line++;
  }
  return line;
}

function oldTextPreview(oldText: string): string {
  const firstLine = oldText.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return "";
  const preview = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  return ` (starts with ${JSON.stringify(preview)})`;
}

function formatRelativePath(root: string, path: string): string {
  const relationship = relative(root, resolve(path));
  return (relationship || ".").split(sep).join("/");
}

type GrepFilesInput = GrepToolInput & { include?: string };

export async function grepFilesTool(input: GrepFilesInput, context: ToolContext): Promise<ToolResponse> {
  try {
    if (input.glob && input.include && input.glob !== input.include) {
      throw new Error("Specify only one grep file filter: glob or include.");
    }
    const pattern = compileGrepPattern(input.pattern, input.literal, input.ignoreCase);
    const includeGlob = input.glob ?? input.include;
    const include = includeGlob ? compileGlob(includeGlob) : undefined;
    const limit = input.limit ?? GREP_MATCH_LIMIT;
    const searchRoot = input.path
      ? resolveAllowedPath(input.path, context.cwd, [context.root])
      : context.root;
    const metadata = await stat(searchRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error(`Search path does not exist: ${input.path}`);
      throw error;
    });
    const matches: string[] = [];
    let truncated = false;

    const searchFile = async (file: string): Promise<boolean> => {
      const displayPath = formatRelativePath(context.root, file);
      if (include && !include.test(displayPath)) return true;

      let content: string;
      try {
        content = (await readTextFileAuto(file)).content;
      } catch {
        return true;
      }

      const lines = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
      for (let index = 0; index < lines.length; index++) {
        pattern.lastIndex = 0;
        if (!pattern.test(lines[index])) continue;
        matches.push(`${displayPath}:${index + 1}:${lines[index]}`);
        if (matches.length >= limit) {
          truncated = true;
          return false;
        }
      }
      return true;
    };

    if (metadata.isFile()) {
      await searchFile(searchRoot);
    } else if (metadata.isDirectory()) {
      await walkWorkspace(
        searchRoot,
        (path, entry) => entry.isFile() ? searchFile(path) : true,
        GREP_SKIPPED_DIRS,
      );
    } else {
      throw new Error(`Search path is not a file or directory: ${input.path ?? "."}`);
    }

    const text = matches.length > 0 ? matches.join("\n") : "No matches found.";
    return {
      content: [
        {
          type: "text",
          text: truncated ? `${text}\n\nResults truncated at ${limit} matches.` : text,
        },
      ],
      details: truncated ? { matchLimitReached: limit } : undefined,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

function compileGrepPattern(pattern: string, literal = false, ignoreCase = false): RegExp {
  try {
    return new RegExp(literal ? escapeRegExp(pattern) : pattern, ignoreCase ? "gi" : "g");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid grep regular expression: ${message}`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function compileGlob(glob: string): RegExp {
  const escaped = glob
    .split("")
    .map((char) => {
      if (char === "*") return "__DEVSPACE_GLOB_STAR__";
      if (char === "?") return "__DEVSPACE_GLOB_QUESTION__";
      return /[\\^$+?.()|{}[\]]/.test(char) ? `\\${char}` : char;
    })
    .join("")
    .replaceAll("__DEVSPACE_GLOB_STAR____DEVSPACE_GLOB_STAR__", ".*")
    .replaceAll("__DEVSPACE_GLOB_STAR__", "[^/]*")
    .replaceAll("__DEVSPACE_GLOB_QUESTION__", "[^/]");
  return new RegExp(`^${escaped}$`);
}

export async function findFilesTool(input: FindToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = getCachedTools(context.cwd).find;

  return runTool((params) => tool.execute("find_files", params), input, context);
}

export async function listDirectoryTool(input: LsToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = getCachedTools(context.cwd).ls;

  return runTool((params) => tool.execute("list_directory", params), input, context);
}

export async function runShellTool(input: BashToolInput, context: ToolContext): Promise<ToolResponse> {
  const tool = getCachedTools(context.cwd).bash;
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);

  return runTool((params) => tool.execute("run_shell", params), {
    command: input.command,
    timeout,
  }, context);
}
