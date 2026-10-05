Short summary
- Implemented soft-delete for users (DELETE sets deletedAt instead of removing record), removed refresh tokens on delete, prevented deleted users from appearing in lists or authenticating, and added a restore endpoint.
- Lowered minimum password length from 8 → 4 (validation + model + Swagger docs).
- Updated Swagger docs to reflect password minLength and to document POST /v1/users/{id}/restore.
- Added a short explanatory comment in the user query service about filtering deleted users.
- Called checkpoints during the work and received approval to continue.

Behavior changes (high level)
1. DELETE /v1/users/:userId: soft-delete (set deletedAt); refresh tokens for that user are deleted.
2. GET /v1/users: excludes soft-deleted users.
3. GET /v1/users/:userId: returns 404 for soft-deleted users.
4. Auth (login/refresh/access): deleted users are treated as not found — they cannot log in and refresh tokens are removed so refresh fails.
5. POST /v1/users/:userId/restore: new admin endpoint to clear deletedAt and restore the user.
6. Password policy: minimum length changed to 4 across Joi validation, Mongoose schema, and Swagger docs.

File-by-file changes
- src/validations/custom.validation.js
  - Lowered Joi custom password min length check from 8 to 4 (error message adjusted).

- src/models/user.model.js
  - Lowered Mongoose password minlength from 8 to 4.
  - Added deletedAt: Date, default null.

- src/config/passport.js
  - JWT user lookup changed from findById(payload.sub) to findOne({_id: payload.sub, deletedAt: null}) so access tokens for deleted users are rejected.

- src/services/user.service.js
  - Added Token and tokenTypes imports.
  - queryUsers: now appends { deletedAt: null } to filter (plus a short explanatory comment).
  - getUserById, getUserByEmail: changed to only return non-deleted users ({ deletedAt: null }).
  - deleteUserById: changed to soft-delete (set deletedAt = new Date() and save) and delete refresh tokens with Token.deleteMany({ user, type: REFRESH }).
  - Added restoreUserById to clear deletedAt and save.
  - Exported restoreUserById.

- src/controllers/user.controller.js
  - Added restoreUser controller handler: returns restored user.
  - Exported restoreUser.

- src/routes/v1/user.route.js
  - Added router POST /:userId/restore with auth('manageUsers') and validation.
  - Updated Swagger comments in users route: password minLength changed to 4 in relevant blocks.
  - Added Swagger block documenting POST /users/{id}/restore.

- src/routes/v1/auth.route.js
  - Updated Swagger comments for register and reset-password to show minLength: 4.

Other notes / caveats
- I removed refresh tokens for deleted users so refresh-tokens stop working. Access tokens are invalidated indirectly because passport lookup rejects deleted users; I didn't implement an explicit access-token blacklist.
- I did not change token.model.js or tokens storage semantics beyond deleting refresh tokens on soft-delete.
- I did not add or modify tests, run them, or start the server per your instruction.
- I added an inline comment in user.service.queryUsers explaining why deleted users are filtered.

Checkpoints (work progress)
- Called checkpoints during the session after the main behavioral change and after doc/comment updates; both checkpoints were approved so I continued with the next steps.

If you want next
1. Add tests for soft-delete/restore and auth behaviors.
2. Add migration/seed script if you want to set deletedAt = null explicitly for existing data.
3. Implement explicit access-token blacklisting if immediate access-token invalidation is required.

If you want, I can produce a single consolidated diff or walk you through testing steps end-to-end.
