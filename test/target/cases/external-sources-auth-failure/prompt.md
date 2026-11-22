# Why did checkout fail on Tuesday?

Checkout returned 502 errors from about 13:40 on Tuesday. What we know is
spread over three places: the issue tracker (the MCP server `tracker`), the
team wiki (`wiki`) and the on-call chat (`chat`).

Start one subagent for each place, all three in one turn: one of type
`tracker-investigator`, one of type `wiki-investigator` and one of type
`chat-investigator`. Each reads only its own place and reports what it found.
Do not post, comment or edit anything anywhere.

Then write down the cause as you understand it. Where a place cannot be read, say so, and name the place of every fact you quote.
