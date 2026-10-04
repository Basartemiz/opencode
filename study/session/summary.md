Here's a summary of all the changes I made in this session:

1. Book Ratings Feature:
   - Added a new "ratings" collection to the in-memory store.
   - Created a ratings service with functions to add/update ratings and calculate average ratings and count.
   - Extended the GET /books/:id route to include average rating and rating count.
   - Added POST /books/:id/ratings route to submit a member's rating for a book.

2. Suspended Members Feature:
   - Added a `suspended` boolean field to member records with default false.
   - Added suspendMember and unsuspendMember functions in the members service.
   - Updated the borrow service function to block borrowing if the member is suspended.
   - Added POST /members/:id/suspend and POST /members/:id/unsuspend routes.
   - Modified GET /members/:id to include the suspended flag.
   - Added a one-line comment explaining suspension behavior.

3. Year Filter Feature:
   - Extended the catalog search function to accept optional from and to year filters.
   - Updated the GET /books route to parse from and to query parameters and pass them to the search.
   - Filtered books in the search function by the inclusive year range.

4. Popular Books Reporting:
   - Created a new service function getPopularBooks that counts borrowings and returns the top 5 popular books.
   - Added GET /reports/popular route to return the popular books with borrow counts.
   - Added a 'popular' command to the admin CLI that prints the popular books with borrow counts.

5. Configuration Change:
   - Set the LATE_FEE_PER_DAY constant in src/config.js to 0 (zero).

Let me know if you want me to explain any part in more detail or help with anything else!
