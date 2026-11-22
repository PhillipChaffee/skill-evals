const PLAIN_TEXT = { type: "string", minLength: 1 };

/** The schema of a case's `setup` steps: a shell command, or a git setup. */
export const STEPS_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    oneOf: [
      {
        type: "object",
        required: ["run"],
        properties: {
          run: PLAIN_TEXT,
          timeoutSeconds: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["git"],
        properties: {
          git: {
            type: "object",
            minProperties: 1,
            // The loader also needs `init` to be true; the schema cannot say that.
            dependentRequired: { branch: ["init"] },
            properties: {
              init: { type: "boolean" },
              branch: {
                type: "string",
                pattern: "^[A-Za-z0-9_][A-Za-z0-9._/-]*$",
              },
              commitAll: PLAIN_TEXT,
              remote: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    ],
  },
};

/** The schema of a `by`: the main thread, any subagent, or the agents of one type. */
export const BY_SCHEMA = {
  oneOf: [
    { enum: ["main", "subagent"] },
    {
      type: "object",
      required: ["agent"],
      properties: { agent: PLAIN_TEXT },
      additionalProperties: false,
    },
  ],
};
