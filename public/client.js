// Client-side logic with UI polish: grouping messages, improved profile popup, server tooltips.

const socket = io();
let currentChannel = null;
let currentServer = null;
let me = null;
const socketToken = localStorage.getItem('socketToken');
let usersMap = {};

function $(s){return document.querySelector(s);} 
function escapeHtml(s){return String(s).replace(/[&<>"']/g, (c)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));}

// bootstrap UI
(async function init(){
  // redirect to login if not authenticated
  const meRes = await fetch('/api/me');
  if (!meRes.ok) return window.location.href = '/login.html';
  const j = await meRes.json();
  me = j.user;

  // add admin button if admin
  if (me.isAdmin) {
    const btn = document.createElement('button');
    btn.className = 'admin-btn';
    btn.textContent = 'Verification';
    btn.addEventListener('click', ()=> window.open('/admin.html', '_blank'));
    document.querySelector('.chat-actions').prepend(btn);
  }

  // fetch all data
  const dataRes = await fetch('/api/data');
  const data = await dataRes.json();
  // build users map
  data.users.forEach(u => usersMap[u.id] = u);
  buildServerDock(data.servers);
  buildChannels(data.channels);
  populateMembers(data.users);
  attachHandlers();
  // auth socket
  socket.emit('authenticate', { token: socketToken || me.socketToken });
  socket.on('authenticated', (d) => { console.log('socket auth ok'); });
  socket.on('message', onMessageReceived);
  socket.on('dmMessage', onDMReceived);
  socket.on('typing', (d) => showTyping(d));
  socket.on('presenceUpdate', (d) => updatePresence(d));
  socket.on('userUpdated', (d) => handleUserUpdated(d));
})();

function attachHandlers(){
  $('#sendBtn').addEventListener('click', sendMessage);
  $('#messageInput').addEventListener('keydown', (e)=>{
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    socket.emit('typing', { channelId: currentChannel });
  });
  $('#createServerBtn').addEventListener('click', async ()=>{
    const name = prompt('Server name');
    if (!name) return;
    const res = await fetch('/api/createServer', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name })});
    if (res.ok) location.reload();
  });
}

function buildServerDock(servers){
  const dock = $('#serverDock');
  dock.querySelectorAll('.server-btn.user').forEach(n=>n.remove());
  servers.forEach(s=>{
    const b = document.createElement('button');
    b.className = 'server-btn user';
    b.title = s.name;
    b.style.background = s.iconColor || '#333';
    b.dataset.serverId = s.id;
    const inner = document.createElement('div'); inner.className = 'inner'; inner.textContent = s.name[0] || 'S';
    b.appendChild(inner);
    // tooltip
    const tip = document.createElement('div'); tip.className = 'tooltip'; tip.textContent = s.name; b.appendChild(tip);
    b.addEventListener('click', ()=>selectServer(s.id));
    dock.insertBefore(b, $('#createServerBtn'));
  });
  // auto-select first
  if (servers[0]) selectServer(servers[0].id);
}

function buildChannels(channels){
  const container = $('#channelsList');
  container.innerHTML = '';
  const serverChannels = channels.filter(c => !currentServer || c.serverId === currentServer);
  serverChannels.forEach(c=>{
    const el = document.createElement('div');
    el.className = 'channel';
    el.innerHTML = `<span class="hash">#</span><span class="name">${escapeHtml(c.name.replace(/^#/,''))}</span>`;
    el.dataset.channelId = c.id;
    el.addEventListener('click', ()=>selectChannel(c.id, c.name));
    container.appendChild(el);
  });
  if (serverChannels[0]) selectChannel(serverChannels[0].id, serverChannels[0].name);
}

function renderBadges(badges){
  if(!badges) return '';
  let s = '';
  if(badges.blue) s += '<img src="/icons/blue-check.svg" class="badge-icon" title="Blue verified" />';
  if(badges.gold) s += '<img src="/icons/gold-badge.svg" class="badge-icon" title="Gold verified" />';
  if(badges.admin) s += '<span class="muted">★</span>';
  return s;
}

