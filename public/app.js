// WebRTC Mesh Demo 客户端
// 信令协议：joined / peer-joined / peer-left / offer / answer / ice-candidate / bye
// 协商策略：老成员发起 offer + perfect negotiation 处理冲突（glare）

const RTC_CONFIG = {
  // 公网 STUN 仅用于演示；生产环境应部署自己的 STUN/TURN，并由服务端签发临时凭证
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

const PEER_STATE_LABEL = {
  new: { text: '准备中', tone: 'warn' },
  connecting: { text: '连接中', tone: 'warn' },
  connected: { text: '已连接', tone: 'ok' },
  disconnected: { text: '网络中断', tone: 'warn' },
  failed: { text: '连接失败', tone: 'error' },
  closed: { text: '已关闭', tone: 'error' },
};

const MAX_LOG_ITEMS = 200;
const SIGNAL_TIMEOUT_MS = 8000;

const el = {
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  joinForm: document.getElementById('joinForm'),
  roomInput: document.getElementById('roomInput'),
  joinBtn: document.getElementById('joinBtn'),
  leaveBtn: document.getElementById('leaveBtn'),
  copyBtn: document.getElementById('copyBtn'),
  localVideo: document.getElementById('localVideo'),
  localId: document.getElementById('localId'),
  remoteGrid: document.getElementById('remoteGrid'),
  emptyHint: document.getElementById('emptyHint'),
  micBtn: document.getElementById('micBtn'),
  camBtn: document.getElementById('camBtn'),
  shareBtn: document.getElementById('shareBtn'),
  logList: document.getElementById('logList'),
  clearLogBtn: document.getElementById('clearLogBtn'),
};

const state = {
  ws: null,
  myId: null,
  room: '',
  localStream: null,
  cameraTrack: null,
  screenTrack: null,
  micOn: true,
  camOn: true,
  peers: new Map(), // peerId -> peer
  joining: false,
  leaving: false,
};

// ---------------------------------------------------------------- 工具 / 日志

const shortId = (id) => String(id ?? '').slice(0, 6);
const randomRoom = () => `room-${Math.random().toString(36).slice(2, 8)}`;

function log(level, message) {
  const item = document.createElement('li');
  item.className = `log-item log-${level}`;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  item.textContent = `${time}  ${message}`;
  el.logList.prepend(item);

  while (el.logList.children.length > MAX_LOG_ITEMS) {
    el.logList.lastElementChild.remove();
  }
}

function setStatus(text, tone) {
  el.statusText.textContent = text;
  el.statusDot.dataset.tone = tone;
}

function updateEmptyHint() {
  el.emptyHint.hidden = state.peers.size > 0;
}

function setControlsEnabled(enabled) {
  el.micBtn.disabled = !enabled;
  el.camBtn.disabled = !enabled;
  el.shareBtn.disabled = !enabled;
}

function updateUrlRoom(room) {
  const url = new URL(location.href);
  url.searchParams.set('room', room);
  history.replaceState(null, '', url);
}

// ---------------------------------------------------------------- 本地媒体

async function ensureLocalMedia() {
  if (state.localStream) return state.localStream;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前环境无法访问摄像头/麦克风，请用 http://localhost 或 HTTPS 打开页面');
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    });
  } catch (err) {
    throw new Error(`获取摄像头/麦克风失败：${err.message}（请检查浏览器权限）`);
  }

  state.localStream = stream;
  state.cameraTrack = stream.getVideoTracks()[0] ?? null;
  el.localVideo.srcObject = stream;
  el.localVideo.dataset.active = 'true';

  log('info', `本地媒体就绪：${stream.getTracks().map((track) => track.kind).join(' + ')}`);
  return stream;
}

function stopLocalMedia() {
  for (const track of state.localStream?.getTracks() ?? []) track.stop();
  state.screenTrack?.stop();

  state.screenTrack = null;
  state.localStream = null;
  state.cameraTrack = null;
  el.localVideo.srcObject = null;
  el.localVideo.dataset.active = 'false';
  el.localVideo.classList.remove('sharing');
}

