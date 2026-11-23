import { once } from 'node:events';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { createServer as netServer } from 'node:net';
import { TLSSocket, createSecureContext, createServer as tlsServer } from 'node:tls';
import ssh2 from 'ssh2';

export const text = Buffer.from('\uFEFF<?php\r\n// fixture\r\necho "hello";\r\n');
export const settings = { name: 'Local fixture', host: '127.0.0.1', username: 'operator' };

export async function ftpFixture(t, tls) {
  const files = new Map([['/fixture.php', Buffer.from(text)], ['/binary.bin', Buffer.from([0, 255, 1])]]);
  const directories = new Set();
  const sockets = new Set();
  const dataServers = new Set();
  const commands = [];
  function track(socket) {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    return socket;
  }
  const handler = original => {
    let control = track(original);
    let secure = Boolean(tls?.implicit);
    let buffered = '';
    let passive;
    let data;
    let rename;
    const reply = message => control.write(`${message}\r\n`);
    const line = async raw => {
      const space = raw.indexOf(' ');
      const command = (space < 0 ? raw : raw.slice(0, space)).toUpperCase();
      const arg = space < 0 ? '' : raw.slice(space + 1);
      commands.push(command);
      if (command === 'AUTH' && tls) {
        reply('234 TLS accepted');
        original.off('data', input);
        control = track(new TLSSocket(original, { isServer: true, secureContext: createSecureContext(tls) }));
        secure = true;
        control.on('data', input);
      } else if (command === 'USER') reply('331 Password required');
      else if (command === 'PASS') reply(arg === 'fixture-password' ? '230 Logged in' : '530 Invalid credentials');
      else if (command === 'FEAT') reply('211-Features\r\n MLST type*;size*;modify*;\r\n EPSV\r\n211 End');
      else if (['TYPE', 'STRU', 'PBSZ', 'PROT', 'OPTS', 'SITE'].includes(command)) reply('200 OK');
      else if (command === 'PWD') reply('257 "/"');
      else if (command === 'CWD') reply('250 Directory changed');
      else if (command === 'MKD') {
        if (directories.has(arg) || files.has(arg)) reply('550 Already exists');
        else { directories.add(arg); reply('257 Created'); }
      }
      else if (command === 'EPSV') {
        passive = secure ? tlsServer(tls) : netServer();
        dataServers.add(passive);
        passive.on('error', () => {});
        data = new Promise(resolve => passive.once(secure ? 'secureConnection' : 'connection', socket => {
          track(socket);
          resolve(socket);
          passive.close();
        }));
        passive.listen(0, '127.0.0.1');
        await once(passive, 'listening');
        reply(`229 Entering Extended Passive Mode (|||${passive.address().port}|)`);
      } else if (['MLSD', 'LIST', 'RETR', 'STOR'].includes(command)) {
        reply('150 Opening data connection');
        const socket = await data;
        if (command === 'MLSD' || command === 'LIST') {
          socket.end([...directories].map(path => `type=dir;size=0; ${path.slice(1)}\r\n`).join('') +
            [...files].map(([path, value]) => `type=file;size=${value.length};modify=20260101000000; ${path.slice(1)}\r\n`).join(''));
          reply('226 Complete');
        } else if (command === 'RETR') {
          const value = files.get(arg);
          if (!value) { socket.end(); reply('550 Not found'); return; }
          socket.end(value); reply('226 Complete');
        } else {
          const chunks = [];
          socket.on('data', chunk => chunks.push(chunk));
          socket.on('end', () => { files.set(arg, Buffer.concat(chunks)); reply('226 Complete'); });
        }
      } else if (command === 'SIZE') reply(files.has(arg) ? `213 ${files.get(arg).length}` : '550 Not found');
      else if (command === 'RNFR') { rename = arg; reply('350 Ready'); }
      else if (command === 'RNTO') { files.set(arg, files.get(rename)); files.delete(rename); reply('250 Renamed'); }
      else if (command === 'DELE') { files.delete(arg); reply('250 Deleted'); }
      else if (command === 'QUIT') { reply('221 Bye'); control.end(); }
      else reply('502 Unsupported');
    };
    function input(chunk) {
      buffered += chunk.toString();
      let end;
      while ((end = buffered.indexOf('\r\n')) >= 0) {
        const raw = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        void line(raw).catch(error => { console.error(error); control.destroy(); });
      }
    }
    control.on('data', input);
    reply('220 OpsDeck local FTP fixture');
  };
  const server = tls?.implicit ? tlsServer(tls, handler) : netServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const passive of dataServers) if (passive.listening) passive.close();
    await new Promise(resolve => server.close(resolve));
  });
  return { files, directories, commands, connection: { ...settings, type: tls ? 'FTPS' : 'FTP', port: server.address().port, tls_mode: tls?.implicit ? 'implicit' : 'explicit' } };
}

