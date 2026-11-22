/** What a harness says it loaded at startup. Null means the harness does not report that kind of thing. */
export interface Loaded {
  /** The directories of its plugins. */
  paths: string[] | null;
  /** The names of its skills, without any plugin prefix. */
  skills: string[] | null;
  agents: string[] | null;
  /** The rule files the harness says it loaded, by the name it reports; not what the run installed. */
  rules: string[] | null;
  hooks: string[] | null;
  mcpServers: string[] | null;
  /**
   * The text of each rule and instruction file the harness says it loaded, for a harness that states the text. Absent
   * or null: the harness states none, so `context_injected` cannot read rule text from it.
   */
  ruleTexts?: string[] | null;
  /** The skill names as the harness listed them, with any plugin prefix, for an adapter that has one. */
  rawSkills?: string[] | null;
  /** The plugins with their names, for an adapter that reports them. */
  plugins?: { name: string; path: string }[] | null;
}

/** What a harness that reports nothing about its startup gives. */
export const NOT_REPORTED: Loaded = {
  paths: null,
  skills: null,
  agents: null,
  rules: null,
  hooks: null,
  mcpServers: null,
};
