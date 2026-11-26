const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const STATUSES = ['todo', 'in_progress', 'review', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
// wrap async handlers so errors become 500s instead of crashing
const h = fn => (req, res, next) => fn(req, res).catch(next);
const intId = v => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

// ---------- Health / time ----------
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/api/time', (req, res) => {
  const now = new Date();
  res.json({ now: now.getTime(), iso: now.toISOString() });
});

// ---------- Projects ----------
const projectWithStats = `
  SELECT p.*,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count,
    (SELECT COALESCE(SUM(COALESCE(e.ended_at, $1::bigint) - e.started_at), 0)
       FROM time_entries e WHERE e.project_id = p.id) AS tracked_ms
  FROM projects p`;

app.get('/api/projects', h(async (req, res) => {
  res.json(await db.all(`${projectWithStats} ORDER BY p.created_at, p.id`, [Date.now()]));
}));

app.post('/api/projects', h(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return bad(res, 'name is required');
  const color = req.body.color || '#764ba2';
  const { id } = await db.one('INSERT INTO projects (name, color) VALUES ($1, $2) RETURNING id', [name, color]);
  res.status(201).json(await db.one(`${projectWithStats} WHERE p.id = $2`, [Date.now(), id]));
}));

app.patch('/api/projects/:id', h(async (req, res) => {
  const id = intId(req.params.id);
  const p = id && await db.one('SELECT * FROM projects WHERE id = $1', [id]);
  if (!p) return bad(res, 'project not found', 404);
  const name = req.body.name !== undefined ? String(req.body.name).trim() : p.name;
  if (!name) return bad(res, 'name cannot be empty');
  const color = req.body.color || p.color;
  await db.query('UPDATE projects SET name = $1, color = $2 WHERE id = $3', [name, color, id]);
  res.json(await db.one(`${projectWithStats} WHERE p.id = $2`, [Date.now(), id]));
}));

app.delete('/api/projects/:id', h(async (req, res) => {
  const id = intId(req.params.id);
  const r = id && await db.query('DELETE FROM projects WHERE id = $1', [id]);
  if (!r || !r.rowCount) return bad(res, 'project not found', 404);
  res.status(204).end();
}));

// ---------- Tasks ----------
const taskWithTime = `
  SELECT t.*,
    (SELECT COALESCE(SUM(COALESCE(e.ended_at, $1::bigint) - e.started_at), 0)
       FROM time_entries e WHERE e.task_id = t.id) AS tracked_ms
  FROM tasks t`;

app.get('/api/projects/:id/tasks', h(async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.json([]);
  res.json(await db.all(`${taskWithTime} WHERE t.project_id = $2 ORDER BY t.position, t.id`, [Date.now(), id]));
}));

