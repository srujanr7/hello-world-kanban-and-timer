// ===== Helpers =====
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}
function fmtShort(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return ms > 0 ? '<1m' : '0m';
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}
function esc(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// ===== State =====
const state = {
  projects: [],
  currentId: Number(localStorage.getItem('currentProject')) || null,
  tasks: [],
  active: null,        // running time entry
  serverOffset: 0,     // serverTime - clientTime
};
const now = () => Date.now() + state.serverOffset;

// ===== Clock (synced to server time) =====
async function syncTime() {
  const t0 = Date.now();
  const { now: server } = await api('/time');
  const t1 = Date.now();
  state.serverOffset = server - (t0 + t1) / 2;
}
function tickClock() {
  const d = new Date(now());
  $('#clock-time').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('#clock-date').textContent = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// ===== Projects =====
async function loadProjects() {
  state.projects = await api('/projects');
  state.projectsLoadedAt = now();
  if (!state.projects.find(p => p.id === state.currentId)) {
    state.currentId = state.projects[0]?.id || null;
  }
  renderProjects();
}
function renderProjects() {
  $('#project-list').innerHTML = state.projects.map(p => `
    <li data-id="${p.id}" class="${p.id === state.currentId ? 'active' : ''}">
      <span class="dot" style="background:${esc(p.color)}"></span>
      <span class="p-name">${esc(p.name)}</span>
      <span class="p-time" data-project-time="${p.id}">${fmtShort(p.tracked_ms)}</span>
    </li>`).join('') || '<li class="muted">No projects yet</li>';

  const p = currentProject();
  $('#project-title').textContent = p ? p.name : 'Create a project to get started';
  $('#project-meta').textContent = p ? `${p.done_count}/${p.task_count} tasks done · ${fmtShort(p.tracked_ms)} tracked` : '';
  $('#board').style.display = p ? '' : 'none';
  $('.project-actions').style.display = p ? '' : 'none';
}
const currentProject = () => state.projects.find(p => p.id === state.currentId);

async function selectProject(id) {
  state.currentId = id;
  localStorage.setItem('currentProject', id);
  renderProjects();
  await Promise.all([loadTasks(), loadEntries()]);
}

$('#project-list').addEventListener('click', e => {
  const li = e.target.closest('li[data-id]');
  if (li) selectProject(Number(li.dataset.id));
});

$('#project-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#project-name').value.trim();
  if (!name) return;
  const p = await api('/projects', { method: 'POST', body: { name, color: $('#project-color').value } });
  $('#project-name').value = '';
  await loadProjects();
  selectProject(p.id);
  toast('Project created');
});

$('#rename-project').addEventListener('click', async () => {
  const p = currentProject();
  const name = prompt('Rename project', p.name);
  if (!name || !name.trim()) return;
  await api(`/projects/${p.id}`, { method: 'PATCH', body: { name } });
  await loadProjects();
});

$('#delete-project').addEventListener('click', async () => {
  const p = currentProject();
  if (!confirm(`Delete "${p.name}" and all its tasks and time entries?`)) return;
  await api(`/projects/${p.id}`, { method: 'DELETE' });
  await loadProjects();
  await refreshTimer();
  if (state.currentId) selectProject(state.currentId); else { state.tasks = []; renderBoard(); renderEntries([]); }
  toast('Project deleted');
});

// ===== Tasks / Kanban =====
async function loadTasks() {
  if (!state.currentId) { state.tasks = []; return renderBoard(); }
  state.tasks = await api(`/projects/${state.currentId}/tasks`);
  state.tasksLoadedAt = now();
  renderBoard();
}

function taskTrackedMs(t) {
  // server's tracked_ms already includes running time up to load; add time since load
  let ms = t.tracked_ms;
  if (state.active && state.active.task_id === t.id && state.tasksLoadedAt) ms += now() - state.tasksLoadedAt;
  return ms;
}

function renderBoard() {
  for (const col of $$('.column')) {
    const status = col.dataset.status;
    const tasks = state.tasks.filter(t => t.status === status).sort((a, b) => a.position - b.position);
    $('.count', col).textContent = tasks.length;
    $('.cards', col).innerHTML = tasks.map(t => {
      const on = state.active && state.active.task_id === t.id;
      return `
      <div class="card prio-${t.priority} ${on ? 'tracking' : ''}" draggable="true" data-id="${t.id}">
        <div class="card-title">${esc(t.title)}</div>
        ${t.description ? `<div class="card-desc">${esc(t.description)}</div>` : ''}
        <div class="card-foot">
          <span class="card-time" data-task-time="${t.id}">⏱ ${fmtDuration(taskTrackedMs(t))}</span>
          <button class="card-play ${on ? 'on' : ''}" data-play="${t.id}">${on ? '■ Stop' : '▶ Track'}</button>
        </div>
      </div>`;
    }).join('');
  }
  renderTaskSelect();
}

