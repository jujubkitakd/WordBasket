const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const INITIAL_HAND = 7;
const ROOM_TTL_MS = 10 * 60 * 1000;
const LOCK_ENABLE = true;

const DECK_BASE = [
  'あ','い','う','え','お','か','き','く','け','こ','さ','し','す','せ','そ','た','ち','つ','て','と',
  'な','に','ぬ','ね','の','は','ひ','ふ','へ','ほ','ま','み','む','め','も','や','ゆ','よ','ら','り',
  'る','れ','ろ','わ','を','ん','が','ぎ','ぐ','げ','ご','ざ','じ','ず','ぜ','ぞ','だ','ぢ','づ','で','ど',
  'ば','び','ぶ','べ','ぼ','ぱ','ぴ','ぷ','ぺ','ぽ'
];

const rooms = new Map();
const socketToPlayer = new WeakMap();

class TinyWS {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.readyState = 1;
    this.handlers = { message: [], close: [] };
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose());
    socket.on('end', () => this._onClose());
    socket.on('error', () => this._onClose());
  }

  on(event, handler) {
    this.handlers[event]?.push(handler);
  }

  _emit(event, payload) {
    for (const h of this.handlers[event] || []) h(payload);
  }

  _onClose() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this._emit('close');
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b1 = this.buffer[0];
      const b2 = this.buffer[1];
      const opcode = b1 & 0x0f;
      const masked = (b2 & 0x80) !== 0;
      let len = b2 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const n = this.buffer.readBigUInt64BE(2);
        if (n > BigInt(Number.MAX_SAFE_INTEGER)) return this.close();
        len = Number(n);
        offset = 10;
      }

      const maskBytes = masked ? 4 : 0;
      if (this.buffer.length < offset + maskBytes + len) return;

      let payload = this.buffer.subarray(offset + maskBytes, offset + maskBytes + len);
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i += 1) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
      }

      this.buffer = this.buffer.subarray(offset + maskBytes + len);

      if (opcode === 0x8) return this.close();
      if (opcode === 0x1) this._emit('message', payload.toString('utf8'));
    }
  }

  send(data) {
    if (this.readyState !== 1) return;
    const payload = Buffer.from(String(data));
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  close() {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    this.socket.end(Buffer.from([0x88, 0x00]));
    this._onClose();
  }
}

function wsAcceptValue(key) {
  return crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function createDeck() {
  const deck = [];
  for (let i = 0; i < 3; i += 1) deck.push(...DECK_BASE);
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

const now = () => Date.now();
const ensureRoomActivity = (room) => { room.lastActiveAt = now(); };

function generateRoomId() {
  for (let i = 0; i < 20000; i += 1) {
    const id = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    if (!rooms.has(id)) return id;
  }
  throw new Error('No room ID available');
}

function createRoom() {
  const roomId = generateRoomId();
  const deck = createDeck();
  const room = {
    roomId,
    state: {
      roomId,
      status: 'WAITING',
      players: [],
      deck,
      deckIndex: 1,
      deckCount: deck.length - 1,
      currentChar: deck[0],
      lastPlay: null,
      winner: null,
      stateVersion: 1,
      lastAction: null
    },
    sockets: new Map(),
    playLock: false,
    lastActiveAt: now()
  };
  rooms.set(roomId, room);
  return room;
}

function publicRoomState(room, forPlayerId) {
  const st = room.state;
  return {
    roomId: st.roomId,
    status: st.status,
    players: st.players.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      connected: p.connected,
      handCount: p.hand.length,
      hand: p.playerId === forPlayerId ? [...p.hand] : undefined,
      score: p.score
    })),
    deckCount: Math.max(0, st.deck.length - st.deckIndex),
    currentChar: st.currentChar,
    lastPlay: st.lastPlay,
    winner: st.winner,
    stateVersion: st.stateVersion,
    lastAction: st.lastAction
  };
}

function send(ws, type, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
}

