const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const sanitizeHtml = require('sanitize-html');
const { Server } = require('socket.io');

const DB_PATH = path.join(__dirname, 'database.json');
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = 'dwwd-secret-please-change';

// Utility DB loader/writer
function loadDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      const base = {
        users: [],
        sessions: [],
        servers: [],
        channels: [],
        messages: [],
        dms: [],
        groups: [],
        friends: [],
        friendRequests: [],
        bans: [],
        timeouts: [],
        notifications: []
      };
      fs.writeFileSync(DB_PATH, JSON.stringify(base, null, 2));
      return base;
    }
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load DB', err);
    process.exit(1);
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

let db = loadDB();

// Ensure Admin auto-created on first run
(async function ensureAdmin() {
  if (!db.users.find(u => u.username === 'Admin')) {
    const hash = await bcrypt.hash('whatthesigma', 10);
    const admin = {
      id: uuidv4(),
      username: 'Admin',
      displayName: 'Administrator',
      bio: 'Built-in admin account',
      avatarColor: '#111827',
      banner: 'linear-gradient(90deg,#ff7a18,#af002d)',
      joinDate: new Date().toISOString(),
      status: 'online',
      isAdmin: true,
      badges: { admin: true, blue: false, gold: false },
      passwordHash: hash,
      socketToken: null
    };
    db.users.push(admin);
    saveDB(db);
    console.log('Admin account created: username=Admin password=whatthesigma');
  }
})();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 3600 * 1000 }
}));

app.use(express.static(path.join(__dirname, 'public')));

// Helpers
function sanitize(input) {
  if (typeof input !== 'string') return input;
  return sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {}
  }).trim();
}

function getUserSafe(user) {
  if (!user) return null;
  const { passwordHash, socketToken, ...rest } = user;
  return rest;
}

function findUserByToken(token) {
  return db.users.find(u => u.socketToken === token);
}

function isBanned(username, ip) {
  return db.bans.some(b => (b.username && b.username === username) || (b.ip && b.ip === ip));
}

function isTimedOut(userId) {
  const t = db.timeouts.find(t => t.userId === userId);
  if (!t) return false;
  const now = Date.now();
  return now < new Date(t.expiresAt).getTime();
}

// Auth-required middleware
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const user = db.users.find(u => u.id === req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  if (db.bans.find(b => b.username === user.username)) {
    return res.status(403).json({ error: 'Banned' });
  }
  req.user = user;
  next();
}

// API routes

app.post('/api/register', async (req, res) => {
  const username = sanitize(req.body.username || '');
  const displayName = sanitize(req.body.displayName || username);
  const password = req.body.password || '';
  const bio = sanitize(req.body.bio || '');

  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: 'username exists' });
  }
  if (isBanned(username, req.ip)) return res.status(403).json({ error: 'banned' });

  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    username,
    displayName,
    bio,
    avatarColor: `hsl(${Math.abs(hashCode(username) % 360)} 60% 40%)`,
    banner: randomBanner(),
    joinDate: new Date().toISOString(),
    status: 'online',
    isAdmin: false,
    badges: { admin: false, blue: false, gold: false },
    passwordHash: hash,
    socketToken: null
  };
  db.users.push(user);
  saveDB(db);
  req.session.userId = user.id;
  res.json({ ok: true, user: getUserSafe(user) });
});

