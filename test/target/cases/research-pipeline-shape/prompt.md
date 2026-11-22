# Cache options

The service in `src/` reads the same records many times a minute. Work out
what a read cache could look like for it: which options fit, and what each
one costs.

Say at the start how big the job is. Start one subagent of type
`researcher` for each part of the question (at least two, all in one turn),
and when they have reported, one subagent of type `research-synthesizer` to
combine what they found. Save the result as one new Markdown file under
`docs/research/`. Leave it uncommitted, and change no other file.
