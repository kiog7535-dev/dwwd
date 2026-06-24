// Client-side logic. Connects UI + Socket.IO and basic interactions.

const socket = io();
let currentChannel = null;
let currentServer = null;
let me = null;
const socketToken = localStorage.getItem('socketToken');

function $(s){return document.querySelector(s);} 
function escapeHtml(s){return String(s).replace(/[&<>"']/g, (c)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));}

// bootstrap UI
(async function init(){
  // redirect to login if not authenticated
  const meRes = await fetch('/api/me');
  if (!meRes.ok) return window.location.href = '/login.html';
  const j = await meRes.json();
  me = j.user;
  // fetch all data
  const dataRes = await fetch('/api/data');
  const data = await dataRes.json();
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
    el.textContent = c.name || '#channel';
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
    el.innerHTML = `<div class="avatar" style="background:${u.avatarColor}">${escapeInitials(u.displayName || u.username)}</div><div><div>${escapeHtml(u.displayName || u.username)} ${renderBadges(u.badges||{})}</div><div class="muted" style="font-size:12px;">${u.status || 'offline'}</div></div>`;
    el.addEventListener('click', ()=>{ window.location.href = '/profile.html?id=' + encodeURIComponent(u.id); });
    container.appendChild(el);
  });
}

function selectServer(serverId){
  currentServer = serverId;
  // visually mark active
  document.querySelectorAll('.server-btn').forEach(b => b.classList.toggle('active', b.dataset.serverId === serverId));
  // get channels for that server by refetching data
  fetch('/api/data').then(r=>r.json()).then(d=>{
    buildChannels(d.channels);
    populateMembers(d.users);
  });
}

function selectChannel(channelId, name){
  currentChannel = channelId;
  document.querySelectorAll('.channel').forEach(c=>c.classList.toggle('active', c.dataset.channelId === channelId));
  $('#channelTitle').textContent = name;
  $('#messageInput').placeholder = `Message ${name}`;
  // subscribe socket room handled server-side on auth; load messages via /api/data
  fetch('/api/data').then(r=>r.json()).then(d=>{
    const msgs = d.messages.filter(m => m.channelId === channelId);
    renderMessages(msgs);
    // scroll
    setTimeout(()=> $('#messages').scrollTop = $('#messages').scrollHeight, 50);
  });
}

function renderMessages(messages){
  const container = $('#messages');
  container.innerHTML = '';
  messages.forEach(m => {
    const u = findUser(m.from);
    const el = document.createElement('div');
    el.className = 'msg';
    el.innerHTML = `<div class="avatar" style="background:${u.avatarColor}">${escapeInitials(u.displayName || u.username)}</div>
      <div class="content"><div class="meta"><strong>${escapeHtml(u.displayName || u.username)} ${renderBadges(u.badges||{})}</strong> <span class="muted">• ${new Date(m.createdAt).toLocaleString()}</span></div>
      <div class="text">${escapeHtml(m.content)}</div></div>`;
    container.appendChild(el);
  });
}

function onMessageReceived(msg){
  if (msg.channelId !== currentChannel) return;
  const container = $('#messages');
  const u = findUser(msg.from);
  const el = document.createElement('div');
  el.className = 'msg';
  el.innerHTML = `<div class="avatar" style="background:${u.avatarColor}">${escapeInitials(u.displayName || u.username)}</div>
    <div class="content"><div class="meta"><strong>${escapeHtml(u.displayName || u.username)} ${renderBadges(u.badges||{})}</strong> <span class="muted">• ${new Date(msg.createdAt).toLocaleTimeString()}</span></div>
    <div class="text">${escapeHtml(msg.content)}</div></div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
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

function findUser(id){
  // crude: look in member list - better to fetch from server
  const mems = Array.from(document.querySelectorAll('#members .member'));
  const el = mems.find(m=> m.textContent && m.textContent.includes(id));
  return { id, username: id, displayName: id, avatarColor: '#666', badges: {} };
}

function escapeInitials(name){
  if (!name) return '?';
  const parts = name.split(' ');
  let s = parts[0][0];
  if (parts[1]) s += parts[1][0];
  return s.toUpperCase();
}

function handleUserUpdated(d){
  // refetch data and re-render members/messages to reflect badge/profile changes
  fetch('/api/data').then(r=>r.json()).then(d=>{
    populateMembers(d.users);
    if (currentChannel) {
      const msgs = d.messages.filter(m => m.channelId === currentChannel);
      renderMessages(msgs);
    }
  });
}

function showProfile(userId){
  window.location.href = '/profile.html?id=' + encodeURIComponent(userId);
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
