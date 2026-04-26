/**
 * Skill management is not yet supported for the Azure Foundry adapter.
 *
 * Returning an "unsupported" snapshot satisfies the Paperclip skills tab
 * contract without faking a skill set we don't actually have. When a
 * future milestone adds skill packaging (e.g. Foundry Assistants API or
 * file-search containers), replace these stubs with real implementations.
 */

export interface SkillSnapshot {
  adapterType: string;
  supported: boolean;
  mode: "unsupported" | "persistent" | "ephemeral";
  desiredSkills: string[];
  entries: unknown[];
  warnings: string[];
}

export async function listSkills(): Promise<SkillSnapshot> {
  return {
    adapterType: "azure_foundry",
    supported: false,
    mode: "unsupported",
    desiredSkills: [],
    entries: [],
    warnings: [
      "Skills are not yet supported for azure_foundry agents. Use instructionsFilePath to inject a system prompt instead.",
    ],
  };
}

export async function syncSkills(): Promise<{ adapterConfig: Record<string, unknown>; desiredSkills: string[] | null; runtimeSkillEntries: unknown[] | null }> {
  return {
    adapterConfig: {},
    desiredSkills: null,
    runtimeSkillEntries: null,
  };
}