function renderTaskSelect() {
  const sel = $('#timer-task');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— Whole project —</option>' +
    state.tasks.filter(t => t.status !== 'done').map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join('');
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

// --- Drag & drop ---
let dragId = null;
const marker = Object.assign(document.createElement('div'), { className: 'drop-marker' });

document.addEventListener('dragstart', e => {
  const card = e.target.closest?.('.card');
  if (!card) return;
  dragId = Number(card.dataset.id);
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});
document.addEventListener('dragend', e => {
  e.target.closest?.('.card')?.classList.remove('dragging');
  marker.remove();
  $$('.column').forEach(c => c.classList.remove('drag-over'));
  dragId = null;
});

function dropIndex(cardsEl, y) {
  const cards = $$('.card:not(.dragging)', cardsEl);
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) return { index: i, before: cards[i] };
  }
  return { index: cards.length, before: null };
}

for (const col of $$('.column')) {
  const cardsEl = $('.cards', col);
  col.addEventListener('dragover', e => {
    if (dragId == null) return;
    e.preventDefault();
    col.classList.add('drag-over');
    const { before } = dropIndex(cardsEl, e.clientY);
    before ? cardsEl.insertBefore(marker, before) : cardsEl.appendChild(marker);
  });
  col.addEventListener('dragleave', e => {
    if (!col.contains(e.relatedTarget)) { col.classList.remove('drag-over'); marker.remove(); }
  });
  col.addEventListener('drop', async e => {
    e.preventDefault();
    if (dragId == null) return;
    const id = dragId;
    const { index } = dropIndex(cardsEl, e.clientY);
    const status = col.dataset.status;
    marker.remove();
    col.classList.remove('drag-over');

    // optimistic local reorder
    const task = state.tasks.find(t => t.id === id);
    const others = state.tasks.filter(t => t.status === status && t.id !== id).sort((a, b) => a.position - b.position);
    others.splice(index, 0, task);
    task.status = status;
    others.forEach((t, i) => (t.position = i));
    renderBoard();

    try {
      await api(`/tasks/${id}/move`, { method: 'POST', body: { status, index } });
      if (status === 'done' && state.active?.task_id === id) await stopTimer();
      await Promise.all([loadTasks(), loadProjects()]);
    } catch (err) { toast(err.message); loadTasks(); }
  });
}

// --- Card clicks ---
$('#board').addEventListener('click', async e => {
  const play = e.target.closest('[data-play]');
  if (play) {
    e.stopPropagation();
    const id = Number(play.dataset.play);
    if (state.active?.task_id === id) await stopTimer();
    else await startTimer(id);
    return;
  }
  const add = e.target.closest('.add-card');
  if (add) return openTaskModal(null, add.closest('.column').dataset.status);
  const card = e.target.closest('.card');
  if (card) openTaskModal(state.tasks.find(t => t.id === Number(card.dataset.id)));
});

// --- Task modal ---
const modal = $('#task-modal');
let editing = null;

function openTaskModal(task, status = 'todo') {
  editing = task ? { id: task.id } : { status };
  $('#task-modal-title').textContent = task ? 'Edit task' : 'New task';
  $('#task-title').value = task?.title || '';
  $('#task-desc').value = task?.description || '';
  $('#task-priority').value = task?.priority || 'medium';
  $('#task-delete').style.display = task ? '' : 'none';
  modal.showModal();
  $('#task-title').focus();
}
$('#task-cancel').addEventListener('click', () => modal.close());

$('#task-form').addEventListener('submit', async e => {
  e.preventDefault();
  const body = {
    title: $('#task-title').value.trim(),
    description: $('#task-desc').value.trim(),
    priority: $('#task-priority').value,
  };
  if (!body.title) return;
  try {
    if (editing.id) await api(`/tasks/${editing.id}`, { method: 'PATCH', body });
    else await api(`/projects/${state.currentId}/tasks`, { method: 'POST', body: { ...body, status: editing.status } });
    modal.close();
    await Promise.all([loadTasks(), loadProjects()]);
  } catch (err) { toast(err.message); }
});

