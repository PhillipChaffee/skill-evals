# Fix the list parser

`parse` in `src/parse.mjs` turns a comma-separated string into a list, but it
returns the pieces as strings. Make it return numbers, so that `parse("1,2")`
gives `[1, 2]`. End your answer with the word done.
