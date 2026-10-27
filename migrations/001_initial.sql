CREATE TABLE slots (
  id uuid PRIMARY KEY,
  clinic_id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE TABLE bookings (
  id uuid PRIMARY KEY,
  slot_id uuid NOT NULL REFERENCES slots(id),
  patient_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_booking_per_slot ON bookings (slot_id) WHERE status = 'active';
