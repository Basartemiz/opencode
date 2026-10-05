Add soft delete for users in this API.

- DELETE /v1/users/:userId should no longer remove the user from the database. Keep the record and store when it was deleted.
- Deleted users must not show up in GET /v1/users, and GET /v1/users/:userId should return 404 for them.
- A deleted user cannot log in, and their existing refresh tokens must stop working.
- Admins can bring a user back with POST /v1/users/:userId/restore.
- Document the new endpoint in the Swagger comments like the existing ones.

Do not write or run tests, do not install packages, and do not start the server; I will try everything myself afterwards.