app.post('/api/login', async (req, res) => {
  const username = sanitize(req.body.username || '');
  const password = req.body.password || '';
  const user = db.users.find(u => u.username === username);
  if (!user) return res.status(400).json({ error: 'invalid' });
  if (isBanned(user.username, req.ip)) return res.status(403).json({ error: 'banned' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(400).json({ error: 'invalid' });
  req.session.userId = user.id;
  // generate socket token and persist
  user.socketToken = uuidv4();
  user.status = 'online';
  saveDB(db);
  res.json({ ok: true, user: getUserSafe(user), socketToken: user.socketToken });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const user = req.user;
  if (user) {
    user.socketToken = null;
    user.status = 'offline';
  }
  req.session.destroy(() => {
    saveDB(db);
    res.json({ ok: true });
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = req.user;
  res.json({ user: getUserSafe(user) });
});

app.get('/api/data', requireAuth, (req, res) => {
  const me = req.user;
  // servers user is member of
  const myServers = db.servers.filter(s => s.members && s.members.includes(me.id));
  // channels for those servers
  const myChannels = db.channels.filter(c => myServers.some(s => s.id === c.serverId));
  // messages for those channels (limit last 200 per channel)
  const messages = db.messages.filter(m => myChannels.some(c => c.id === m.channelId))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  // friends and friendRequests
  const friends = db.friends.filter(f => f.userId === me.id || f.friendId === me.id);
  const friendRequests = db.friendRequests.filter(r => r.to === me.id || r.from === me.id);
  // DMs involving me
  const dms = db.dms.filter(d => d.participants.includes(me.id));
  res.json({
    servers: myServers,
    channels: myChannels,
    messages,
    users: db.users.map(u => ({ id: u.id, username: u.username, displayName: u.displayName, avatarColor: u.avatarColor, status: u.status, badges: u.badges })),
    friends,
    friendRequests,
    dms,
    groups: db.groups,
    notifications: db.notifications.filter(n => n.to === me.id)
  });
});

// Server creation
app.post('/api/createServer', requireAuth, (req, res) => {
  const name = sanitize(req.body.name || '');
  if (!name) return res.status(400).json({ error: 'name required' });
  const server = {
    id: uuidv4(),
    name,
    iconColor: `hsl(${Math.abs(hashCode(name) % 360)} 60% 40%)`,
    owner: req.user.id,
    members: [req.user.id],
    channels: []
  };
  // default channels
  const defaults = ['general', 'gaming', 'memes'];
  defaults.forEach(ch => {
    const channel = { id: uuidv4(), serverId: server.id, name: `#${ch}`, createdAt: new Date().toISOString() };
    db.channels.push(channel);
    server.channels.push(channel.id);
  });
  db.servers.push(server);
  saveDB(db);
  io.emit('serverCreated', server);
  res.json({ ok: true, server });
});

// Join server
app.post('/api/joinServer', requireAuth, (req, res) => {
  const serverId = req.body.serverId;
  const server = db.servers.find(s => s.id === serverId);
  if (!server) return res.status(404).json({ error: 'server not found' });
  if (!server.members.includes(req.user.id)) server.members.push(req.user.id);
  saveDB(db);
  io.emit('serverMemberUpdate', { serverId, userId: req.user.id, action: 'joined' });
  res.json({ ok: true, server });
});

// Create channel (server owner or admin)
app.post('/api/createChannel', requireAuth, (req, res) => {
  const name = sanitize(req.body.name || '');
  const serverId = req.body.serverId;
  const server = db.servers.find(s => s.id === serverId);
  if (!server) return res.status(404).json({ error: 'server not found' });
  if (!(server.owner === req.user.id || req.user.isAdmin)) return res.status(403).json({ error: 'not allowed' });
  const channel = { id: uuidv4(), serverId, name: `#${name.replace(/^#/, '')}`, createdAt: new Date().toISOString() };
  db.channels.push(channel);
  server.channels.push(channel.id);
  saveDB(db);
  io.emit('channelCreated', { serverId, channel });
  res.json({ ok: true, channel });
});

// Friend requests
app.post('/api/friendRequest', requireAuth, (req, res) => {
  const toUsername = sanitize(req.body.to || '');
  const to = db.users.find(u => u.username === toUsername || u.id === toUsername);
  if (!to) return res.status(404).json({ error: 'user not found' });
  if (to.id === req.user.id) return res.status(400).json({ error: 'self' });
  if (db.friendRequests.find(r => r.from === req.user.id && r.to === to.id)) {
    return res.status(400).json({ error: 'already requested' });
  }
  db.friendRequests.push({ id: uuidv4(), from: req.user.id, to: to.id, createdAt: new Date().toISOString() });
  db.notifications.push({ id: uuidv4(), to: to.id, type: 'friend_request', from: req.user.id, createdAt: new Date().toISOString() });
  saveDB(db);
  io.emit('friendRequest', { from: req.user.id, to: to.id });
  res.json({ ok: true });
});

app.post('/api/respondFriend', requireAuth, (req, res) => {
  const requestId = req.body.requestId;
  const accept = !!req.body.accept;
  const fr = db.friendRequests.find(r => r.id === requestId && r.to === req.user.id);
  if (!fr) return res.status(404).json({ error: 'request not found' });
  if (accept) {
    db.friends.push({ id: uuidv4(), userId: fr.from, friendId: fr.to, createdAt: new Date().toISOString() });
    db.friends.push({ id: uuidv4(), userId: fr.to, friendId: fr.from, createdAt: new Date().toISOString() });
    db.notifications.push({ id: uuidv4(), to: fr.from, type: 'friend_accept', from: req.user.id, createdAt: new Date().toISOString() });
  }
  db.friendRequests = db.friendRequests.filter(r => r.id !== requestId);
  saveDB(db);
  io.emit('friendRequestResponse', { from: fr.from, to: fr.to, accepted: accept });
  res.json({ ok: true });
});

// Send DM (persist)
app.post('/api/sendDM', requireAuth, (req, res) => {
  const toId = req.body.toId;
  const content = sanitize(req.body.content || '');
  const toUser = db.users.find(u => u.id === toId);
  if (!toUser) return res.status(404).json({ error: 'user not found' });
  if (isTimedOut(req.user.id)) return res.status(403).json({ error: 'timed out' });
  // find or create DM thread between two users (participants array sorted)
  let thread = db.dms.find(d => d.participants.length === 2 && d.participants.includes(req.user.id) && d.participants.includes(toId));
  if (!thread) {
    thread = { id: uuidv4(), participants: [req.user.id, toId], messages: [] };
    db.dms.push(thread);
  }
  const msg = { id: uuidv4(), from: req.user.id, content, createdAt: new Date().toISOString(), pinned: false };
  thread.messages.push(msg);
  db.notifications.push({ id: uuidv4(), to: toId, type: 'dm', from: req.user.id, createdAt: new Date().toISOString() });
  saveDB(db);
  io.to(`dm_${thread.id}`).emit('dmMessage', { threadId: thread.id, message: msg });
  res.json({ ok: true, threadId: thread.id, message: msg });
});

// ADMIN moderation endpoints
app.post('/api/admin/ban', requireAuth, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'not admin' });
  const username = sanitize(req.body.username || '');
  const reason = sanitize(req.body.reason || '');
  const user = db.users.find(u => u.username === username || u.id === username);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (!db.bans.find(b => b.username === user.username)) {
    db.bans.push({ id: uuidv4(), username: user.username, ip: null, reason, createdAt: new Date().toISOString() });
    user.socketToken = null;
    user.status = 'offline';
    saveDB(db);
    io.emit('userBanned', { username: user.username, by: req.user.username });
  }
  res.json({ ok: true });
});

app.post('/api/admin/unban', requireAuth, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'not admin' });
  const username = sanitize(req.body.username || '');
  db.bans = db.bans.filter(b => b.username !== username);
  saveDB(db);
  res.json({ ok: true });
});

