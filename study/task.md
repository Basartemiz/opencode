Add a reservation queue for books that are out on loan.

- If a member wants a book that is on loan, let them reserve it: POST /books/:id/reservations with { "memberId": "..." }. A member can only be in a book's queue once.
- When the book is returned, hold it for the first member in the queue for 48 hours and send them an email that it is ready.
- While the hold lasts, nobody else can borrow the book, but the member it is held for can.
- If they do not borrow it within 48 hours, the hold moves to the next member in the queue (and they get the email).
- Add tests for the queue, the hold, and the hold expiring.