function broadcastRoom(room, type, payloadBuilder) {
  for (const [pid, ws] of room.sockets.entries()) {
    const payload = typeof payloadBuilder === 'function' ? payloadBuilder(pid) : payloadBuilder;
    send(ws, type, payload);
  }
}

function syncRoom(room) {
  broadcastRoom(room, 'state_sync', (pid) => ({ roomState: publicRoomState(room, pid) }));
}

function reject(ws, type, reason, room, pid) {
  send(ws, type, { accepted: false, reason, roomState: room ? publicRoomState(room, pid) : undefined });
}

function joinRoom(ws, roomId, name) {
  const room = rooms.get(roomId);
  if (!room) return send(ws, 'error', { message: 'ROOM_NOT_FOUND' });
  if (room.state.players.filter((p) => p.connected).length >= MAX_PLAYERS) return send(ws, 'room_full', { roomId });

  const playerId = `p${crypto.randomUUID().slice(0, 8)}`;
  const playerName = (name || 'Player').trim().slice(0, 16) || 'Player';
  const hand = [];
  for (let i = 0; i < INITIAL_HAND; i += 1) {
    if (room.state.deckIndex >= room.state.deck.length) break;
    hand.push(room.state.deck[room.state.deckIndex]);
    room.state.deckIndex += 1;
  }

  room.state.players.push({ playerId, name: playerName, connected: true, hand, score: 0 });
  room.state.deckCount = room.state.deck.length - room.state.deckIndex;
  if (room.state.players.length >= 2 && room.state.status === 'WAITING') room.state.status = 'PLAYING';
  room.state.stateVersion += 1;
  ensureRoomActivity(room);

  room.sockets.set(playerId, ws);
  socketToPlayer.set(ws, { roomId, playerId });

  send(ws, 'join_ok', { playerId, roomState: publicRoomState(room, playerId) });
  syncRoom(room);
}

function handlePlay(ws, payload) {
  const { roomId, playerId, endChar, word } = payload || {};
  const room = rooms.get(roomId);
  if (!room) return reject(ws, 'play_result', 'ROOM_NOT_FOUND');
  ensureRoomActivity(room);
  if (LOCK_ENABLE && room.playLock) return reject(ws, 'play_result', 'RACE_LOST', room, playerId);
  room.playLock = true;

  try {
    const st = room.state;
    const player = st.players.find((p) => p.playerId === playerId);
    if (!player || !player.connected) return reject(ws, 'play_result', 'INVALID_INPUT', room, playerId);
    if (st.status !== 'PLAYING' || st.winner) return reject(ws, 'play_result', 'INVALID_INPUT', room, playerId);

    const normalizedWord = String(word || '').trim();
    const normalizedEndChar = String(endChar || '').trim();
    if (!normalizedWord || normalizedWord.length < 2 || normalizedEndChar.length !== 1) return reject(ws, 'play_result', 'INVALID_INPUT', room, playerId);

    if (normalizedWord[0] !== st.currentChar || normalizedWord[normalizedWord.length - 1] !== normalizedEndChar) {
      return reject(ws, 'play_result', 'WORD_PATTERN_MISMATCH', room, playerId);
    }

    const handIdx = player.hand.indexOf(normalizedEndChar);
    if (handIdx === -1) return reject(ws, 'play_result', 'NOT_IN_HAND', room, playerId);
    if (st.deckIndex >= st.deck.length) return reject(ws, 'play_result', 'INVALID_INPUT', room, playerId);

    const prevCurrentChar = st.currentChar;
    const prevDeckIndex = st.deckIndex;
    const drawnChar = st.deck[st.deckIndex];
    const actionId = crypto.randomUUID();

    player.hand.splice(handIdx, 1);
    player.score = (player.score || 0) + 1;
    st.currentChar = drawnChar;
    st.deckIndex += 1;
    st.deckCount = st.deck.length - st.deckIndex;
    st.lastPlay = { playerId: player.playerId, name: player.name, word: normalizedWord, endChar: normalizedEndChar, ts: now() };
    st.lastAction = {
      actionId,
      type: 'PLAY',
      byPlayerId: player.playerId,
      word: normalizedWord,
      endChar: normalizedEndChar,
      prevCurrentChar,
      nextCurrentChar: drawnChar,
      drawnChar,
      prevDeckIndex
    };
    if (player.hand.length === 0) {
      st.winner = { playerId: player.playerId, name: player.name };
      st.status = 'FINISHED';
    }
    st.stateVersion += 1;

    broadcastRoom(room, 'play_result', (pid) => ({ accepted: true, roomState: publicRoomState(room, pid) }));
  } finally {
    room.playLock = false;
  }
}