function addLocalTracks(peer) {
  if (peer.tracksAdded || !state.localStream) return;
  peer.tracksAdded = true;

  for (const track of state.localStream.getTracks()) {
    const outgoing = track.kind === 'video' && state.screenTrack ? state.screenTrack : track;
    peer.pc.addTrack(outgoing, state.localStream);
  }
}

// ---------------------------------------------------------------- 加入 / 离开

async function join(rawRoom) {
  if (state.joining || state.ws) return;

  state.joining = true;
  el.joinBtn.disabled = true;
  el.roomInput.disabled = true;
  setStatus('连接中…', 'warn');

  try {
    await ensureLocalMedia();
    state.room = rawRoom;
    updateUrlRoom(rawRoom);
    await openSignaling(rawRoom);
  } catch (err) {
    log('error', err.message);
    setStatus('未连接', 'error');
    stopLocalMedia();
    resetJoinUi();
    state.room = '';
  } finally {
    state.joining = false;
  }
}

function openSignaling(room) {
  return new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws?room=${encodeURIComponent(room)}`;
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      ws.close(4002, 'timeout');
      reject(new Error('连接信令服务器超时（8 秒），请确认 npm start 已运行'));
    }, SIGNAL_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(timer);
      state.ws = ws;
      el.joinBtn.disabled = true;
      el.leaveBtn.disabled = false;
      setControlsEnabled(true);
      log('info', `信令通道已建立：${url}`);
      resolve();
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleSignal(msg).catch((err) => log('error', `处理信令消息失败：${err.message}`));
    };

    ws.onclose = (event) => {
      clearTimeout(timer);
      if (state.ws === ws) {
        handleDisconnect(event);
      } else {
        reject(new Error(`无法连接信令服务器（code=${event.code}）`));
      }
    };
  });
}

function leave() {
  if (!state.ws) {
    resetJoinUi();
    return;
  }
  state.leaving = true;
  sendSignal({ type: 'bye' });
  state.ws.close(1000, 'leave');
}

function handleDisconnect(event) {
  const intentional = state.leaving;
  state.leaving = false;
  state.ws = null;
  state.myId = null;
  state.room = '';

  closeAllPeers();
  stopLocalMedia();
  resetJoinUi();

  if (intentional) {
    setStatus('未连接', 'idle');
    log('info', '已离开房间');
  } else {
    setStatus('已断开', 'error');
    const detail = event?.reason ? `，${event.reason}` : '';
    log('warn', `信令连接断开（code=${event?.code ?? '未知'}${detail}），请重新加入`);
  }
}

function resetJoinUi() {
  el.roomInput.disabled = false;
  el.joinBtn.disabled = false;
  el.leaveBtn.disabled = true;
  el.localId.textContent = '—';
  setControlsEnabled(false);

  state.micOn = true;
  state.camOn = true;
  el.micBtn.textContent = '关闭麦克风';
  el.micBtn.dataset.active = 'true';
  el.camBtn.textContent = '关闭摄像头';
  el.camBtn.dataset.active = 'true';
  el.shareBtn.textContent = '共享屏幕';

  updateEmptyHint();
}

// ---------------------------------------------------------------- 信令处理

function sendSignal(payload) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
}

async function handleSignal(msg) {
  switch (msg.type) {
    case 'joined': {
      state.myId = msg.peerId;
      el.localId.textContent = shortId(msg.peerId);
      setStatus('已连接', 'ok');
      log('info', `已加入房间「${msg.roomId}」，房间现有 ${msg.peers.length + 1} 人`);

      if (msg.peers.length === 0) {
        log('info', '等待其他成员加入…（复制当前地址到新标签页）');
      }
      for (const peerId of msg.peers) {
        createPeer(peerId, { initiate: false });
        log('debug', `房间已有成员 ${shortId(peerId)}，等待对方发起 offer`);
      }
      break;
    }
    case 'peer-joined': {
      log('info', `成员 ${shortId(msg.peerId)} 加入，由我方发起协商`);
      createPeer(msg.peerId, { initiate: true });
      break;
    }
    case 'peer-left': {
      log('info', `成员 ${shortId(msg.peerId)} 已离开`);
      closePeer(msg.peerId);
      break;
    }
    case 'offer':
    case 'answer': {
      const peer = state.peers.get(msg.from) ?? createPeer(msg.from, { initiate: false });
      await handleDescription(peer, msg.description);
      break;
    }
    case 'ice-candidate': {
      const peer = state.peers.get(msg.from);
      if (peer) await handleCandidate(peer, msg.candidate);
      break;
    }
    default: {
      log('warn', `收到未知消息类型：${msg.type}`);
    }
  }
}

// ---------------------------------------------------------------- Peer 管理

function createPeer(peerId, { initiate }) {
  const existing = state.peers.get(peerId);
  if (existing) return existing;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const peer = {
    id: peerId,
    pc,
    // 约定：peerId 字典序较大的一方为 polite（冲突时退让），双方算出的结果一致
    polite: Boolean(state.myId) && state.myId > peerId,
    makingOffer: false,
    ignoreOffer: false,
    pendingCandidates: [],
    tracksAdded: false,
    card: null,
    video: null,
    stateEl: null,
  };
  state.peers.set(peerId, peer);
  createPeerCard(peer);
  updateEmptyHint();

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal({ type: 'ice-candidate', to: peerId, candidate });
  };

  pc.ontrack = ({ track, streams }) => {
    const stream = streams[0];
    if (stream) {
      peer.video.srcObject = stream;
      peer.card.classList.add('has-video');
      // autoplay 属性通常已能自动播放；仅当被策略拦截时提示，AbortError 属于正常的加载中断
      peer.video.play().catch((err) => {
        if (err?.name === 'NotAllowedError') {
          log('warn', `远端画面自动播放被拦截，点击 ${shortId(peerId)} 的画面即可播放`);
        }
      });
    }
    log('info', `收到 ${shortId(peerId)} 的 ${track.kind} 轨道`);
    track.addEventListener('unmute', () => peer.card.classList.add('has-video'));
    track.addEventListener('mute', () => peer.card.classList.remove('has-video'));
  };

  pc.onconnectionstatechange = () => {
    const connectionState = pc.connectionState;
    setPeerState(peer, connectionState);
    log('debug', `${shortId(peerId)} 连接状态：${connectionState}`);

    if (connectionState === 'failed') {
      log('warn', `${shortId(peerId)} 连接失败，尝试重启 ICE`);
      pc.restartIce();
    }
  };

  // 只有需要协商时浏览器才会触发；offer 的具体内容由 setLocalDescription() 自动生成
  pc.onnegotiationneeded = () => {
    negotiate(peer).catch((err) => log('error', `与 ${shortId(peerId)} 协商失败：${err.message}`));
  };

  if (initiate) addLocalTracks(peer);

  return peer;
}

function createPeerCard(peer) {
  const card = document.createElement('figure');
  card.className = 'video-card';

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;

  const placeholder = document.createElement('div');
  placeholder.className = 'video-placeholder';
  placeholder.textContent = '等待对方画面…';

  const caption = document.createElement('figcaption');
  const label = document.createElement('span');
  label.className = 'peer-label';
  label.textContent = '对方';
  const idEl = document.createElement('span');
  idEl.className = 'peer-id';
  idEl.textContent = shortId(peer.id);
  const stateEl = document.createElement('span');
  stateEl.className = 'peer-state';
  stateEl.textContent = '连接中';
  stateEl.dataset.tone = 'warn';
  caption.append(label, idEl, stateEl);

  card.append(video, placeholder, caption);
  card.addEventListener('click', () => video.play().catch(() => {}));
  el.remoteGrid.append(card);

  peer.card = card;
  peer.video = video;
  peer.stateEl = stateEl;
}

function setPeerState(peer, connectionState) {
  const info = PEER_STATE_LABEL[connectionState] ?? { text: connectionState, tone: 'warn' };
  peer.stateEl.textContent = info.text;
  peer.stateEl.dataset.tone = info.tone;
}

function closePeer(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer) return;

  state.peers.delete(peerId);
  try {
    peer.pc.close();
  } catch {
    // 忽略重复关闭
  }
  peer.card.remove();
  updateEmptyHint();
  log('debug', `释放与 ${shortId(peerId)} 的连接`);
}

function closeAllPeers() {
  for (const peerId of [...state.peers.keys()]) closePeer(peerId);
}

async function negotiate(peer) {
  const { pc } = peer;
  if (pc.signalingState !== 'stable') return; // 正在协商中，等当前流程结束

  try {
    peer.makingOffer = true;
    await pc.setLocalDescription();
    sendSignal({ type: 'offer', to: peer.id, description: pc.localDescription });
    log('debug', `→ offer → ${shortId(peer.id)}`);
  } finally {
    peer.makingOffer = false;
  }
}

async function handleDescription(peer, description) {
  if (!description || typeof description.sdp !== 'string') return;
  const isOffer = description.type === 'offer';
  if (!isOffer && description.type !== 'answer') return;

  const { pc } = peer;
  // perfect negotiation：双方同时发 offer 时，polite 一方回滚退让
  const collision = isOffer && !peer.ignoreOffer && (peer.makingOffer || pc.signalingState !== 'stable');
  peer.ignoreOffer = !peer.polite && collision;

  if (peer.ignoreOffer) {
    log('warn', `与 ${shortId(peer.id)} 的 offer 冲突，我方不让步，丢弃该 offer`);
    return;
  }
  if (collision) {
    log('warn', `与 ${shortId(peer.id)} 的 offer 冲突，我方回滚并应答`);
  }

  try {
    await pc.setRemoteDescription(description);
    await flushPendingCandidates(peer);

    if (isOffer) {
      addLocalTracks(peer); // 首次应答时补上本地轨道
      await pc.setLocalDescription(); // 浏览器按 signalingState 自动生成 answer
      sendSignal({ type: 'answer', to: peer.id, description: pc.localDescription });
      log('debug', `→ answer → ${shortId(peer.id)}`);
    } else {
      peer.ignoreOffer = false;
    }
  } catch (err) {
    log('error', `处理 ${description.type} 失败：${err.message}`);
  }
}

async function handleCandidate(peer, candidate) {
  if (!candidate) return;
  // 被忽略的 offer 对应的 candidate 也必须丢弃，否则会污染协商状态
  if (peer.ignoreOffer) return;

  if (!peer.pc.remoteDescription) {
    peer.pendingCandidates.push(candidate);
    return;
  }

  try {
    await peer.pc.addIceCandidate(candidate);
  } catch (err) {
    log('warn', `添加 ${shortId(peer.id)} 的 ICE candidate 失败：${err.message}`);
  }
}

async function flushPendingCandidates(peer) {
  const pending = peer.pendingCandidates.splice(0);
  for (const candidate of pending) {
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (err) {
      log('warn', `补加 ICE candidate 失败：${err.message}`);
    }
  }
}

// ---------------------------------------------------------------- 通话控制

function toggleMic() {
  if (!state.localStream) return;
  state.micOn = !state.micOn;
  for (const track of state.localStream.getAudioTracks()) track.enabled = state.micOn;

  el.micBtn.textContent = state.micOn ? '关闭麦克风' : '开启麦克风';
  el.micBtn.dataset.active = String(state.micOn);
  log('info', state.micOn ? '麦克风已开启' : '麦克风已静音');
}

function toggleCamera() {
  if (!state.cameraTrack) return;
  state.camOn = !state.camOn;
  state.cameraTrack.enabled = state.camOn;

  el.camBtn.textContent = state.camOn ? '关闭摄像头' : '开启摄像头';
  el.camBtn.dataset.active = String(state.camOn);
  log('info', state.camOn ? '摄像头已开启' : '摄像头已关闭');
}

function senderOf(peer, kind) {
  return peer.pc.getSenders().find((sender) => sender.track?.kind === kind) ?? null;
}

async function toggleScreenShare() {
  if (state.screenTrack) {
    await stopScreenShare();
  } else {
    await startScreenShare();
  }
}

async function startScreenShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    log('error', '当前浏览器不支持屏幕共享（getDisplayMedia 不可用）');
    return;
  }

  let displayStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
  } catch (err) {
    log('warn', `已取消共享屏幕：${err.message}`);
    return;
  }

  const track = displayStream.getVideoTracks()[0];
  if (!track) return;

  state.screenTrack = track;
  track.addEventListener('ended', () => {
    stopScreenShare().catch((err) => log('error', `停止共享失败：${err.message}`));
  });

  // replaceTrack 不改变 m-line，因此无需重新协商
  for (const peer of state.peers.values()) {
    const sender = senderOf(peer, 'video');
    if (!sender) continue;
    try {
      await sender.replaceTrack(track);
    } catch (err) {
      log('warn', `切换共享轨道失败：${err.message}`);
    }
  }

  el.localVideo.srcObject = new MediaStream([track, ...(state.localStream?.getAudioTracks() ?? [])]);
  el.localVideo.classList.add('sharing');
  el.localVideo.dataset.active = 'true';
  el.camBtn.disabled = true;
  el.shareBtn.textContent = '停止共享';
  log('info', '开始共享屏幕（replaceTrack，无需重新协商）');
}

async function stopScreenShare() {
  const track = state.screenTrack;
  if (!track) return;
  state.screenTrack = null;

  for (const peer of state.peers.values()) {
    const sender = senderOf(peer, 'video');
    if (!sender || !state.cameraTrack) continue;
    try {
      await sender.replaceTrack(state.cameraTrack);
    } catch (err) {
      log('warn', `恢复摄像头轨道失败：${err.message}`);
    }
  }

  track.stop();
  el.localVideo.srcObject = state.localStream;
  el.localVideo.classList.remove('sharing');
  el.camBtn.disabled = false;
  el.shareBtn.textContent = '共享屏幕';
  log('info', '已停止共享屏幕');
}

async function copyInviteLink() {
  const url = new URL(location.href);
  url.searchParams.set('room', state.room || el.roomInput.value.trim() || randomRoom());
  const text = url.toString();

  try {
    await navigator.clipboard.writeText(text);
    log('info', `邀请链接已复制：${text}`);
  } catch {
    log('warn', `浏览器未允许自动复制，请手动复制：${text}`);
  }
}

// ---------------------------------------------------------------- 初始化

function init() {
  const roomFromUrl = new URL(location.href).searchParams.get('room');
  el.roomInput.value = roomFromUrl || randomRoom();

  el.joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const room = el.roomInput.value.trim() || randomRoom();
    join(room);
  });

  el.leaveBtn.addEventListener('click', leave);
  el.micBtn.addEventListener('click', toggleMic);
  el.camBtn.addEventListener('click', toggleCamera);
  el.shareBtn.addEventListener('click', () => {
    toggleScreenShare().catch((err) => log('error', `屏幕共享出错：${err.message}`));
  });
  el.copyBtn.addEventListener('click', () => {
    copyInviteLink().catch((err) => log('error', `复制失败：${err.message}`));
  });
  el.clearLogBtn.addEventListener('click', () => el.logList.replaceChildren());

  window.addEventListener('beforeunload', () => {
    state.ws?.close();
  });

  setControlsEnabled(false);
  setStatus('未连接', 'idle');
  updateEmptyHint();
  log('info', '页面已就绪。点击「加入房间」，再把地址复制到另一个标签页即可互连。');
}

init();
