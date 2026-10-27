import express, { type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z, ZodError } from 'zod';

const id = z.string().uuid();
const identity = z.string().trim().min(1).max(200);
const timestamp = z.string().datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)), 'Invalid timestamp');
const slotInput = z.object({ clinicId: identity, startsAt: timestamp, endsAt: timestamp }).strict()
  .refine(v => Date.parse(v.endsAt) > Date.parse(v.startsAt), { message: 'endsAt must be after startsAt' });
const bookingInput = z.object({ patientId: identity }).strict();

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const asyncRoute = (fn: RequestHandler): RequestHandler => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };
async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
const slotFields = 'id, clinic_id AS "clinicId", starts_at AS "startsAt", ends_at AS "endsAt", status, created_at AS "createdAt"';
const bookingFields = 'id, slot_id AS "slotId", patient_id AS "patientId", status, created_at AS "createdAt"';

export function createApp(pool: Pool) {
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.post('/slots', asyncRoute(async (req, res) => {
    const input = slotInput.parse(req.body);
    const result = await pool.query(`INSERT INTO slots (id, clinic_id, starts_at, ends_at) VALUES ($1,$2,$3,$4) RETURNING ${slotFields}`,
      [randomUUID(), input.clinicId, input.startsAt, input.endsAt]);
    res.status(201).json(result.rows[0]);
  }));
  app.get('/slots', asyncRoute(async (req, res) => {
    const query = z.object({ clinicId: identity.optional() }).strict().parse(req.query);
    const result = await pool.query(`SELECT ${slotFields} FROM slots WHERE ($1::text IS NULL OR clinic_id = $1) ORDER BY starts_at, id`, [query.clinicId ?? null]);
    res.json(result.rows);
  }));
  app.post('/slots/:slotId/cancel', asyncRoute(async (req, res) => {
    const slotId = id.parse(req.params.slotId);
    const slot = await transaction(pool, async client => {
      const found = await client.query(`SELECT ${slotFields} FROM slots WHERE id = $1 FOR UPDATE`, [slotId]);
      if (!found.rowCount) throw new ApiError(404, 'not_found', 'Slot not found');
      if (found.rows[0].status === 'cancelled') throw new ApiError(409, 'already_cancelled', 'Slot is already cancelled');
      const booking = await client.query("SELECT 1 FROM bookings WHERE slot_id = $1 AND status = 'active'", [slotId]);
      if (booking.rowCount) throw new ApiError(409, 'slot_booked', 'Cancel the active booking before cancelling the slot');
      return (await client.query(`UPDATE slots SET status = 'cancelled' WHERE id = $1 RETURNING ${slotFields}`, [slotId])).rows[0];
    });
    res.json(slot);
  }));
  app.post('/slots/:slotId/bookings', asyncRoute(async (req, res) => {
    const slotId = id.parse(req.params.slotId);
    const input = bookingInput.parse(req.body);
    const booking = await transaction(pool, async client => {
      const slot = await client.query('SELECT status FROM slots WHERE id = $1 FOR UPDATE', [slotId]);
      if (!slot.rowCount) throw new ApiError(404, 'not_found', 'Slot not found');
      if (slot.rows[0].status === 'cancelled') throw new ApiError(409, 'slot_cancelled', 'Slot is cancelled');
      return (await client.query(`INSERT INTO bookings (id, slot_id, patient_id) VALUES ($1,$2,$3) RETURNING ${bookingFields}`, [randomUUID(), slotId, input.patientId])).rows[0];
    });
    res.status(201).json(booking);
  }));
  app.post('/bookings/:bookingId/cancel', asyncRoute(async (req, res) => {
    const bookingId = id.parse(req.params.bookingId);
    const booking = await transaction(pool, async client => {
      const found = await client.query(`SELECT ${bookingFields} FROM bookings WHERE id = $1 FOR UPDATE`, [bookingId]);
      if (!found.rowCount) throw new ApiError(404, 'not_found', 'Booking not found');
      if (found.rows[0].status === 'cancelled') throw new ApiError(409, 'already_cancelled', 'Booking is already cancelled');
      return (await client.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1 RETURNING ${bookingFields}`, [bookingId])).rows[0];
    });
    res.json(booking);
  }));
  app.use((_req, _res, next) => next(new ApiError(404, 'not_found', 'Route not found')));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ error: { code: 'invalid_input', message: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') } });
    if (err instanceof ApiError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === '23505' && 'constraint' in err && err.constraint === 'one_active_booking_per_slot')
      return res.status(409).json({ error: { code: 'slot_booked', message: 'Slot already has an active booking' } });
    if (typeof err === 'object' && err !== null && 'type' in err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large'))
      return res.status(err.type === 'entity.too.large' ? 413 : 400).json({ error: { code: 'invalid_input', message: err.type === 'entity.too.large' ? 'Request body too large' : 'Invalid JSON' } });
    console.error(err);
    return res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
  });
  return app;
}
