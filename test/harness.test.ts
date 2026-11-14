import { describe, expect, test } from "bun:test";

import { harnessArgv, harnessConfig, harnessEnv, OPENCODE_VERSION } from "../src/config/harness";
import { DEFAULT_MODEL, MODELS } from "../src/config/models";
import { readFileSync } from "node:fs";

describe("harness lock", () => {
  test("Dockerfile pins the same OpenCode version as the code", () => {
    const dockerfile = readFileSync(`${import.meta.dir}/../Dockerfile`, "utf8");
    expect(dockerfile).toContain(`@opencode-ai/cli-linux-x64-baseline@${OPENCODE_VERSION}`);
  });
  test("argv: run --format json --auto --model openrouter/<model> -- <prompt>", () => {
    expect(harnessArgv("anthropic/claude-sonnet-5.5", "--help me")).toEqual([
      "opencode", "run", "--format", "json", "--auto", "--model", "openrouter/anthropic/claude-sonnet-5.5", "--", "--help me",
    ]);
  });
  test("env: Cloudflare's flags, project config and external skills off, config via OPENCODE_CONFIG_CONTENT, placeholder key", () => {
    const env = harnessEnv("{}", "/tmp/h");
    for (const flag of [
      "OPENCODE_DISABLE_MODELS_FETCH",
      "OPENCODE_DISABLE_AUTOUPDATE",
      "OPENCODE_DISABLE_DEFAULT_PLUGINS",
      "OPENCODE_DISABLE_LSP_DOWNLOAD",
      "OPENCODE_DISABLE_SHARE",
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "OPENCODE_DISABLE_CLAUDE_CODE",
      "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
      "OPENCODE_DISABLE_EXTERNAL_SKILLS",
    ]) expect(env[flag], flag).toBe("1");
    expect(env.OPENCODE_CONFIG_CONTENT).toBe("{}");
    expect(env.HOME).toBe("/tmp/h");
    expect(env.OPENROUTER_API_KEY).toBe("provided-by-outbound-worker");
  });
  test("config: V2 permissions, deny-all first, only lane skills, webfetch and skill-folder reads allowed", () => {
    const c = harnessConfig(["plain-english"], DEFAULT_MODEL) as { permissions: { action: string; resource: string; effect: string }[]; skills: string[] };
    expect(c.permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "skill", resource: "plain-english", effect: "allow" },
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "read", resource: ".opencode/skills/*", effect: "allow" },
      { action: "read", resource: "/work/.opencode/skills/*", effect: "allow" },
    ]);
    expect(c.skills).toEqual(["/work/.opencode/skills"]);
    expect("permission" in c).toBe(false); // V1 key
  });
  test("model allowlist has the spec's seven models with Sonnet 5.5 as default", () => {
    expect(MODELS.map((m) => m.label)).toEqual(["Claude Sonnet 5.5", "Claude Opus 5.5", "GPT-6.1 Sol", "GPT-6 Luna", "DeepSeek V4.1 Flash", "Kimi K3.1 Pro", "GLM 5.3"]);
    expect(DEFAULT_MODEL).toBe("anthropic/claude-sonnet-5.5");
  });
});