function handleUndo(ws, payload) {
  const { roomId, playerId, actionId } = payload || {};
  const room = rooms.get(roomId);
  if (!room) return reject(ws, 'undo_result', 'ROOM_NOT_FOUND');
  ensureRoomActivity(room);

  const st = room.state;
  const player = st.players.find((p) => p.playerId === playerId);
  if (!player) return reject(ws, 'undo_result', 'INVALID_INPUT', room, playerId);

  const la = st.lastAction;
  if (!la) return reject(ws, 'undo_result', 'UNDO_NOT_ALLOWED', room, playerId);
  if (la.actionId !== actionId || la.byPlayerId !== playerId || st.winner || st.currentChar !== la.nextCurrentChar) {
    return reject(ws, 'undo_result', 'UNDO_NOT_ALLOWED', room, playerId);
  }

  st.currentChar = la.prevCurrentChar;
  st.deckIndex = la.prevDeckIndex;
  st.deckCount = st.deck.length - st.deckIndex;
  player.hand.push(la.endChar);
  player.score = Math.max(0, (player.score || 0) - 1);
  st.lastPlay = null;
  st.lastAction = null;
  st.winner = null;
  st.status = st.players.length >= 2 ? 'PLAYING' : 'WAITING';
  st.stateVersion += 1;

  broadcastRoom(room, 'undo_result', (pid) => ({ accepted: true, roomState: publicRoomState(room, pid) }));
}

function leaveRoom(ws, payload) {
  const bound = socketToPlayer.get(ws);
  const roomId = payload?.roomId || bound?.roomId;
  const playerId = payload?.playerId || bound?.playerId;
  if (!roomId || !playerId) return;
  const room = rooms.get(roomId);
  if (!room) return;

  const p = room.state.players.find((x) => x.playerId === playerId);
  if (p) p.connected = false;
  room.sockets.delete(playerId);
  room.state.stateVersion += 1;
  ensureRoomActivity(room);
  syncRoom(room);
}

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(__dirname, 'public', path.normalize(reqPath));
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[ext] || 'text/plain; charset=utf-8';
    res.setHeader('Content-Type', type);
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  if (req.url !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    return socket.destroy();
  }
  const acceptKey = wsAcceptValue(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
    '\r\n'
  );

  const ws = new TinyWS(socket);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(ws, 'error', { message: 'INVALID_INPUT' }); }
    const { type, payload } = msg;

    try {
      if (type === 'create_room') {
        const room = createRoom();
        send(ws, 'room_created', { roomId: room.roomId });
      } else if (type === 'join_room') {
        joinRoom(ws, String(payload?.roomId || ''), payload?.name);
      } else if (type === 'play_request') {
        handlePlay(ws, payload);
      } else if (type === 'undo_request') {
        handleUndo(ws, payload);
      } else if (type === 'leave_room') {
        leaveRoom(ws, payload);
      } else {
        send(ws, 'error', { message: 'INVALID_INPUT' });
      }
    } catch (err) {
      send(ws, 'error', { message: err.message || 'UNKNOWN_ERROR' });
    }
  });

  ws.on('close', () => leaveRoom(ws));
});

setInterval(() => {
  const t = now();
  for (const [roomId, room] of rooms.entries()) {
    const anyConnected = room.state.players.some((p) => p.connected);
    if (!anyConnected && t - room.lastActiveAt > ROOM_TTL_MS) rooms.delete(roomId);
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`WordBasket server running on http://localhost:${PORT}`);
});
