import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { api } from './api.ts';
import { openDb } from './db.ts';
import { attachSsh } from './ssh.ts';
import { fileApi } from './files.ts';
import type { FileCredentialStorage } from './credentials.ts';

export function createOpsDeckServer({ directory, frontend, origin, authorize, fileCredentialStorage }: {
  directory: string; frontend: string; origin?: string; authorize?: (request: IncomingMessage) => boolean;
  fileCredentialStorage?: FileCredentialStorage;
}) {
  function allowsOrigin(requestOrigin?: string, host?: string) {
    if (!requestOrigin) return false;
    return origin ? requestOrigin === origin : requestOrigin === `http://${host}` || requestOrigin === `https://${host}`;
  }
  const db = openDb(directory);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    if (authorize) {
      if (!authorize(req)) { res.sendStatus(403); return; }
      res.set('Content-Security-Policy', `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self'; connect-src 'self' ${origin?.replace(/^http/, 'ws')}; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    }
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method) && !allowsOrigin(req.headers.origin, req.headers.host)) {
      res.status(403).json({ error: 'Request must originate from OpsDeck' });
      return;
    }
    next();
  });
  const files = fileApi(db, fileCredentialStorage);
  app.use('/api/files', files.router);
  app.use('/api/clients/:clientId/agent-conversations', express.json({ limit: '64mb' }));
  app.use('/api', express.json({ limit: '2mb' }), api(db));

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
  server.on('close', () => files.close());
  attachSsh(server, db, allowsOrigin, authorize, fileCredentialStorage);
  return { server, db };
}
