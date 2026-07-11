import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadSkills,
  parseFrontmatter,
  type Skill,
  type LoadSkillsResult,
} from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { expandHomePath, isPathInsideRoot } from "./roots.js";
import { decodeText } from "./text-codec.js";

export interface LoadedSkills {
  skills: Skill[];
  diagnostics: LoadSkillsResult["diagnostics"];
}

export interface SkillReadResolution {
  absolutePath: string;
  skill: Skill;
  isSkillFile: boolean;
}

const SUBAGENT_DELEGATION_NAME = "subagent-delegation";
const SUBAGENT_DELEGATION_SKILL = join(SUBAGENT_DELEGATION_NAME, "SKILL.md");

function bundledSkillsDir(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

function hasSubagentDelegationSkill(skillDir: string): boolean {
  return existsSync(join(skillDir, SUBAGENT_DELEGATION_SKILL));
}

export function effectiveSkillPaths(config: ServerConfig, cwd: string): string[] {
  const bundledSkills = bundledSkillsDir();
  const defaultPathCandidates = [
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".claude", "skills"),
    resolve(cwd, ".agents", "skills"),
    resolve(cwd, ".claude", "skills"),
    resolve(cwd, ".codemaker", "skills"),
    config.devspaceSkillsDir,
    join(config.agentDir, "skills"),
    config.subagents && !hasSubagentDelegationSkill(config.devspaceSkillsDir)
      ? bundledSkills
      : undefined,
  ];
  const defaultPaths = defaultPathCandidates.filter(
    (path): path is string => path !== undefined && existsSync(path),
  );

  const seen = new Set<string>();
  return [...defaultPaths, ...config.skillPaths]
    .map((path) => resolveSkillPath(path, cwd))
    .filter((path) => {
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    });
}

function resolveSkillPath(path: string, cwd: string): string {
  return resolve(cwd, expandHomePath(path));
}

export function loadWorkspaceSkills(config: ServerConfig, cwd: string): LoadedSkills {
  if (!config.skillsEnabled) return { skills: [], diagnostics: [] };

  const result = loadSkills({
    cwd,
    agentDir: config.agentDir,
    skillPaths: effectiveSkillPaths(config, cwd),
    includeDefaults: false,
  });

  const skills = result.skills.map(redecodeSkillFrontmatter);
  if (config.subagents) {
    return { skills, diagnostics: result.diagnostics };
  }

  return {
    skills: skills.filter((skill) => skill.name !== SUBAGENT_DELEGATION_NAME),
    diagnostics: result.diagnostics.filter((diagnostic) => {
      const collision = diagnostic.collision;
      return !(collision?.resourceType === "skill" && collision.name === SUBAGENT_DELEGATION_NAME);
    }),
  };
}

function redecodeSkillFrontmatter(skill: Skill): Skill {
  try {
    const content = decodeText(readFileSync(skill.filePath)).content;
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
    const name = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
    const description = typeof frontmatter.description === "string"
      ? frontmatter.description
      : undefined;
    const disableModelInvocation = typeof frontmatter["disable-model-invocation"] === "boolean"
      ? frontmatter["disable-model-invocation"]
      : undefined;

    return {
      ...skill,
      name: name ?? skill.name,
      description: description ?? skill.description,
      disableModelInvocation: disableModelInvocation ?? skill.disableModelInvocation,
    };
  } catch {
    return skill;
  }
}

export function resolveSkillReadPath(
  skills: Skill[],
  activatedSkillDirs: Set<string>,
  inputPath: string,
): SkillReadResolution | undefined {
  const absolutePath = resolve(expandHomePath(inputPath));

  for (const skill of skills) {
    const skillFilePath = resolve(skill.filePath);
    if (absolutePath === skillFilePath) {
      return { absolutePath, skill, isSkillFile: true };
    }
  }

  for (const skill of skills) {
    const baseDir = resolve(skill.baseDir);
    if (!activatedSkillDirs.has(baseDir)) continue;
    if (!isPathInsideRoot(absolutePath, baseDir)) continue;

    return { absolutePath, skill, isSkillFile: false };
  }

  return undefined;
}

export function markSkillActivated(
  activatedSkillDirs: Set<string>,
  skill: Skill,
): void {
  activatedSkillDirs.add(resolve(skill.baseDir));
}

export function formatPathForPrompt(path: string): string {
  const home = resolve(homedir());
  const resolvedPath = resolve(path);

  if (resolvedPath === home) return "~";
  if (resolvedPath.startsWith(`${home}${sep}`)) {
    return `~/${resolvedPath.slice(home.length + 1).split(sep).join("/")}`;
  }

  return resolvedPath.split(sep).join("/");
}