$('#task-delete').addEventListener('click', async () => {
  if (!confirm('Delete this task?')) return;
  await api(`/tasks/${editing.id}`, { method: 'DELETE' });
  modal.close();
  await refreshTimer();
  await Promise.all([loadTasks(), loadProjects(), loadEntries()]);
  toast('Task deleted');
});

// ===== Timer =====
async function refreshTimer() {
  const { active } = await api('/timer');
  state.active = active;
  renderTimer();
}

function renderTimer() {
  const bar = $('.timer-bar');
  const btn = $('#timer-btn');
  const a = state.active;
  bar.classList.toggle('running', !!a);
  if (a) {
    btn.textContent = '■ Stop';
    btn.className = 'btn-stop';
    $('#timer-label').innerHTML =
      `<span class="dot" style="display:inline-block;background:${esc(a.project_color)}"></span> ` +
      `${esc(a.project_name)}${a.task_title ? ' › ' + esc(a.task_title) : ''}${a.note ? ' — ' + esc(a.note) : ''}`;
    $('#timer-task').disabled = $('#timer-note').disabled = true;
  } else {
    btn.textContent = '▶ Start';
    btn.className = 'btn-start';
    $('#timer-time').textContent = '00:00:00';
    $('#timer-label').textContent = 'No timer running';
    $('#timer-task').disabled = $('#timer-note').disabled = false;
  }
}

function tickTimer() {
  if (!state.active) return;
  $('#timer-time').textContent = fmtDuration(now() - state.active.started_at);
  // live-update the running task card and project total
  const t = state.tasks.find(x => x.id === state.active.task_id);
  if (t) {
    const el = document.querySelector(`[data-task-time="${t.id}"]`);
    if (el) el.textContent = '⏱ ' + fmtDuration(taskTrackedMs(t));
  }
  const p = state.projects.find(x => x.id === state.active.project_id);
  const pel = p && document.querySelector(`[data-project-time="${p.id}"]`);
  if (pel) pel.textContent = fmtShort(p.tracked_ms + (now() - state.projectsLoadedAt));
}

async function startTimer(taskId = null) {
  if (!state.currentId) return toast('Create a project first');
  try {
    await api('/timer/start', {
      method: 'POST',
      body: { project_id: state.currentId, task_id: taskId, note: $('#timer-note').value.trim() },
    });
    $('#timer-note').value = '';
    await afterTimerChange();
    toast('Timer started');
  } catch (err) { toast(err.message); }
}

async function stopTimer() {
  const { stopped } = await api('/timer/stop', { method: 'POST' });
  await afterTimerChange();
  if (stopped) toast(`Logged ${fmtShort(stopped.ended_at - stopped.started_at)}`);
}

async function afterTimerChange() {
  await Promise.all([loadProjects(), loadTasks(), loadEntries()]);
  await refreshTimer();
  renderBoard();
}

$('#timer-btn').addEventListener('click', () => {
  if (state.active) stopTimer();
  else startTimer(Number($('#timer-task').value) || null);
});

// ===== Time log =====
async function loadEntries() {
  if (!state.currentId) return renderEntries([]);
  renderEntries(await api(`/entries?project_id=${state.currentId}&limit=25`));
}
function renderEntries(entries) {
  $('#entries').innerHTML = entries.map(e => `
    <tr>
      <td>${e.task_title ? esc(e.task_title) : '<span class="muted">Project</span>'}</td>
      <td>${esc(e.note) || '<span class="muted">—</span>'}</td>
      <td>${new Date(e.started_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td>
      <td class="num">${e.ended_at ? fmtDuration(e.ended_at - e.started_at) : '<b style="color:var(--ok)">running…</b>'}</td>
      <td>${e.ended_at ? `<button class="del-entry" data-entry="${e.id}" title="Delete">✕</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">No time tracked yet. Hit ▶ on a task to start.</td></tr>';
}
$('#entries').addEventListener('click', async e => {
  const b = e.target.closest('[data-entry]');
  if (!b) return;
  await api(`/entries/${b.dataset.entry}`, { method: 'DELETE' });
  await Promise.all([loadEntries(), loadTasks(), loadProjects()]);
});

// ===== Boot =====
(async function init() {
  try { await syncTime(); } catch { /* fall back to local time */ }
  tickClock();
  setInterval(() => { tickClock(); tickTimer(); }, 1000);
  setInterval(syncTime, 5 * 60 * 1000);

  await loadProjects();
  await refreshTimer();
  if (state.currentId) await selectProject(state.currentId);
  else renderBoard();
})();
