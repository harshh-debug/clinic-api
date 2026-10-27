# Clinic appointment booking API

A small demo API using Node.js, Express, TypeScript and PostgreSQL. Clinic and patient IDs are supplied by callers and are **not authenticated**; there is no authorization. Do not expose this demo as a real patient booking service.

## Setup

Prerequisites: Node.js 20 or later, npm, and PostgreSQL 16 or later. Docker and Docker Compose are optional. From the repository root:

```sh
npm install
cp .env.example .env
docker compose up -d
until docker compose exec -T postgres pg_isready -h localhost -U clinic -d clinic; do sleep 1; done
npm run migrate
npm run dev
```

The Compose service creates a `clinic` database and user on localhost port 5432, persisting data in a Docker volume. If port 5432 is occupied, change the host mapping in `compose.yml` from `"5432:5432"` to, for example, `"55439:5432"`, and change the port in both URLs in `.env` to `55439`. The container port stays `5432`, so the readiness command remains unchanged. Use the same host port in the test command below. The example credentials are for local development only. With an existing PostgreSQL server, create a database and a user with permission to create tables and indexes, set `DATABASE_URL` in `.env`, and run `npm run migrate`. The migration is transactional and can be run repeatedly. `npm run build` compiles the service; `npm start` runs the compiled server. `PORT` defaults to 3000.

## API

JSON requests and responses use `Content-Type: application/json`. Timestamps require an ISO 8601 date and time with `Z` or a numeric timezone offset; responses are UTC. IDs for slots and bookings are UUIDs. Clinic and patient IDs are nonempty strings of at most 200 characters (surrounding whitespace is trimmed).

| Method and path | Behavior | Success |
| --- | --- | --- |
| `POST /slots` | Create a slot with `clinicId`, `startsAt`, `endsAt` | 201, slot |
| `GET /slots` | List all slots, including cancelled slots; optional `clinicId` query parameter | 200, array of slots |
| `POST /slots/:slotId/cancel` | Cancel an unbooked active slot | 200, slot |
| `POST /slots/:slotId/bookings` | Book an active slot with `patientId` | 201, booking |
| `POST /bookings/:bookingId/cancel` | Cancel an active booking | 200, booking |

For example, replace `SLOT_UUID` and `BOOKING_UUID` with IDs returned by earlier requests:

```sh
curl -sS -X POST http://localhost:3000/slots -H 'Content-Type: application/json' \
  -d '{"clinicId":"clinic-1","startsAt":"2030-01-01T10:00:00Z","endsAt":"2030-01-01T11:00:00Z"}'
curl -sS 'http://localhost:3000/slots?clinicId=clinic-1'
curl -sS -X POST http://localhost:3000/slots/SLOT_UUID/bookings -H 'Content-Type: application/json' -d '{"patientId":"patient-1"}'
curl -sS -X POST http://localhost:3000/bookings/BOOKING_UUID/cancel
curl -sS -X POST http://localhost:3000/slots/SLOT_UUID/cancel
```

A created slot looks like:

```json
{"id":"a7f0d145-4995-40a3-b866-d44d7954cbef","clinicId":"clinic-1","startsAt":"2030-01-01T10:00:00.000Z","endsAt":"2030-01-01T11:00:00.000Z","status":"active","createdAt":"2026-01-01T00:00:00.000Z"}
```

A booking has `id`, `slotId`, `patientId`, `status`, and `createdAt`. Both resources have status `active` or `cancelled`. Errors have a consistent shape, for example:

```json
{"error":{"code":"slot_booked","message":"Slot already has an active booking"}}
```

Invalid IDs, bodies, query parameters, timestamps or malformed JSON return 400 (`invalid_input`); oversized JSON returns 413. Missing resources or routes return 404 (`not_found`). A booked or cancelled slot and repeat cancellations return 409 (`slot_booked`, `slot_cancelled`, or `already_cancelled`). Unexpected errors return 500 (`internal_error`) without database details.

## Rules and concurrency

End must be after start. Past slots and overlapping slots can be created; no future-time or overlap restrictions are imposed. The single-active-booking rule applies to each slot ID, so overlapping slots may each be booked. Listing includes cancelled slots and is unpaginated. Cancellation preserves records. Repeating a cancellation returns 409, and missing resources return 404. A slot with an active booking cannot be cancelled: cancel the booking first. A cancelled slot cannot be booked; cancelling a booking makes an active slot available again.

A PostgreSQL partial unique index on `bookings(slot_id)` where status is `active` enforces at most one active booking even if another writer bypasses the API; unique violations from that index become 409. Booking and slot cancellation both lock the slot row with `SELECT ... FOR UPDATE` in a transaction before checking its status or active bookings. Thus one operation finishes before the other checks: either the booking succeeds and slot cancellation conflicts, or slot cancellation succeeds and booking conflicts. Booking cancellation locks the booking row and only changes it from active to cancelled; racing slot cancellation may conservatively conflict if the booking has not yet been cancelled. The cross-table cancelled-slot rule depends on writers following the slot-locking protocol; direct SQL writers must follow it too.

## Tests

Tests require a real PostgreSQL database and a role with permission to create and drop schemas. Set `TEST_DATABASE_URL` explicitly. Each run creates a randomly named schema, applies the migration there, and drops only that schema afterward; it does not truncate or overwrite development tables. A separate test database is recommended. For the Compose server above:

```sh
docker compose exec postgres createdb -U clinic clinic_test
TEST_DATABASE_URL=postgresql://clinic:clinic@localhost:5432/clinic_test npm test
npm run typecheck
npm run build
```

If `clinic_test` already exists, omit the `createdb` command. The integration tests verify that concurrent requests wait on independent PostgreSQL connections and cover concurrent bookings, cancellation/rebooking, validation and missing resources, cancellation policy, and booking versus slot cancellation races. If a test process is forcibly terminated, its randomly named schema may need manual cleanup.
