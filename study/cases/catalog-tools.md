Add these four catalog features. Do them in this order and finish each one before you start the next. Do not write or run tests, and do not start the server; I will try everything myself afterwards.

1. Change copies: POST /books/:id/copies with { "change": n } adds copies (n > 0) or removes them (n < 0). A book always keeps at least 1 copy and never fewer copies than are out on loan right now.
2. Genre counts: add the genre "poetry", and add GET /genres, which lists every genre with how many active books it has.
3. Retire safely: DELETE /books/:id refuses to retire a book while a copy is out on loan and says how many copies are still out.
4. Books command: `npm run cli -- books --genre tech` lists only books of that genre, and `npm run cli -- books --out` lists only books with no copies on the shelf.
