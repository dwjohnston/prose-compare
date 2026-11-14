// Model allowlist (SPEC.md "Compose page" step 4). All models go through OpenRouter.
// Slugs confirmed against https://openrouter.ai/api/v1/models on 2026-11-14.
export interface ModelOption {
  /** OpenRouter model slug. OpenCode is called with `--model openrouter/<slug>`. */
  slug: string;
  label: string;
}

export const MODELS: readonly ModelOption[] = [
  { slug: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5" },
  { slug: "openai/gpt-6-luna", label: "GPT-6 Luna" },
  { slug: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
  { slug: "moonshotai/kimi-k3.1-pro", label: "Kimi K3.1 Pro" },
  { slug: "z-ai/glm-5.3", label: "GLM 5.3" },
];

export const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

export function isAllowedModel(slug: string): boolean {
  return MODELS.some((m) => m.slug === slug);
}

export function modelLabel(slug: string): string {
  return MODELS.find((m) => m.slug === slug)?.label ?? slug;
}
