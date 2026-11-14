// OpenCode harness lock (SPEC.md "Run pipeline" step 5 and "Harness permissions").
//
// Version: OpenCode V2 is the `opencode2` binary from @opencode-ai/cli. The `opencode-ai` 1.x package
// (pinned at 1.19.4 in Cloudflare's guide) is V1; its config loader rejects V2 `permissions` with
// 'V2 permissions are not supported by OpenCode V1. Use V1 "permission" rules or run opencode2.'
// (anomalyco/opencode@v1.19.4 packages/opencode/src/config/v2-compat.ts). The newest published V2
// build is 0.0.0-beta-19271 (2026-09-07). Keep in step with the Dockerfile.
export const OPENCODE_PACKAGE = "@opencode-ai/cli-linux-x64-baseline";
export const OPENCODE_VERSION = "0.0.0-beta-19271";
export const HARNESS_VERSION = `opencode2 ${OPENCODE_VERSION}`;

/** Sandbox paths. `/work` holds nothing but the skills folder and is not a git worktree. */
export const WORK_DIR = "/work";
export const SKILLS_DIR = `${WORK_DIR}/.opencode/skills`;

/** Placeholder the outbound Worker replaces with the real OPENROUTER_TOKEN. Never a real key. */
export const PLACEHOLDER_KEY = "provided-by-outbound-worker";

/**
 * Environment for `opencode run`. Flags from Cloudflare's guide
 * (https://developers.cloudflare.com/sandbox/coding-agents/opencode/), plus the V2 switches that turn off
 * project config and external (Claude Code / .agents) skill folders. The V2 CLI reads
 * OPENCODE_DISABLE_PROJECT_CONFIG, OPENCODE_DISABLE_CLAUDE_CODE(_SKILLS) and OPENCODE_CONFIG_CONTENT in
 * packages/cli/src/server-process.ts.
 */
export function harnessEnv(config: string, home: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_DATA_HOME: `${home}/.local/share`,
    XDG_CACHE_HOME: `${home}/.cache`,
    XDG_STATE_HOME: `${home}/.local/state`,
    OPENROUTER_API_KEY: PLACEHOLDER_KEY,
    OPENCODE_CONFIG_CONTENT: config,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_SHARE: "1",
  };
}

export interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

/**
 * Permission rules in V2 form. Key names from https://opencode.ai/docs/permissions/ (V2 docs):
 * top-level `permissions` is an ordered array of { action, resource, effect }, the last matching rule
 * wins, `*` matches any characters including `/`. The V1 spec block maps as:
 *   "*": "deny"                  -> { action: "*", resource: "*", effect: "deny" }
 *   "skill": "allow"             -> one allow per skill in this lane (tighter than V1's blanket allow,
 *                                   so built-in or stray skills can't load)
 *   "webfetch": "allow"          -> { action: "webfetch", resource: "*", effect: "allow" }
 *   read "/work/.opencode/skills/**" -> `read` resources are "location-relative internal path or
 *                                   canonical absolute external path", so both forms are allowed.
 * Everything else (shell, edit, glob, grep, websearch, subagent, question, external_directory,
 * execute, MCP) stays denied by the leading rule.
 */
export function permissionRules(skillIds: readonly string[], workDir = WORK_DIR): PermissionRule[] {
  const skillsDir = `${workDir}/.opencode/skills`;
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...skillIds.map((id): PermissionRule => ({ action: "skill", resource: id, effect: "allow" })),
    { action: "webfetch", resource: "*", effect: "allow" },
    { action: "read", resource: ".opencode/skills/*", effect: "allow" },
    { action: "read", resource: `${skillsDir}/*`, effect: "allow" },
  ];
}

/**
 * The full config passed through OPENCODE_CONFIG_CONTENT.
 *
 * `skills` lists the lane's skill folder explicitly: with OPENCODE_DISABLE_PROJECT_CONFIG=1, V2 does not
 * walk the working directory for `.opencode/` at all (packages/core/src/config/discovery.ts), so the
 * project `.opencode/skills` folder would otherwise be invisible.
 *
 * `providers.openrouter.models` declares the chosen model so a model newer than the binary's built-in
 * catalog still resolves with OPENCODE_DISABLE_MODELS_FETCH=1.
 * Confirmed by the golden capture: the run resolves the model this way, but OpenCode then has no price for
 * it and reports cost 0 (handled in src/queue.ts).
 */
export function harnessConfig(skillIds: readonly string[], modelSlug: string, workDir = WORK_DIR): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    permissions: permissionRules(skillIds, workDir),
    skills: [`${workDir}/.opencode/skills`],
    plugins: [],
    instructions: [],
    snapshots: false,
    providers: {
      openrouter: {
        models: { [modelSlug]: {} },
      },
    },
  };
}

/** argv for one lane run. The prompt goes after `--` so it can never be read as a flag. */
export function harnessArgv(modelSlug: string, prompt: string): string[] {
  return ["opencode", "run", "--format", "json", "--auto", "--model", `openrouter/${modelSlug}`, "--", prompt];
}