function populateMembers(users){
  const container = $('#members');
  container.innerHTML = '';
  users.forEach(u=>{
    const el = document.createElement('div');
    el.className = 'member';
    el.dataset.userid = u.id;
    el.innerHTML = `<div class="avatar" style="background:${u.avatarColor}">${escapeInitials(u.displayName || u.username)}</div><div><div class="username">${escapeHtml(u.displayName || u.username)} ${renderBadges(u.badges||{})}</div><div class="muted">${u.status || 'offline'}</div></div>`;
    el.addEventListener('click', ()=>{ showProfilePopup(u.id, el); });
    container.appendChild(el);
  });
}

function selectServer(serverId){
  currentServer = serverId;
  // visually mark active
  document.querySelectorAll('.server-btn').forEach(b => b.classList.toggle('active', b.dataset.serverId === serverId));
  // get channels for that server by refetching data
  fetch('/api/data').then(r=>r.json()).then(d=>{
    // update users map
    d.users.forEach(u => usersMap[u.id] = u);
    buildChannels(d.channels);
    populateMembers(d.users);
  });
}

function selectChannel(channelId, name){
  currentChannel = channelId;
  document.querySelectorAll('.channel').forEach(c=>c.classList.toggle('active', c.dataset.channelId === channelId));
  $('#channelTitle').textContent = name;
  $('#messageInput').placeholder = `Message ${name}`;
  // load messages via /api/data
  fetch('/api/data').then(r=>r.json()).then(d=>{
    // update users map
    d.users.forEach(u => usersMap[u.id] = u);
    const msgs = d.messages.filter(m => m.channelId === channelId);
    renderMessagesGrouped(msgs);
    // scroll
    setTimeout(()=> $('#messages').scrollTop = $('#messages').scrollHeight, 50);
  });
}

function renderMessagesGrouped(messages){
  const container = $('#messages');
  container.innerHTML = '';
  let prevAuthor = null;
  let groupEl = null;
  messages.forEach(m => {
    const u = usersMap[m.from] || { displayName: m.from, avatarColor: '#666', badges: {} };
    if (m.from !== prevAuthor) {
      // start a new group
      groupEl = document.createElement('div');
      groupEl.className = 'msg-group';
      const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.style.background = u.avatarColor; avatar.textContent = escapeInitials(u.displayName || u.username);
      const bubble = document.createElement('div'); bubble.className = 'msg-bubble';
      const meta = document.createElement('div'); meta.className = 'msg-meta'; meta.innerHTML = `<strong>${escapeHtml(u.displayName || u.username)}</strong> ${renderBadges(u.badges||{})} <span class="muted">• ${new Date(m.createdAt).toLocaleTimeString()}</span>`;
      const text = document.createElement('div'); text.className = 'msg-text'; text.innerHTML = escapeHtml(m.content);
      bubble.appendChild(meta); bubble.appendChild(text);
      groupEl.appendChild(avatar); groupEl.appendChild(bubble);
      container.appendChild(groupEl);
    } else {
      // continuation
      const cont = document.createElement('div'); cont.className = 'msg-continuation'; cont.innerHTML = `<div class="msg-bubble">${escapeHtml(m.content)}</div>`;
      container.appendChild(cont);
    }
    prevAuthor = m.from;
  });
}

function onMessageReceived(msg){
  if (msg.channelId !== currentChannel) return;
  // append message and group if same author
  fetch('/api/data').then(r=>r.json()).then(d=>{
    d.users.forEach(u => usersMap[u.id] = u);
    const msgs = d.messages.filter(m => m.channelId === currentChannel);
    renderMessagesGrouped(msgs);
    setTimeout(()=> $('#messages').scrollTop = $('#messages').scrollHeight, 20);
  });
}

function onDMReceived(d){
  // For simplicity, show alert on new DM
  alert('New DM received');
}

function sendMessage(){
  const input = $('#messageInput');
  const text = input.value.trim();
  if (!text || !currentChannel) return;
  socket.emit('sendMessage', { channelId: currentChannel, content: text });
  input.value = '';
}

