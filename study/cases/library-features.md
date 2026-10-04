Add these four features to the library service. Do them in this order and finish each one before you start the next. Do not write or run tests, and do not start the server; I will try everything myself afterwards.

1. Book ratings: POST /books/:id/ratings with { "memberId": "...", "stars": 1-5 }. Each member has one rating per book; rating again replaces the old rating. GET /books/:id also shows the average rating (one decimal) and the number of ratings.
2. Suspended members: POST /members/:id/suspend and POST /members/:id/unsuspend. A suspended member cannot borrow books and gets a clear error. GET /members/:id shows "suspended": true or false.
3. Year filter: GET /books accepts ?from=YEAR and ?to=YEAR and only returns books published in that range, both years included.
4. Popular books: GET /reports/popular returns the 5 books that were borrowed most often, with how many times each was borrowed. Also add a `popular` command to the admin CLI that prints the same list.
