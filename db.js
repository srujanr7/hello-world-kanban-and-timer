const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// Return BIGINT (counts, unix-ms timestamps) and NUMERIC (sums) as JS numbers, not strings
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /sslmode=require|neon\.tech|ssl=true/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
});

const query = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0];
const all = async (text, params) => (await pool.query(text, params)).rows;

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function init() {
  // Schema is idempotent, so running it on every boot is safe
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  const { c } = await one('SELECT COUNT(*) AS c FROM projects');
  if (c === 0) {
    const { id } = await one("INSERT INTO projects (name, color) VALUES ('Hello World', '#764ba2') RETURNING id");
    const seed = [
      ['Set up server', 'Express + PostgreSQL backend', 'done', 'high', 0],
      ['Build kanban board', 'Drag & drop between columns', 'in_progress', 'high', 0],
      ['Track time on tasks', 'Click ▶ on any card', 'todo', 'medium', 0],
      ['Deploy it', 'Ship it with deployinn', 'todo', 'low', 1],
    ];
    for (const [title, desc, status, prio, pos] of seed) {
      await query('INSERT INTO tasks (project_id, title, description, status, priority, position) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, title, desc, status, prio, pos]);
    }
  }
}

module.exports = { pool, query, one, all, tx, init };