function escapeInitials(name){
  if (!name) return '?';
  const parts = name.split(' ');
  let s = parts[0][0];
  if (parts[1]) s += parts[1][0];
  return s.toUpperCase();
}

// Profile popup (inline)
let profilePopupEl = null;
function ensureProfilePopup(){
  if (!profilePopupEl) {
    profilePopupEl = document.createElement('div');
    profilePopupEl.className = 'profile-popup hidden';
    document.body.appendChild(profilePopupEl);
  }
}

async function showProfilePopup(userId, anchorEl){
  ensureProfilePopup();
  const res = await fetch('/api/users/' + encodeURIComponent(userId));
  if (!res.ok) return;
  const j = await res.json();
  const u = j.user;
  profilePopupEl.innerHTML = `<div class="profile-banner" style="background-image: url('${u.banner || ''}'); height:80px;border-radius:8px 8px 0 0;background-size:cover"></div>
    <div class="profile-body"><div class="profile-avatar" style="width:64px;height:64px;border-radius:50%;margin-top:-32px;border:3px solid rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;background:${u.avatar?'transparent':'#666'}">${u.avatar?`<img src='${u.avatar}' style='width:64px;height:64px;border-radius:50%'/>`:(u.displayName?u.displayName[0]:'?')}</div>
    <h3>${escapeHtml(u.displayName)} <span class="muted">@${escapeHtml(u.username)}</span></h3>
    <div>${u.badges && u.badges.blue?'<img src="/icons/blue-check.svg" class="badge-icon"/>':''}${u.badges && u.badges.gold?'<img src="/icons/gold-badge.svg" class="badge-icon"/>':''}${u.isAdmin?'<span class="muted"> Admin</span>':''}</div>
    <p class="muted">${escapeHtml(u.bio || '')}</p>
    <div class="muted">Friends: ${u.friendCount || 0} • Mutuals: ${u.mutualCount || 0} • Joined: ${new Date(u.joinDate).toLocaleDateString()}</div>
    <div style="margin-top:8px;"><button class="button" id="msgBtn">Message</button> <button class="button" id="friendBtn">Add Friend</button> <a class="button" href="/profile.html?id=${encodeURIComponent(u.id)}">View Profile</a></div>
    </div>`;
  profilePopupEl.classList.remove('hidden');
  // position near anchor
  const rect = anchorEl.getBoundingClientRect();
  profilePopupEl.style.position = 'fixed';
  profilePopupEl.style.left = (rect.right + 12) + 'px';
  profilePopupEl.style.top = (rect.top) + 'px';

  $('#msgBtn').addEventListener('click', ()=>{ startDM(u.id); profilePopupEl.classList.add('hidden'); });
  $('#friendBtn').addEventListener('click', ()=>{ sendFriend(u.username); profilePopupEl.classList.add('hidden'); });
}

function startDM(userId){
  const msg = prompt('Open DM and send initial message (optional)');
  if (!msg) return;
  fetch('/api/sendDM', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ toId: userId, content: msg })});
  alert('DM sent!');
}

function sendFriend(username){
  fetch('/api/friendRequest', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ to: username })}).then(r=>r.json()).then(j=>{
    if (j.ok) alert('Friend request sent');
    else alert(j.error || 'failed');
  });
}

function handleUserUpdated(d){
  // refetch users list minimally
  fetch('/api/data').then(r=>r.json()).then(d=>{
    d.users.forEach(u=> usersMap[u.id] = u);
    populateMembers(d.users);
    if (currentChannel) {
      const msgs = d.messages.filter(m => m.channelId === currentChannel);
      renderMessagesGrouped(msgs);
    }
  });
}

function showTyping(d){
  if (d.channelId !== currentChannel) return;
  $('#typing').textContent = 'Someone is typing...';
  setTimeout(()=>$('#typing').textContent='', 1400);
}

function updatePresence(d){
  // simplistic: reload member list to reflect statuses
  fetch('/api/data').then(r=>r.json()).then(d=>populateMembers(d.users));
}