app.post('/api/projects/:id/tasks', h(async (req, res) => {
  const pid = intId(req.params.id);
  const project = pid && await db.one('SELECT id FROM projects WHERE id = $1', [pid]);
  if (!project) return bad(res, 'project not found', 404);
  const title = String(req.body.title || '').trim();
  if (!title) return bad(res, 'title is required');
  const status = STATUSES.includes(req.body.status) ? req.body.status : 'todo';
  const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : 'medium';
  const description = String(req.body.description || '');
  const { p } = await db.one('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM tasks WHERE project_id = $1 AND status = $2', [pid, status]);
  const { id } = await db.one(
    'INSERT INTO tasks (project_id, title, description, status, priority, position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [pid, title, description, status, priority, p]);
  res.status(201).json(await db.one(`${taskWithTime} WHERE t.id = $2`, [Date.now(), id]));
}));

app.patch('/api/tasks/:id', h(async (req, res) => {
  const id = intId(req.params.id);
  const t = id && await db.one('SELECT * FROM tasks WHERE id = $1', [id]);
  if (!t) return bad(res, 'task not found', 404);
  const title = req.body.title !== undefined ? String(req.body.title).trim() : t.title;
  if (!title) return bad(res, 'title cannot be empty');
  const description = req.body.description !== undefined ? String(req.body.description) : t.description;
  const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : t.priority;
  await db.query('UPDATE tasks SET title = $1, description = $2, priority = $3 WHERE id = $4', [title, description, priority, id]);
  res.json(await db.one(`${taskWithTime} WHERE t.id = $2`, [Date.now(), id]));
}));

// Move a task: set new status + reorder destination (and source) column in one transaction
app.post('/api/tasks/:id/move', h(async (req, res) => {
  const id = intId(req.params.id);
  const t = id && await db.one('SELECT * FROM tasks WHERE id = $1', [id]);
  if (!t) return bad(res, 'task not found', 404);
  const status = req.body.status;
  if (!STATUSES.includes(status)) return bad(res, 'invalid status');
  let index = Number.isInteger(req.body.index) ? req.body.index : Infinity;

  await db.tx(async c => {
    const ids = (await c.query(
      'SELECT id FROM tasks WHERE project_id = $1 AND status = $2 AND id <> $3 ORDER BY position, id FOR UPDATE',
      [t.project_id, status, id])).rows.map(r => r.id);
    index = Math.max(0, Math.min(index, ids.length));
    ids.splice(index, 0, id);
    for (let i = 0; i < ids.length; i++) {
      await c.query('UPDATE tasks SET status = $1, position = $2 WHERE id = $3', [status, i, ids[i]]);
    }
    if (t.status !== status) {
      const src = (await c.query('SELECT id FROM tasks WHERE project_id = $1 AND status = $2 ORDER BY position, id', [t.project_id, t.status])).rows;
      for (let i = 0; i < src.length; i++) {
        await c.query('UPDATE tasks SET position = $1 WHERE id = $2', [i, src[i].id]);
      }
    }
  });
  res.json(await db.one(`${taskWithTime} WHERE t.id = $2`, [Date.now(), id]));
}));

app.delete('/api/tasks/:id', h(async (req, res) => {
  const id = intId(req.params.id);
  const r = id && await db.query('DELETE FROM tasks WHERE id = $1', [id]);
  if (!r || !r.rowCount) return bad(res, 'task not found', 404);
  res.status(204).end();
}));

// ---------- Timer / time entries ----------
const entrySelect = `
  SELECT e.*, p.name AS project_name, p.color AS project_color, t.title AS task_title
  FROM time_entries e
  JOIN projects p ON p.id = e.project_id
  LEFT JOIN tasks t ON t.id = e.task_id`;

app.get('/api/timer', h(async (req, res) => {
  const active = await db.one(`${entrySelect} WHERE e.ended_at IS NULL ORDER BY e.started_at DESC LIMIT 1`);
  res.json({ active: active || null, now: Date.now() });
}));

app.post('/api/timer/start', h(async (req, res) => {
  const pid = intId(req.body.project_id);
  const project = pid && await db.one('SELECT id FROM projects WHERE id = $1', [pid]);
  if (!project) return bad(res, 'project not found', 404);
  const taskId = req.body.task_id ? intId(req.body.task_id) : null;
  if (req.body.task_id) {
    const task = taskId && await db.one('SELECT id FROM tasks WHERE id = $1 AND project_id = $2', [taskId, pid]);
    if (!task) return bad(res, 'task not found in this project', 404);
  }
  const now = Date.now();
  const id = await db.tx(async c => {
    await c.query('UPDATE time_entries SET ended_at = $1 WHERE ended_at IS NULL', [now]); // one timer at a time
    return (await c.query(
      'INSERT INTO time_entries (project_id, task_id, note, started_at) VALUES ($1,$2,$3,$4) RETURNING id',
      [pid, taskId, String(req.body.note || ''), now])).rows[0].id;
  });
  res.status(201).json({ active: await db.one(`${entrySelect} WHERE e.id = $1`, [id]), now });
}));

app.post('/api/timer/stop', h(async (req, res) => {
  const now = Date.now();
  const r = await db.query('UPDATE time_entries SET ended_at = $1 WHERE ended_at IS NULL RETURNING id', [now]);
  const stopped = r.rows[0] ? await db.one(`${entrySelect} WHERE e.id = $1`, [r.rows[0].id]) : null;
  res.json({ stopped, active: null, now });
}));

app.get('/api/entries', h(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 200);
  const pid = intId(req.query.project_id);
  if (pid) {
    return res.json(await db.all(`${entrySelect} WHERE e.project_id = $1 ORDER BY e.started_at DESC LIMIT $2`, [pid, limit]));
  }
  res.json(await db.all(`${entrySelect} ORDER BY e.started_at DESC LIMIT $1`, [limit]));
}));

app.delete('/api/entries/:id', h(async (req, res) => {
  const id = intId(req.params.id);
  const r = id && await db.query('DELETE FROM time_entries WHERE id = $1', [id]);
  if (!r || !r.rowCount) return bad(res, 'entry not found', 404);
  res.status(204).end();
}));

// API 404 + SPA fallback
app.use('/api', (req, res) => bad(res, 'not found', 404));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

db.init()
  .then(() => app.listen(PORT, () => console.log(`🚀 Hello World running on port ${PORT}`)))
  .catch(err => { console.error('Failed to start:', err); process.exit(1); });