export async function sftpFixture(t, identity) {
  const files = new Map([['/fixture.php', Buffer.from(text)], ['/binary.bin', Buffer.from([0, 255, 1])]]);
  const directories = new Set(['/']);
  const modes = new Map([['/fixture.php', 0o100640]]);
  const clients = new Set();
  const offered = [];
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const fingerprint = `SHA256:${createHash('sha256').update(ssh2.utils.parseKey(privateKey).getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', context => {
      if (identity && context.method === 'publickey') {
        offered.push(context.key.data);
        if (context.username === 'operator' && context.key.data.equals(identity.getPublicSSH()) &&
            (!context.signature || identity.verify(context.blob, context.signature, context.hashAlgo))) context.accept();
        else context.reject(['publickey']);
      } else if (!identity && context.method === 'password' && context.username === 'operator' && context.password === 'fixture-password') context.accept();
      else context.reject(['password']);
    });
    client.on('session', accept => {
      const session = accept();
      session.on('pty', acceptPty => acceptPty());
      session.on('shell', acceptShell => {
        const channel = acceptShell();
        channel.on('data', data => channel.write(data));
      });
      session.on('sftp', acceptSftp => {
        const stream = acceptSftp();
        const handles = new Map();
        let sequence = 0;
        const attrs = path => ({ mode: directories.has(path) ? 0o040755 : modes.get(path) ?? 0o100600, size: files.get(path)?.length ?? 0, uid: 0, gid: 0, atime: 1, mtime: 1 });
        const status = (id, code = 0) => stream.status(id, code);
        const createHandle = (id, value) => {
          const handle = Buffer.alloc(4); handle.writeUInt32BE(++sequence);
          handles.set(handle.toString('hex'), value); stream.handle(id, handle);
        };
        stream.on('REALPATH', (id, path) => stream.name(id, [{ filename: path === '.' ? '/' : path, longname: '', attrs: attrs('/') }]));
        const stat = (id, path) => files.has(path) || directories.has(path) ? stream.attrs(id, attrs(path)) : status(id, 2);
        stream.on('STAT', stat); stream.on('LSTAT', stat);
        stream.on('OPENDIR', (id, path) => directories.has(path) ? createHandle(id, { dir: true, path }) : status(id, 2));
        stream.on('READDIR', (id, handle) => {
          const value = handles.get(handle.toString('hex'));
          if (value.done) { status(id, 1); return; }
          value.done = true;
          const prefix = value.path === '/' ? '/' : `${value.path}/`;
          const paths = [...directories, ...files.keys()].filter(path => path.startsWith(prefix) && path !== value.path && !path.slice(prefix.length).includes('/'));
          stream.name(id, paths.map(path => ({ filename: path.slice(prefix.length), longname: '', attrs: attrs(path) })));
        });
        stream.on('MKDIR', (id, path) => {
          if (directories.has(path) || files.has(path)) status(id, 4);
          else { directories.add(path); status(id); }
        });
        stream.on('OPEN', (id, path, flags, info) => {
          if (flags & 8) {
            if ((flags & 32) && files.has(path)) { status(id, 4); return; }
            files.set(path, Buffer.alloc(0)); modes.set(path, 0o100000 | (info.mode ?? 0o600));
          }
          if (!files.has(path)) { status(id, 2); return; }
          createHandle(id, { path });
        });
        stream.on('READ', (id, handle, offset, length) => {
          const file = files.get(handles.get(handle.toString('hex')).path);
          if (offset >= file.length) status(id, 1);
          else stream.data(id, file.subarray(offset, offset + length));
        });
        stream.on('WRITE', (id, handle, offset, data) => {
          const path = handles.get(handle.toString('hex')).path;
          const old = files.get(path); const next = Buffer.alloc(Math.max(old.length, offset + data.length));
          old.copy(next); data.copy(next, offset); files.set(path, next); status(id);
        });
        stream.on('FSTAT', (id, handle) => stat(id, handles.get(handle.toString('hex')).path));
        stream.on('CLOSE', (id, handle) => { handles.delete(handle.toString('hex')); status(id); });
        stream.on('SETSTAT', (id, path, info) => { if (info.mode !== undefined) modes.set(path, 0o100000 | info.mode); status(id); });
        stream.on('REMOVE', (id, path) => { files.delete(path); modes.delete(path); status(id); });
        const rename = (id, source, target) => {
          files.set(target, files.get(source)); files.delete(source);
          modes.set(target, modes.get(source)); modes.delete(source); status(id);
        };
        stream.on('RENAME', rename);
        stream.on('EXTENDED', (id, name, ...args) => name === 'posix-rename@openssh.com' ? rename(id, ...args) : status(id, 8));
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const client of clients) client.end();
    await new Promise(resolve => server.close(resolve));
  });
  return { files, directories, modes, offered, connection: { ...settings, type: 'SFTP', port: server.address().port, fingerprint, auth_method: 'password' } };
}
