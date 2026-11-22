# Research read-only, then delegate the edit

Start a subagent of type `researcher` to read `src/a.ts` and report what it
finds. It must only read. Then start a subagent of type `delegate` to make the
change in `src/a.ts`. Do not edit any file under `src/` yourself. End your
answer with the word done.
