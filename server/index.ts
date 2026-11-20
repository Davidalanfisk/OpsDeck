import { resolve } from 'node:path';
import { createOpsDeckServer } from './app.ts';

const { server } = createOpsDeckServer({
  directory: process.env.DATA_DIR || 'data',
  frontend: resolve('dist'),
  origin: process.env.OPSDECK_ORIGIN ? new URL(process.env.OPSDECK_ORIGIN).origin : undefined,
});
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`OpsDeck listening on ${host}:${port}`));
