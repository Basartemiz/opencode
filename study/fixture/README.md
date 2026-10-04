# shelf

Lending library service for a small community library.

- `npm start` runs the HTTP API on port 3000 (`PORT` to change it).
- `npm run cli -- <command>` runs the admin CLI (`books`, `members`, `loans`, `overdue`).
- `npm test` runs the tests.

Data lives in memory and is seeded from `src/db/seed.js` on start.
