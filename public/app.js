/* ═══════════════════════════════════════════
   MOTOVOC — app.js
   Social network client logic (dark moto theme)
   ═══════════════════════════════════════════ */

const $ = s => document.querySelector(s);

let token     = localStorage.getItem('moto_token');
let me        = null;
let authMode  = 'register';
let socket    = null;
let currentFriend = null;
let notifications = JSON.parse(localStorage.getItem('moto_notifications') || '[]');

/* ── Utilities ── */
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
));

const api = async (path, opt = {}) => {
  const r = await fetch('/api' + path, {
    ...opt,
    headers: {
      'Content-Type': 'application/json',
      ...(opt.headers || {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    }
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(d.error || 'Erreur');
  return d;
};

/* ── Toast ── */
const toast = (msg, type = 'default') => {
  const e = $('#toast');
  e.textContent = msg;
  e.classList.add('show');
  e.style.borderLeftColor = type === 'error' ? 'var(--danger)' : type === 'success' ? 'var(--success)' : 'var(--ember)';
  clearTimeout(e._t);
  e._t = setTimeout(() => e.classList.remove('show'), 2400);
};

/* ── Time ── */
function timeAgo(t) {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60)    return 'À l\'instant';
  if (s < 3600)  return `Il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `Il y a ${Math.floor(s / 3600)} h`;
  return `Il y a ${Math.floor(s / 86400)} j`;
}

/* ── Notifications ── */
function pushNotification(type, title, text, icon = '♢') {
  notifications.unshift({ id: Date.now() + Math.random(), type, title, text, icon, read: false, time: Date.now() });
  notifications = notifications.slice(0, 100);
  localStorage.setItem('moto_notifications', JSON.stringify(notifications));
  updateBadges();
  if (!$('#app').classList.contains('hidden')) toast(title);
}

function updateBadges() {
  const n = notifications.filter(x => !x.read).length;
  ['#navBadge', '#headerBadge'].forEach(s => {
    const e = $(s);
    if (e) { e.textContent = n > 99 ? '99+' : n; e.classList.toggle('hidden', !n); }
  });
}

/* ── Modal ── */
function modal(title, body, submit) {
  const d = document.createElement('div');
  d.className = 'modal';
  d.innerHTML = `
    <div class="modal-card">
      <h2>${title}</h2>
      ${body}
      <div class="modal-actions">
        <button class="secondary" data-close>Annuler</button>
        <button class="primary" data-submit>Valider</button>
      </div>
    </div>`;
  document.body.append(d);
  d.querySelector('[data-close]').onclick = () => d.remove();
  d.addEventListener('click', e => { if (e.target === d) d.remove(); });
  d.querySelector('[data-submit]').onclick = async () => {
    try { await submit(d); d.remove(); }
    catch (e) { toast(e.message, 'error'); }
  };
  return d;
}

/* ══════════════════════════════════
   AUTH
══════════════════════════════════ */

async function login() {
  try {
    const d = await api('/auth/' + (authMode === 'register' ? 'register' : 'login'), {
      method: 'POST',
      body: JSON.stringify({
        username: $('#username').value,
        displayName: $('#displayName').value,
        password: $('#password').value
      })
    });
    token = d.token;
    localStorage.setItem('moto_token', token);
    boot();
  } catch (e) {
    $('#authError').textContent = e.message;
  }
}

/* ══════════════════════════════════
   BOOT / SESSION
══════════════════════════════════ */

async function boot() {
  try {
    const d = await api('/me');
    me = d.user;

    $('#auth').classList.add('hidden');
    $('#app').classList.remove('hidden');

    $('#myName').textContent      = me.displayName;
    $('#myUsername').textContent   = '@' + me.username;
    setAvatarText('#myAvatar',     me.displayName);
    setAvatarText('#headerAvatar', me.displayName);

    connectSocket();
    updateBadges();
    loadView('feed');
  } catch {
    localStorage.removeItem('moto_token');
    token = null;
  }
}

function setAvatarText(sel, name) {
  const el = $(sel);
  if (el) el.textContent = (name[0] || 'M').toUpperCase();
}

/* ══════════════════════════════════
   SOCKET
══════════════════════════════════ */

function connectSocket() {
  socket = io({ auth: { token } });
  socket.on('connect', () => toast('Connecté — bienvenue sur MotoVoc 🏍', 'success'));
  socket.on('message:new', m => {
    if (currentFriend && (m.sender_id === currentFriend.id || m.recipient_id === currentFriend.id))
      renderChat(currentFriend);
    else if (m.sender_id !== me.id)
      pushNotification('message', 'Nouveau message', 'Tu as reçu un nouveau message.', '💬');
  });
  socket.on('friend:request',  e  => pushNotification('friend', 'Nouvelle demande d\'ami',  `@${e.from.username} veut devenir ton ami.`, '👥'));
  socket.on('friend:accepted', ()  => pushNotification('friend', 'Demande acceptée', 'Un ami a accepté ta demande.', '🤝'));
  socket.on('group:invite',    g   => pushNotification('group', 'Invitation groupe', `Tu as été invité dans ${g.name}.`, '◈'));
  socket.on('post:new',        ()  => { if (location.hash === '#feed') renderFeed(); });
  socket.on('voice:room-created', () => { if (location.hash === '#voice') renderVoice(); });
}

/* ══════════════════════════════════
   NAVIGATION
══════════════════════════════════ */

async function loadView(view) {
  document.querySelectorAll('.nav').forEach(x => x.classList.toggle('active', x.dataset.view === view));

  const titles = {
    feed:          ['Accueil',       'Ton fil moto'],
    friends:       ['Amis',          'Gère ta communauté'],
    messages:      ['Messages',      'Discute avec tes amis'],
    groups:        ['Groupes',       'Tes communautés moto'],
    voice:         ['Vocaux',        'Rejoins ou crée un salon'],
    notifications: ['Notifications', 'Ce qui se passe sur ton compte']
  };
  $('#viewTitle').textContent = titles[view][0];
  $('#viewSub').textContent   = titles[view][1];
  location.hash = view;

  const fn = { feed: renderFeed, friends: renderFriends, messages: renderMessages,
                groups: renderGroups, voice: renderVoice, notifications: renderNotifications }[view];
  if (fn) await fn();
}

/* ══════════════════════════════════
   FEED
══════════════════════════════════ */

async function renderFeed() {
  const { posts } = await api('/feed');
  $('#view').classList.add('feed-layout');
  $('#view').innerHTML = `

    <!-- Stories -->
    <div class="stories">
      ${[['Ta story', '＋'], ['Balades', '🏍'], ['MotoGP', '🏁'], ['Photos', '📷'], ['Groupes', '👥'], ['Events', '📅']]
        .map(x => `<div class="story"><div class="avatar">${x[1]}</div><div>${x[0]}</div></div>`).join('')}
    </div>

    <!-- Composer -->
    <div class="card composer">
      <div class="post-head">
        <div class="avatar" id="compAvatar">${esc(me.displayName[0])}</div>
        <div>
          <b>Publier</b>
          <small>Partage ton moment moto</small>
        </div>
      </div>
      <textarea id="postText" placeholder="Quoi de neuf sur la route ?"></textarea>
      <div class="row" style="justify-content:flex-end;margin-top:12px;gap:8px">
        <button class="secondary" id="addMedia" style="flex:none">📷 Photo</button>
        <button class="primary"   id="publish"  style="flex:none">Publier</button>
      </div>
    </div>

    <!-- Posts -->
    ${posts.length
      ? posts.map(postHTML).join('')
      : '<div class="empty">Aucune publication pour le moment.<br><span style="font-size:28px;margin-top:8px;display:block">🏍</span></div>'
    }
  `;

  $('#publish').onclick = async () => {
    const btn = $('#publish');
    const c = $('#postText').value.trim();
    if (!c) return;
    btn.disabled = true; btn.textContent = '...';
    await api('/posts', { method: 'POST', body: JSON.stringify({ content: c }) });
    toast('Publication envoyée 🔥', 'success');
    renderFeed();
  };

  document.querySelectorAll('[data-like]').forEach(b => b.onclick = async () => {
    b.classList.toggle('liked');
    await api('/posts/' + b.dataset.like + '/like', { method: 'POST' });
    renderFeed();
  });

  $('#addMedia').onclick = () => toast('API média à connecter 📷');
}

/* ── Post HTML ── */
function postHTML(p) {
  return `
  <article class="card post" style="position:relative;overflow:hidden">
    <div class="post-head">
      <div class="avatar">${esc((p.display_name || '?')[0])}</div>
      <div style="flex:1">
        <b>${esc(p.display_name)}</b>
        <small>@${esc(p.username)} · ${timeAgo(p.created_at)}</small>
      </div>
      <button class="action" title="Plus d'options">•••</button>
    </div>
    <div class="post-content">${esc(p.content)}</div>
    ${p.media_url ? `<img class="post-media" src="${esc(p.media_url)}" loading="lazy">` : ''}
    <div class="actions">
      <button class="action ${p.liked ? 'liked' : ''}" data-like="${p.id}">
        ♥ ${p.likes || 0}
      </button>
      <button class="action" onclick="comments(${p.id})">◌ ${p.comments || 0}</button>
      <button class="action" onclick="sharePost(${p.id})">↗ Partager</button>
      <button class="action" onclick="savePost(${p.id})" title="Enregistrer">🔖</button>
    </div>
  </article>`;
}

function sharePost(id) {
  navigator.clipboard?.writeText(location.origin + '/post/' + id);
  toast('Lien copié dans le presse-papier ✓', 'success');
}

async function savePost(id) {
  try {
    await api('/posts/' + id + '/save', { method: 'POST' });
    toast('Publication enregistrée 🔖', 'success');
  } catch { toast('Déjà enregistré'); }
}

function comments(id) {
  const m = modal(
    'Commentaires',
    `<div id="commentsBox" class="list" style="max-height:280px;overflow:auto;margin-bottom:14px">
       <div class="empty" style="padding:20px">Chargement…</div>
     </div>
     <input id="commentText" placeholder="Ajouter un commentaire…">`,
    async d => {
      const c = d.querySelector('#commentText').value.trim();
      if (c) await api('/posts/' + id + '/comments', { method: 'POST', body: JSON.stringify({ content: c }) });
    }
  );
  api('/posts/' + id + '/comments').then(({ comments }) => {
    const b = document.querySelector('#commentsBox');
    if (!b) return;
    b.innerHTML = comments.length
      ? comments.map(c => `
          <div class="person" style="padding:11px 13px">
            <div class="avatar" style="width:32px;height:32px;font-size:12px">${esc(c.display_name[0])}</div>
            <div>
              <b style="font-size:13px">${esc(c.display_name)}</b>
              <div style="font-size:14px;color:var(--text);font-family:var(--font-body)">${esc(c.content)}</div>
            </div>
          </div>`).join('')
      : '<div class="empty" style="padding:20px">Sois le premier à commenter 💬</div>';
  });
}

/* ══════════════════════════════════
   NOTIFICATIONS
══════════════════════════════════ */

async function renderNotifications() {
  const unread = notifications.filter(n => !n.read).length;
  $('#view').classList.remove('feed-layout');

  const iconMap = {
    message: '💬',
    friend:  '👥',
    group:   '◈',
    default: '♢'
  };

  $('#view').innerHTML = `
    <div class="notification-tabs">
      <button class="active">Toutes</button>
      <button id="readAll">
        ${unread ? `Tout marquer comme lu (${unread})` : 'Tout est lu ✓'}
      </button>
    </div>
    <div class="notification-list">
      ${notifications.length
        ? notifications.map(n => `
            <div class="notification-item ${n.read ? '' : 'unread'}">
              <div class="avatar" style="background:var(--asphalt4);border:1px solid var(--border2);font-size:18px">
                ${iconMap[n.type] || n.icon}
              </div>
              <div class="notification-body">
                <b style="font-size:14px">${esc(n.title)}</b>
                <div class="muted" style="margin-top:2px">${esc(n.text)}</div>
                <time>${timeAgo(n.time)}</time>
              </div>
              ${n.read ? '' : '<div class="dot"></div>'}
            </div>`).join('')
        : '<div class="empty">Aucune notification 🔔<br><span style="font-size:12px;margin-top:6px;display:block">Les nouvelles activités apparaîtront ici</span></div>'
      }
    </div>`;

  $('#readAll').onclick = () => {
    notifications.forEach(n => n.read = true);
    localStorage.setItem('moto_notifications', JSON.stringify(notifications));
    updateBadges();
    renderNotifications();
  };
}

/* ══════════════════════════════════
   FRIENDS
══════════════════════════════════ */

async function renderFriends() {
  const [a, b] = await Promise.all([api('/friends'), api('/friends/requests')]);
  $('#view').classList.remove('feed-layout');
  $('#view').innerHTML = `
    <div class="row" style="margin-bottom:18px">
      <button class="primary" id="addFriend" style="flex:none">＋ Ajouter un ami</button>
    </div>

    ${b.requests.length ? `
      <h3 style="font-family:var(--font-display);font-size:20px;letter-spacing:1px;color:var(--ember);margin-bottom:12px">
        Demandes reçues · ${b.requests.length}
      </h3>
      <div class="list" style="margin-bottom:24px">
        ${b.requests.map(r => `
          <div class="person">
            <div class="avatar">${esc(r.user.displayName[0])}</div>
            <div>
              <b>${esc(r.user.displayName)}</b>
              <div class="muted">@${esc(r.user.username)}</div>
            </div>
            <button class="primary" data-accept="${r.id}" style="flex:none">Accepter</button>
          </div>`).join('')}
      </div>` : ''}

    <h3 style="font-family:var(--font-display);font-size:20px;letter-spacing:1px;color:var(--white);margin-bottom:12px">
      Mes amis · ${a.friends.length}
    </h3>
    <div class="list">
      ${a.friends.length
        ? a.friends.map(f => `
            <div class="person">
              <div class="avatar">${esc(f.user.displayName[0])}</div>
              <div>
                <b>${esc(f.user.displayName)}</b>
                <div class="muted">@${esc(f.user.username)}</div>
              </div>
              <button class="secondary" data-chat="${f.user.id}" style="flex:none">Message</button>
            </div>`).join('')
        : '<div class="empty">Ajoute ton premier ami 🏍<br><span style="font-size:12px;margin-top:4px;display:block">Cherche des riders autour de toi</span></div>'
      }
    </div>`;

  $('#addFriend').onclick = () => modal(
    'Ajouter un ami',
    '<input id="friendUser" placeholder="Nom d\'utilisateur ou ID">',
    async d => {
      const v = d.querySelector('#friendUser').value.trim();
      if (!v) throw Error('Entre un nom d\'utilisateur');
      await api('/friends/request', { method: 'POST', body: JSON.stringify({ username: v }) });
      pushNotification('friend', 'Demande envoyée', `Ta demande a été envoyée à @${v}.`, '👥');
      renderFriends();
    }
  );

  document.querySelectorAll('[data-accept]').forEach(b => b.onclick = async () => {
    await api('/friends/' + b.dataset.accept + '/accept', { method: 'POST' });
    renderFriends();
  });

  document.querySelectorAll('[data-chat]').forEach(b => b.onclick = async () => {
    currentFriend = a.friends.find(x => x.user.id == b.dataset.chat).user;
    loadView('messages');
  });
}

/* ══════════════════════════════════
   MESSAGES
══════════════════════════════════ */

async function renderMessages() {
  const { friends } = await api('/friends');
  if (!currentFriend && friends[0]) currentFriend = friends[0].user;
  $('#view').classList.remove('feed-layout');
  $('#view').innerHTML = `
    <div class="message-layout">
      <div class="conversations">
        <div style="padding:10px 8px 8px;font-family:var(--font-display);font-size:16px;letter-spacing:1px;color:var(--ember)">
          Conversations
        </div>
        ${friends.map(f => `
          <div class="conversation ${currentFriend && currentFriend.id === f.user.id ? 'active' : ''}"
               data-select="${f.user.id}">
            ${esc(f.user.displayName)}
          </div>`).join('') || '<div class="empty" style="padding:20px;font-size:13px">Aucun ami</div>'}
      </div>
      <div class="chat" id="chat">
        <div style="flex:1;display:grid;place-items:center;color:var(--muted);font-size:14px">
          Sélectionne une conversation
        </div>
      </div>
    </div>`;

  document.querySelectorAll('[data-select]').forEach(x => x.onclick = () => {
    currentFriend = friends.find(f => f.user.id == x.dataset.select).user;
    renderMessages();
  });

  if (currentFriend) renderChat(currentFriend);
}

async function renderChat(user) {
  const d = await api('/messages/' + user.id);
  const initials = (user.displayName[0] || '?').toUpperCase();
  $('#chat').innerHTML = `
    <div>
      <div class="avatar" style="width:36px;height:36px;font-size:14px">${initials}</div>
      <div>
        <b>${esc(user.displayName)}</b>
        <div class="muted" style="font-size:11px">@${esc(user.username)}</div>
      </div>
    </div>
    <div class="chat-messages" id="chatMsgs">
      ${d.messages.length
        ? d.messages.map(m => `
            <div class="bubble ${m.sender_id === me.id ? 'mine' : ''}">
              ${esc(m.content)}
            </div>`).join('')
        : '<div class="empty" style="padding:30px">Dis bonjour 👋</div>'
      }
    </div>
    <div class="chat-input">
      <input id="msgInput" placeholder="Écrire un message…" autocomplete="off">
      <button class="primary" id="sendMsg" style="flex:none;padding:12px 18px">Envoyer</button>
    </div>`;

  // Scroll to bottom
  const msgs = $('#chatMsgs');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;

  const send = async () => {
    const i = $('#msgInput'), v = i.value.trim();
    if (!v) return;
    i.value = '';
    await api('/messages/' + user.id, { method: 'POST', body: JSON.stringify({ content: v }) });
    renderChat(user);
  };
  $('#sendMsg').onclick = send;
  $('#msgInput').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) send(); };
  $('#msgInput').focus();
}

/* ══════════════════════════════════
   GROUPS
══════════════════════════════════ */

async function renderGroups() {
  const { groups } = await api('/groups');
  $('#view').classList.remove('feed-layout');
  $('#view').innerHTML = `
    <div class="row" style="margin-bottom:18px">
      <button class="primary" id="newGroup" style="flex:none">＋ Créer un groupe</button>
    </div>
    <div class="list">
      ${groups.length
        ? groups.map(g => `
            <div class="group">
              <div class="avatar" style="font-size:20px;background:var(--asphalt4);border:1px solid var(--border2)">◈</div>
              <div>
                <b>${esc(g.name)}</b>
                <div class="muted">${g.member_count} membre(s) · <span class="pill">${esc(g.role)}</span></div>
              </div>
            </div>`).join('')
        : '<div class="empty">Aucun groupe<br><span style="font-size:12px;margin-top:4px;display:block">Crée ta communauté moto</span></div>'
      }
    </div>`;

  $('#newGroup').onclick = () => modal(
    'Nouveau groupe',
    '<input id="groupName" placeholder="Nom du groupe">',
    async d => {
      const n = d.querySelector('#groupName').value.trim();
      if (!n) throw Error('Nom requis');
      await api('/groups', { method: 'POST', body: JSON.stringify({ name: n }) });
      toast('Groupe créé ! 🏍', 'success');
      renderGroups();
    }
  );
}

/* ══════════════════════════════════
   VOICE ROOMS
══════════════════════════════════ */

async function renderVoice() {
  const { rooms } = await api('/voice/rooms');
  $('#view').classList.remove('feed-layout');
  $('#view').innerHTML = `
    <div class="row" style="margin-bottom:20px">
      <button class="primary" id="createVoice" style="flex:none">＋ Créer un salon vocal</button>
    </div>
    <div class="list">
      ${rooms.length
        ? rooms.map(r => `
            <div class="room ${r.visibility === 'private' ? 'private' : ''}">
              <div class="avatar" style="font-size:20px;background:${r.visibility === 'private' ? 'var(--asphalt4)' : 'rgba(255,92,26,.15)'};border-color:${r.visibility === 'private' ? 'var(--border2)' : 'var(--ember)'}">
                ${r.visibility === 'private' ? '🔒' : '◉'}
              </div>
              <div>
                <b>${esc(r.name)}</b>
                <div class="muted">
                  ${r.visibility === 'private' ? '🔒 Privé' : '🌐 Public'}
                  · ${r.member_count}/${r.max_users} riders
                </div>
              </div>
              <button class="join" data-room="${r.id}">Rejoindre</button>
            </div>`).join('')
        : '<div class="empty">Aucun salon actif 🎙️<br><span style="font-size:12px;margin-top:4px;display:block">Lance la conversation</span></div>'
      }
    </div>`;

  $('#createVoice').onclick = () => modal(
    'Créer un vocal',
    `<input id="roomName" placeholder="Nom du salon">
     <select id="visibility">
       <option value="public">🌐 Public — visible par tous</option>
       <option value="private">🔒 Privé — avec code d'accès</option>
     </select>
     <input id="roomCode" placeholder="Code (salons privés uniquement)">
     <input id="maxUsers" type="number" value="25" min="2" max="100" placeholder="Nb max de riders">`,
    async d => {
      const vis  = d.querySelector('#visibility').value;
      const code = d.querySelector('#roomCode').value;
      const x = await api('/voice/rooms', {
        method: 'POST',
        body: JSON.stringify({
          name: d.querySelector('#roomName').value,
          visibility: vis,
          code,
          maxUsers: Number(d.querySelector('#maxUsers').value)
        })
      });
      if (x.code) toast('Code du salon : ' + x.code);
      renderVoice();
    }
  );

  document.querySelectorAll('[data-room]').forEach(b => b.onclick = () => joinVoice(b.dataset.room));
}

async function joinVoice(id) {
  try {
    const room = (await api('/voice/rooms')).rooms.find(r => r.id === id);
    if (room.visibility === 'private') {
      modal(
        'Code du salon',
        '<input id="voiceCode" placeholder="Code d\'accès">',
        async x => {
          const code = x.querySelector('#voiceCode').value;
          await api('/voice/rooms/' + id + '/join', { method: 'POST', body: JSON.stringify({ code }) });
          openVoice(id, room);
        }
      );
      return;
    }
    await api('/voice/rooms/' + id + '/join', { method: 'POST', body: JSON.stringify({}) });
    openVoice(id, room);
  } catch (e) { toast(e.message, 'error'); }
}

async function openVoice(id, room) {
  $('#view').innerHTML = `
    <div class="voice-active">
      <h2>◉ ${esc(room.name)}</h2>
      <div class="muted" style="margin-top:4px">Connexion vocale WebRTC · <span class="online">En direct</span></div>
      <div class="voice-users" id="voiceUsers">
        <div class="voice-user">
          <div class="avatar">${esc(me.displayName[0])}</div>
          <small>Vous</small>
        </div>
      </div>
      <div class="row" style="max-width:340px;margin:0 auto;gap:12px">
        <button class="secondary" id="muteVoice">🎙️ Micro actif</button>
        <button class="primary"   id="leaveVoice">Quitter</button>
      </div>
    </div>`;

  socket.emit('voice:join', { roomId: id });
  const peers = {};
  let stream = null;
  let muted = false;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    toast('Micro connecté 🎙️', 'success');
  } catch { toast('Microphone refusé — vérifie tes permissions', 'error'); }

  $('#muteVoice').onclick = () => {
    if (!stream) return;
    const t = stream.getAudioTracks()[0];
    muted = !muted;
    t.enabled = !muted;
    $('#muteVoice').textContent = muted ? '🔇 Micro coupé' : '🎙️ Micro actif';
    $('#muteVoice').style.borderColor = muted ? 'var(--danger)' : '';
    socket.emit('voice:mute', { roomId: id, muted });
  };

  $('#leaveVoice').onclick = async () => {
    if (stream) stream.getTracks().forEach(t => t.stop());
    socket.emit('voice:leave', { roomId: id });
    await api('/voice/rooms/' + id + '/leave', { method: 'POST' });
    renderVoice();
  };

  /* WebRTC signaling */
  const createPeer = (uid, initiator) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peers[uid] = pc;
    if (stream) stream.getTracks().forEach(t => pc.addTrack(t, stream));
    pc.onicecandidate = e => e.candidate && socket.emit('voice:signal', { roomId: id, to: uid, data: { candidate: e.candidate } });
    pc.ontrack = e => {
      const a = new Audio();
      a.autoplay = true;
      a.srcObject = e.streams[0];
      document.body.append(a);
    };
    return pc;
  };

  socket.off('voice:signal').on('voice:signal', async ({ from, data }) => {
    if (!peers[from]) {
      const pc = createPeer(from, false);
      if (data?.offer) {
        await pc.setRemoteDescription(data.offer);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        socket.emit('voice:signal', { roomId: id, to: from, data: { answer: pc.localDescription } });
      }
    } else {
      const pc = peers[from];
      if (data?.answer)    await pc.setRemoteDescription(data.answer);
      if (data?.candidate) await pc.addIceCandidate(data.candidate);
    }
  });

  socket.off('voice:peers').on('voice:peers', async ({ peers: list }) => {
    for (const uid of list) {
      const pc = createPeer(uid, true);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('voice:signal', { roomId: id, to: uid, data: { offer: pc.localDescription } });
    }
  });
}

/* ══════════════════════════════════
   EVENT LISTENERS
══════════════════════════════════ */

document.querySelectorAll('.nav').forEach(b => b.onclick = () => loadView(b.dataset.view));

$('#authBtn').onclick = login;

$('#switchAuth').onclick = () => {
  authMode = authMode === 'register' ? 'login' : 'register';
  const isReg = authMode === 'register';
  $('#displayName').style.display = isReg ? '' : 'none';
  $('#authBtn').textContent    = isReg ? 'Créer mon compte' : 'Se connecter';
  $('#switchAuth').textContent = isReg ? "J'ai déjà un compte" : 'Créer un compte';
};

$('#logout').onclick = () => {
  localStorage.removeItem('moto_token');
  location.reload();
};

$('#newPost').onclick         = () => loadView('feed');
$('#notificationBtn').onclick = () => {
  notifications.forEach(n => n.read = true);
  localStorage.setItem('moto_notifications', JSON.stringify(notifications));
  updateBadges();
  loadView('notifications');
};

/* ── Enter key on auth ── */
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !$('#auth').classList.contains('hidden')) login();
});

/* ── Boot ── */
if (token) boot();
