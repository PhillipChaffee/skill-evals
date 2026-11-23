/**
 * Reads what Claude Code's `AskUserQuestion` asks. It takes `{ questions: [{ question, ... }] }`.
 * @param input - The call's input, as the stream gave it.
 * @returns The question texts, one to a line; null for an input of any other shape, or with no question text.
 */
export function claudeQuestionText(input: unknown): string | null {
  const { questions } = Object(input) as { questions?: unknown };
  const texts = Array.isArray(questions)
    ? questions.flatMap((one: unknown) => {
        const { question } = Object(one) as { question?: unknown };
        return typeof question === "string" ? [question] : [];
      })
    : [];
  return texts.length > 0 ? texts.join("\n") : null;
}
