Add these four features for library members. Do them in this order and finish each one before you start the next. Do not write or run tests, and do not start the server; I will try everything myself afterwards.

1. Phone numbers: members can give an optional phone number when they sign up (digits and spaces, may start with +, 7 to 20 characters). GET /members and GET /members/:id show it.
2. Payment history: GET /members/:id/payments lists the member's payments, newest first, with the amount and the date.
3. Borrowing history: GET /members/:id/history lists all of the member's loans, returned ones too, newest first, with the book title for each.
4. Members command: `npm run cli -- members` also shows how many books each member has right now, and `npm run cli -- members --owing` lists only members who owe money.
