import 'dotenv/config';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required; tests create and drop an isolated schema');
const schema = `test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, max: 30, application_name: schema, options: `-c search_path=${schema}` });
const app = createApp(pool);
const makeSlot = async () => {
  const res = await request(app).post('/slots').send({ clinicId: 'clinic-1', startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T11:00:00+00:00' });
  assert.equal(res.status, 201);
  return res.body.id as string;
};
before(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
});
after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

test('concurrent booking requests allow exactly one active booking', async () => {
  const slot = await makeSlot();
  // Keep the row locked until all requests are waiting in separate database sessions.
  const blocker = await pool.connect();
  let responses: request.Response[];
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM slots WHERE id = $1 FOR UPDATE', [slot]);
    const pending = Promise.all(Array.from({ length: 12 }, (_, i) =>
      request(app).post(`/slots/${slot}/bookings`).send({ patientId: `patient-${i}` }).then(r => r)));
    try {
      const deadline = Date.now() + 10000;
      let waiting = 0;
      while (Date.now() < deadline) {
        const result = await admin.query(
          "SELECT count(DISTINCT pid)::int AS count FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND query LIKE 'SELECT status FROM slots%'", [schema]);
        waiting = result.rows[0].count;
        if (waiting === 12) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(waiting, 12, 'all booking requests should overlap on independent connections');
    } finally {
      await blocker.query('ROLLBACK');
      responses = await pending;
    }
  } finally { blocker.release(); }
  assert.equal(responses.filter(r => r.status === 201).length, 1);
  assert.equal(responses.filter(r => r.status === 409 && r.body.error.code === 'slot_booked').length, 11);
  const result = await pool.query("SELECT count(*)::int AS count FROM bookings WHERE slot_id = $1 AND status = 'active'", [slot]);
  assert.equal(result.rows[0].count, 1);
});

test('database rejects a second active booking even without API locking', async () => {
  const slot = await makeSlot();
  await pool.query('INSERT INTO bookings (id, slot_id, patient_id) VALUES ($1, $2, $3)', [randomUUID(), slot, 'first']);
  await assert.rejects(
    pool.query('INSERT INTO bookings (id, slot_id, patient_id) VALUES ($1, $2, $3)', [randomUUID(), slot, 'second']),
    (error: { code?: string; constraint?: string }) => error.code === '23505' && error.constraint === 'one_active_booking_per_slot'
  );
});

test('booking cancellation preserves history, allows rebooking, and repeat cancellation conflicts', async () => {
  const slot = await makeSlot();
  const first = await request(app).post(`/slots/${slot}/bookings`).send({ patientId: 'a' });
  assert.equal(first.status, 201);
  assert.equal((await request(app).post(`/bookings/${first.body.id}/cancel`)).status, 200);
  assert.equal((await request(app).post(`/bookings/${first.body.id}/cancel`)).status, 409);
  assert.equal((await request(app).post(`/slots/${slot}/bookings`).send({ patientId: 'b' })).status, 201);
  const rows = await pool.query('SELECT status FROM bookings WHERE slot_id = $1 ORDER BY status', [slot]);
  assert.deepEqual(rows.rows.map(r => r.status), ['active', 'cancelled']);
});

test('slot cancellation rejects active bookings and prevents later booking', async () => {
  const slot = await makeSlot();
  const booking = await request(app).post(`/slots/${slot}/bookings`).send({ patientId: 'a' });
  const conflict = await request(app).post(`/slots/${slot}/cancel`);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'slot_booked');
  await request(app).post(`/bookings/${booking.body.id}/cancel`).expect(200);
  await request(app).post(`/slots/${slot}/cancel`).expect(200);
  await request(app).post(`/slots/${slot}/cancel`).expect(409);
  const rejected = await request(app).post(`/slots/${slot}/bookings`).send({ patientId: 'b' });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'slot_cancelled');
});

test('booking and slot cancellation races always leave a valid state', async () => {
  for (let i = 0; i < 20; i++) {
    const slot = await makeSlot();
    const [booking, cancellation] = await Promise.all([
      request(app).post(`/slots/${slot}/bookings`).send({ patientId: 'racer' }),
      request(app).post(`/slots/${slot}/cancel`)
    ]);
    assert.ok((booking.status === 201 && cancellation.status === 409) || (booking.status === 409 && cancellation.status === 200));
    const state = await pool.query("SELECT s.status, (SELECT count(*)::int FROM bookings b WHERE b.slot_id = s.id AND b.status = 'active') AS active FROM slots s WHERE id = $1", [slot]);
    assert.ok((state.rows[0].status === 'active' && state.rows[0].active === 1) || (state.rows[0].status === 'cancelled' && state.rows[0].active === 0));
  }
});

test('validation, missing resources, and listing', async () => {
  await request(app).post('/slots').send({ clinicId: '', startsAt: 'bad', endsAt: 'bad' }).expect(400);
  await request(app).post('/slots').send({ clinicId: 'a', startsAt: '2030-01-01T11:00:00Z', endsAt: '2030-01-01T10:00:00Z' }).expect(400);
  await request(app).post('/slots').send({ clinicId: 'a', startsAt: '2030-01-01T10:00:00', endsAt: '2030-01-01T11:00:00Z' }).expect(400);
  await request(app).post('/slots/nope/cancel').expect(400);
  await request(app).post(`/slots/${randomUUID()}/cancel`).expect(404);
  await request(app).post(`/slots/${randomUUID()}/bookings`).send({ patientId: 'a' }).expect(404);
  await request(app).post(`/bookings/${randomUUID()}/cancel`).expect(404);
  const slot = await makeSlot();
  await request(app).post(`/slots/${slot}/bookings`).send({ patientId: '' }).expect(400);
  const list = await request(app).get('/slots').query({ clinicId: 'clinic-1' }).expect(200);
  assert.ok(list.body.some((s: { id: string }) => s.id === slot));
  await request(app).get('/slots').query({ unknown: 'x' }).expect(400);
});
