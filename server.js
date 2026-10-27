// WebRTC Mesh Demo 信令服务器
// 职责：只做「房间成员管理 + SDP / ICE 消息转发」，不接触媒体数据。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const MAX_PEERS_PER_ROOM = 4; // 纯 P2P mesh 的上限，再多就该换 SFU
const MAX_MESSAGE_BYTES = 64 * 1024; // SDP 很小，限制单条消息体积
const HEARTBEAT_MS = 30_000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------- 工具

const log = (...args) => console.log(new Date().toISOString(), ...args);
const shortId = (id) => String(id).slice(0, 6);

/** roomId -> Map<peerId, WebSocket> */
const rooms = new Map();

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }
  return room;
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function respondText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function normalizeRoomId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().slice(0, 64);
  if (!id || /[\u0000-\u001f\u007f]/.test(id)) return null;
  return id;
}

/** 把 URL 路径解析成 public 目录下的真实文件，越界返回 null */
function resolveStaticFile(pathname) {
  const rel = normalize(pathname.endsWith('/') ? `${pathname}index.html` : pathname)
    .replace(/^[\\/]+/, '');
  if (!rel) return null;
  const file = join(PUBLIC_DIR, rel);
  return file.startsWith(PUBLIC_DIR) ? file : null;
}

// ---------------------------------------------------------------- HTTP 静态资源

const httpServer = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return respondText(res, 405, 'Method Not Allowed');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    return respondText(res, 400, 'Bad Request');
  }

  const file = resolveStaticFile(pathname);
  if (!file) return respondText(res, 403, 'Forbidden');

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.byteLength,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    respondText(res, 404, 'Not Found');
  }
});

// ---------------------------------------------------------------- WebSocket 信令

const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  maxPayload: MAX_MESSAGE_BYTES,
});

wss.on('connection', (ws, req) => {
  const roomId = normalizeRoomId(new URL(req.url ?? '/', 'http://localhost').searchParams.get('room'));
  if (!roomId) return ws.close(4000, 'invalid room');

  const room = getRoom(roomId);
  if (room.size >= MAX_PEERS_PER_ROOM) {
    log(`拒绝加入：房间 ${roomId} 已满（${room.size}/${MAX_PEERS_PER_ROOM}）`);
    return ws.close(4001, 'room is full');
  }

  // peerId 由服务端生成，客户端无法伪造成员身份
  const peerId = randomUUID();
  ws.peerId = peerId;
  ws.roomId = roomId;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('error', (err) => log(`peer ${shortId(peerId)} 连接异常：${err.message}`));

  room.set(peerId, ws);
  log(`+ ${shortId(peerId)} 加入 ${roomId}（${room.size} 人）`);

  // 1) 告诉新人：我是谁、房间里还有谁
  sendJson(ws, {
    type: 'joined',
    peerId,
    roomId,
    peers: [...room.keys()].filter((id) => id !== peerId),
  });

  // 2) 告诉老成员：有人进来了（由老成员负责发 offer）
  for (const [id, peer] of room) {
    if (id !== peerId) sendJson(peer, { type: 'peer-joined', peerId });
  }

  ws.on('message', (raw) => handleSignal(ws, raw));
  ws.on('close', () => removePeer(ws, '连接关闭'));
});

function handleSignal(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'bye') {
    removePeer(ws, '客户端主动离开');
    ws.terminate();
    return;
  }

  if (msg.type !== 'offer' && msg.type !== 'answer' && msg.type !== 'ice-candidate') return;
  if (typeof msg.to !== 'string') return;

  const room = rooms.get(ws.roomId);
  const target = room?.get(msg.to);
  if (!target || target === ws) return;

  if (msg.type === 'ice-candidate') {
    sendJson(target, { type: 'ice-candidate', from: ws.peerId, candidate: msg.candidate ?? null });
    return;
  }

  const description = msg.description;
  const validType = description?.type === 'offer' || description?.type === 'answer';
  if (!validType || typeof description.sdp !== 'string') return;

  // 只透传必要字段，并强制覆盖 from
  sendJson(target, {
    type: msg.type,
    from: ws.peerId,
    description: { type: description.type, sdp: description.sdp },
  });
}

function removePeer(ws, reason) {
  const room = rooms.get(ws.roomId);
  if (!room || room.get(ws.peerId) !== ws) return; // 已移除过，避免重复广播

  room.delete(ws.peerId);
  log(`- ${shortId(ws.peerId)} 离开 ${ws.roomId}（${reason}），剩余 ${room.size} 人`);

  if (room.size === 0) {
    rooms.delete(ws.roomId);
    return;
  }
  for (const peer of room.values()) sendJson(peer, { type: 'peer-left', peerId: ws.peerId });
}

// ---------------------------------------------------------------- 心跳 & 退出

const heartbeat = setInterval(() => {
  for (const room of rooms.values()) {
    for (const ws of room.values()) {
      if (!ws.isAlive) {
        log(`清理失联连接 ${shortId(ws.peerId)}（${ws.roomId}）`);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref();

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，正在关闭…`);

    clearInterval(heartbeat);
    for (const room of rooms.values()) {
      for (const ws of room.values()) ws.close(1001, 'server shutdown');
    }
    wss.close(() => httpServer.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

httpServer.listen(PORT, HOST, () => {
  log(`信令服务器已启动：http://localhost:${PORT}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    log(`注意：正在监听 ${HOST} 且没有鉴权，仅建议用于本地/局域网开发，请勿直接暴露到公网`);
  }
});
