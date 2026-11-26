# Hello World: Projects, Kanban & Timer

A small full-stack app built with **Node.js + Express + PostgreSQL**. The frontend is vanilla HTML/CSS/JS with no build step.

## Features
- Live clock, synced to the server's time
- Projects with a color, task count and total tracked time
- Kanban board (To Do / In Progress / Review / Done) with drag-and-drop. The order is saved in the database
- Tasks with a title, description and priority
- A server-side timer for a project or a task. Only one runs at a time, and it survives a page refresh
- A time log for each project

## Run locally
```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/app npm start
# open http://localhost:3000
```
The tables are created automatically on startup (from `schema.sql`), and a demo project is added on first run.

## Env vars
- `DATABASE_URL`: PostgreSQL connection string (required)
- `PORT`: defaults to 3000
