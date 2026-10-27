import 'dotenv/config';
import { Pool } from 'pg';
import { createApp } from './app.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
createApp(pool).listen(port, () => console.log(`Listening on port ${port}`));
