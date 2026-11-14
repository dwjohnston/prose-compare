// Limits shown in the UI and enforced on the server (SPEC.md "Limits shown in the UI").
export const LIMITS = {
  maxLanes: 6,
  maxSkillsPerLane: 4,
  maxPromptChars: 8_000,
  maxLabelChars: 60,
  /** Skill folder caps (SPEC.md "Run pipeline" step 2). */
  maxSkillBytes: 512 * 1024,
  maxSkillFiles: 50,
  maxSkillDepth: 6,
  maxPathChars: 200,
  maxDescriptionChars: 2_000,
  maxSkillNameChars: 64,
} as const;