app.post('/api/admin/timeout', requireAuth, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'not admin' });
  const userId = req.body.userId;
  const seconds = Number(req.body.seconds || 60);
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
  db.timeouts = db.timeouts.filter(t => t.userId !== userId);
  db.timeouts.push({ id: uuidv4(), userId, expiresAt, createdAt: new Date().toISOString(), by: req.user.id });
  saveDB(db);
  io.emit('userTimeout', { userId, expiresAt });
  res.json({ ok: true });
});

app.post('/api/admin/deleteMessage', requireAuth, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'not admin' });
  const messageId = req.body.messageId;
  const beforeLen = db.messages.length;
  db.messages = db.messages.filter(m => m.id !== messageId);
  saveDB(db);
  io.emit('messageDeleted', { messageId });
  res.json({ ok: true, removed: beforeLen - db.messages.length });
});

app.post('/api/pinMessage', requireAuth, (req, res) => {
  const messageId = req.body.messageId;
  const pin = !!req.body.pin;
  const m = db.messages.find(x => x.id === messageId);
  if (!m) return res.status(404).json({ error: 'message not found' });
  if (!(req.user.isAdmin || m.from === req.user.id)) return res.status(403).json({ error: 'not allowed' });
  m.pinned = !!pin;
  saveDB(db);
  io.emit('messagePinned', { messageId, pinned: m.pinned });
  res.json({ ok: true });
});

