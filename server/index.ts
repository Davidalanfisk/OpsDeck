import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { api } from './api.ts';
import { openDb } from './db.ts';
import { attachSsh } from './ssh.ts';

const configuredOrigin = process.env.OPSDECK_ORIGIN ? new URL(process.env.OPSDECK_ORIGIN).origin : undefined;
function allowsOrigin(origin?: string, host?: string) {
  if (!origin) return false;
  return configuredOrigin ? origin === configuredOrigin : origin === `http://${host}` || origin === `https://${host}`;
}

const db = openDb(process.env.DATA_DIR || 'data');
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
  next();
});
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!['GET', 'HEAD'].includes(req.method) && !allowsOrigin(req.headers.origin, req.headers.host)) {
    res.status(403).json({ error: 'Request must originate from OpsDeck' });
    return;
  }
  next();
}, express.json({ limit: '2mb' }), api(db));

const frontend = resolve('dist');
app.use(express.static(frontend));
app.get('/', (_req, res) => { res.sendFile(resolve(frontend, 'index.html')); });
const handleError: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) { next(error); return; }
  if (error instanceof ZodError) {
    res.status(400).json({ error: error.issues.map(issue => `${issue.path.join('.') || 'Request'}: ${issue.message}`).join('; ') });
  } else if (error.status === 400 || error.status === 413 || error.status === 404) {
    res.status(error.status).json({ error: error.status === 413 ? 'Request too large' : error.status === 404 ? 'Not found' : 'Invalid request' });
  } else {
    console.error(error);
    res.status(500).json({ error: 'OpsDeck could not complete the request' });
  }
};
app.use(handleError);
const server = createServer(app);
attachSsh(server, db, allowsOrigin);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`OpsDeck listening on ${host}:${port}`));
