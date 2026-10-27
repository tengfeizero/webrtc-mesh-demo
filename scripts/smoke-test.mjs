import { WebSocket } from 'ws';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = !process.env.HOST || process.env.HOST === '0.0.0.0' ? '127.0.0.1' : process.env.HOST;
const BASE = `http://${HOST}:${PORT}`;
const WS_BASE = `ws://${HOST}:${PORT}/ws`;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(room) {
  const ws = new WebSocket(`${WS_BASE}?room=${encodeURIComponent(room)}`);
  ws.inbox = [];
  ws.closed = null;
  ws.on('message', (data) => ws.inbox.push(JSON.parse(data.toString())));
  ws.on('close', (code, reason) => {
    ws.closed = { code, reason: reason.toString() };
  });
  ws.on('error', () => {});
  return new Promise((resolve) => {
    ws.on('open', () => resolve(ws));
    ws.on('close', () => resolve(ws));
  });
}

async function next(ws, type, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const index = ws.inbox.findIndex((msg) => msg.type === type);
    if (index >= 0) return ws.inbox.splice(index, 1)[0];
    await wait(20);
  }
  throw new Error(`等待 ${type} 超时，inbox=${JSON.stringify(ws.inbox)}`);
}

async function main() {
  // 1. 静态资源
  const home = await fetch(`${BASE}/`);
  const html = await home.text();
  check('GET / 返回 200', home.status === 200, `status=${home.status}`);
  check('首页包含本地 video 标签', html.includes('<video id="localVideo"'), `length=${html.length}`);

  const css = await fetch(`${BASE}/style.css`);
  check('GET /style.css 返回 200', css.status === 200, `status=${css.status}`);

  const js = await fetch(`${BASE}/app.js`);
  check('GET /app.js 返回 JS MIME', js.status === 200 && (js.headers.get('content-type') ?? '').includes('javascript'));

  // 2. 目录穿越防护：不能读到 public 之外的文件
  const traversal = await fetch(`${BASE}/..%2Fpackage.json`);
  const traversalBody = await traversal.text();
  check(
    '拒绝目录穿越',
    [403, 404].includes(traversal.status) && !traversalBody.includes('"dependencies"'),
    `status=${traversal.status}`,
  );

  const traversal2 = await fetch(`${BASE}/%2e%2e/%2e%2e/Windows/win.ini`);
  check('多级目录穿越被拦截', [403, 404].includes(traversal2.status), `status=${traversal2.status}`);

  // 3. 房间与转发
  const room = `smoke-${Date.now()}`;
  const a = await connect(room);
  const joinedA = await next(a, 'joined');
  check('A 收到 joined', typeof joinedA.peerId === 'string' && joinedA.peers.length === 0, JSON.stringify(joinedA.peers));

  const b = await connect(room);
  const joinedB = await next(b, 'joined');
  check('B 收到 joined 且包含 A', joinedB.peers.length === 1 && joinedB.peers[0] === joinedA.peerId);

  const peerJoined = await next(a, 'peer-joined');
  check('A 收到 peer-joined(B)', peerJoined.peerId === joinedB.peerId);

  b.send(JSON.stringify({
    type: 'offer',
    to: joinedA.peerId,
    description: { type: 'offer', sdp: 'v=0\r\nfake-offer' },
    from: 'forged-id',
  }));
  const offer = await next(a, 'offer');
  check('offer 被转发给 A', offer.description.sdp === 'v=0\r\nfake-offer');
  check('服务端覆盖伪造的 from', offer.from === joinedB.peerId, `from=${offer.from}`);

  a.send(JSON.stringify({
    type: 'answer',
    to: joinedB.peerId,
    description: { type: 'answer', sdp: 'v=0\r\nfake-answer' },
  }));
  const answer = await next(b, 'answer');
  check('answer 被转发给 B', answer.description.sdp === 'v=0\r\nfake-answer' && answer.from === joinedA.peerId);

  b.send(JSON.stringify({ type: 'ice-candidate', to: joinedA.peerId, candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5000 typ host', sdpMid: '0' } }));
  const candidate = await next(a, 'ice-candidate');
  check('ice-candidate 被转发给 A', candidate.candidate?.candidate?.includes('1.2.3.4'));

  // 非法目标应被静默丢弃
  b.send(JSON.stringify({ type: 'offer', to: 'not-exist', description: { type: 'offer', sdp: 'x' } }));
  b.send(JSON.stringify({ type: 'offer', to: joinedB.peerId, description: { type: 'offer', sdp: 'self' } }));
  await wait(200);
  check('非法 to 不会产生任何投递', a.inbox.length === 0 && b.inbox.length === 0, `a=${a.inbox.length} b=${b.inbox.length}`);

  // 4. 房间人数上限
  const c = await connect(room);
  await next(c, 'joined');
  const d = await connect(room);
  await next(d, 'joined');
  const e = await connect(room);
  await wait(300);
  check('第 5 人被拒绝（4001）', e.closed?.code === 4001, JSON.stringify(e.closed));

  // 5. 离开广播
  b.send(JSON.stringify({ type: 'bye' }));
  const peerLeft = await next(a, 'peer-left');
  check('B 主动离开，A 收到 peer-left', peerLeft.peerId === joinedB.peerId);

  for (const socket of [a, c, d, e]) socket.close();
  await wait(200);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('SMOKE ERROR', err);
  process.exitCode = 1;
});