// POST message to channel (Socket preferred, but also allow HTTP)
app.post('/api/sendMessage', requireAuth, (req, res) => {
  const channelId = req.body.channelId;
  const content = sanitize(req.body.content || '');
  const channel = db.channels.find(c => c.id === channelId);
  if (!channel) return res.status(404).json({ error: 'channel not found' });
  const server = db.servers.find(s => s.id === channel.serverId);
  if (!server || !server.members.includes(req.user.id)) return res.status(403).json({ error: 'not member' });
  if (isTimedOut(req.user.id)) return res.status(403).json({ error: 'timed out' });
  const message = {
    id: uuidv4(),
    channelId,
    from: req.user.id,
    content,
    createdAt: new Date().toISOString(),
    pinned: false
  };
  db.messages.push(message);
  db.notifications.push({ id: uuidv4(), to: null, type: 'message', channelId, from: req.user.id, createdAt: new Date().toISOString() });
  saveDB(db);
  io.to(`channel_${channelId}`).emit('message', message);
  res.json({ ok: true, message });
});

// Serve single-page client - index.html is static

// Socket.io handling
io.on('connection', (socket) => {
  socket.authenticated = false;
  socket.user = null;

  socket.on('authenticate', (data) => {
    const token = data && data.token;
    if (!token) return socket.emit('authError', { error: 'no token' });
    const user = findUserByToken(token);
    if (!user) return socket.emit('authError', { error: 'invalid token' });
    socket.user = user;
    socket.authenticated = true;
    user.status = 'online';
    saveDB(db);

    // Join rooms for all servers/channels the user is member of
    const memberServers = db.servers.filter(s => s.members.includes(user.id));
    memberServers.forEach(s => socket.join(`server_${s.id}`));
    const memberChannels = db.channels.filter(c => memberServers.some(s => s.id === c.serverId));
    memberChannels.forEach(c => socket.join(`channel_${c.id}`));
    // join DM rooms
    db.dms.filter(d => d.participants.includes(user.id)).forEach(d => socket.join(`dm_${d.id}`));

    io.emit('presenceUpdate', { userId: user.id, status: user.status });
    socket.emit('authenticated', { user: getUserSafe(user) });
  });

  socket.on('typing', (data) => {
    if (!socket.authenticated) return;
    const channelId = data.channelId;
    if (!channelId) return;
    socket.to(`channel_${channelId}`).emit('typing', { userId: socket.user.id, channelId });
  });

  socket.on('sendMessage', (data) => {
    if (!socket.authenticated) return;
    const channelId = data.channelId;
    let content = sanitize(data.content || '');
    if (!content) return;
    const channel = db.channels.find(c => c.id === channelId);
    if (!channel) return;
    const server = db.servers.find(s => s.id === channel.serverId);
    if (!server || !server.members.includes(socket.user.id)) return;
    if (isTimedOut(socket.user.id)) return socket.emit('error', { error: 'timed out' });

    const message = { id: uuidv4(), channelId, from: socket.user.id, content, createdAt: new Date().toISOString(), pinned: false };
    db.messages.push(message);
    saveDB(db);
    io.to(`channel_${channelId}`).emit('message', message);
  });

  socket.on('sendDM', (data) => {
    if (!socket.authenticated) return;
    const toId = data.toId;
    const content = sanitize(data.content || '');
    if (!toId || !content) return;
    if (isTimedOut(socket.user.id)) return socket.emit('error', { error: 'timed out' });
    let thread = db.dms.find(d => d.participants.length === 2 && d.participants.includes(socket.user.id) && d.participants.includes(toId));
    if (!thread) {
      thread = { id: uuidv4(), participants: [socket.user.id, toId], messages: [] };
      db.dms.push(thread);
    }
    const msg = { id: uuidv4(), from: socket.user.id, content, createdAt: new Date().toISOString(), pinned: false };
    thread.messages.push(msg);
    saveDB(db);
    io.to(`dm_${thread.id}`).emit('dmMessage', { threadId: thread.id, message: msg });
  });

  socket.on('disconnect', () => {
    if (socket.user) {
      socket.user.status = 'offline';
      socket.user.socketToken = null;
      saveDB(db);
      io.emit('presenceUpdate', { userId: socket.user.id, status: 'offline' });
    }
  });
});

// Helpers for small utilities
function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return h;
}
function randomBanner() {
  const a = Math.floor(Math.random() * 360);
  const b = (a + 60) % 360;
  return `linear-gradient(90deg,hsl(${a} 70% 55%), hsl(${b} 70% 45%))`;
}

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
