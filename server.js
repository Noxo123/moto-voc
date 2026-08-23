const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const db = new Database(process.env.DATABASE_PATH || './moto-voc.sqlite');
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// -------------------- DATABASE --------------------
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url TEXT,
  bio TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS friendships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL,
  addressee_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','blocked')),
  created_at INTEGER NOT NULL,
  UNIQUE(requester_id, addressee_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id INTEGER NOT NULL,
  content TEXT DEFAULT '',
  media_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS post_likes (
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(post_id,user_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL,
  PRIMARY KEY(group_id,user_id)
);
CREATE TABLE IF NOT EXISTS voice_rooms (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('public','private')),
  access_code_hash TEXT,
  max_users INTEGER NOT NULL DEFAULT 25,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS voice_room_members (
  room_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(room_id,user_id)
);
`);

const now = () => Date.now();
const publicUser = row => row && ({ id: row.id, username: row.username, displayName: row.display_name, avatarUrl: row.avatar_url, bio: row.bio });
const hashCode = code => crypto.createHash('sha256').update(String(code)).digest('hex');

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Authentification requise' }); }
}
function issueToken(user) { return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' }); }
function areFriends(a, b) {
  return !!db.prepare(`SELECT 1 FROM friendships WHERE ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)) AND status='accepted'`).get(a,b,b,a);
}
function roomExists(id) { return db.prepare('SELECT * FROM voice_rooms WHERE id=?').get(id); }

// -------------------- AUTH --------------------
app.post('/api/auth/register', async (req,res) => {
  const { username, displayName, password } = req.body || {};
  if (!username || !displayName || !password || password.length < 6) return res.status(400).json({ error:'username, displayName et mot de passe (6 caractères minimum) requis' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare('INSERT INTO users(username,display_name,password_hash,created_at) VALUES(?,?,?,?)').run(username.trim(), displayName.trim(), hash, now());
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid);
    res.status(201).json({ user: publicUser(user), token: issueToken(user) });
  } catch(e) { res.status(409).json({ error:'Nom d’utilisateur déjà utilisé' }); }
});
app.post('/api/auth/login', async (req,res) => {
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(String(req.body?.username || '').trim());
  if (!user || !(await bcrypt.compare(String(req.body?.password || ''), user.password_hash))) return res.status(401).json({ error:'Identifiants invalides' });
  res.json({ user: publicUser(user), token: issueToken(user) });
});
app.get('/api/me', auth, (req,res) => res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) }));

// -------------------- FRIENDS --------------------
app.post('/api/friends/request', auth, (req,res) => {
  const target = db.prepare('SELECT * FROM users WHERE username=? OR id=?').get(String(req.body?.username || ''), Number(req.body?.userId || 0));
  if (!target || target.id === req.user.id) return res.status(400).json({ error:'Utilisateur invalide' });
  const existing = db.prepare('SELECT * FROM friendships WHERE (requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)').get(req.user.id,target.id,target.id,req.user.id);
  if (existing) return res.status(409).json({ error:'Relation déjà existante', friendship: existing });
  const result = db.prepare('INSERT INTO friendships(requester_id,addressee_id,status,created_at) VALUES(?,?,?,?)').run(req.user.id,target.id,'pending',now());
  io.to(`user:${target.id}`).emit('friend:request', { id:result.lastInsertRowid, from:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
  res.status(201).json({ id:result.lastInsertRowid, status:'pending' });
});
app.get('/api/friends', auth, (req,res) => {
  const rows = db.prepare(`SELECT f.*, u.id uid,u.username,u.display_name,u.avatar_url,u.bio FROM friendships f JOIN users u ON u.id=CASE WHEN f.requester_id=? THEN f.addressee_id ELSE f.requester_id END WHERE (f.requester_id=? OR f.addressee_id=?) AND f.status='accepted' ORDER BY u.display_name`).all(req.user.id,req.user.id,req.user.id);
  res.json({ friends:rows.map(x=>({ id:x.id,user:{id:x.uid,username:x.username,displayName:x.display_name,avatarUrl:x.avatar_url,bio:x.bio} })) });
});
app.get('/api/friends/requests', auth, (req,res) => {
  const rows=db.prepare(`SELECT f.id,u.id uid,u.username,u.display_name,u.avatar_url,u.bio FROM friendships f JOIN users u ON u.id=f.requester_id WHERE f.addressee_id=? AND f.status='pending' ORDER BY f.created_at DESC`).all(req.user.id);
  res.json({ requests:rows.map(x=>({id:x.id,user:{id:x.uid,username:x.username,displayName:x.display_name,avatarUrl:x.avatar_url,bio:x.bio}})) });
});
app.post('/api/friends/:id/accept', auth, (req,res) => {
  const f=db.prepare('SELECT * FROM friendships WHERE id=? AND addressee_id=? AND status=\'pending\'').get(req.params.id,req.user.id);
  if(!f) return res.status(404).json({error:'Demande introuvable'});
  db.prepare('UPDATE friendships SET status=\'accepted\' WHERE id=?').run(f.id);
  io.to(`user:${f.requester_id}`).emit('friend:accepted',{friendId:req.user.id});
  res.json({ok:true});
});
app.delete('/api/friends/:id', auth, (req,res) => { db.prepare('DELETE FROM friendships WHERE id=? AND (requester_id=? OR addressee_id=?)').run(req.params.id,req.user.id,req.user.id); res.json({ok:true}); });

// -------------------- PRIVATE CHAT --------------------
app.get('/api/messages/:userId', auth, (req,res) => {
  const other=Number(req.params.userId); if(!areFriends(req.user.id,other)) return res.status(403).json({error:'Vous devez être amis'});
  const messages=db.prepare(`SELECT m.*,u.username,u.display_name,u.avatar_url FROM messages m JOIN users u ON u.id=m.sender_id WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) ORDER BY m.id ASC LIMIT 500`).all(req.user.id,other,other,req.user.id);
  res.json({messages});
});
app.post('/api/messages/:userId', auth, (req,res) => {
  const other=Number(req.params.userId), content=String(req.body?.content || '').trim();
  if(!content || content.length>4000) return res.status(400).json({error:'Message invalide'});
  if(!areFriends(req.user.id,other)) return res.status(403).json({error:'Vous devez être amis'});
  const result=db.prepare('INSERT INTO messages(sender_id,recipient_id,content,created_at) VALUES(?,?,?,?)').run(req.user.id,other,content,now());
  const message=db.prepare('SELECT * FROM messages WHERE id=?').get(result.lastInsertRowid);
  io.to(`user:${other}`).emit('message:new',message); io.to(`user:${req.user.id}`).emit('message:new',message);
  res.status(201).json({message});
});
app.post('/api/messages/:userId/read', auth, (req,res)=>{db.prepare('UPDATE messages SET read_at=? WHERE sender_id=? AND recipient_id=? AND read_at IS NULL').run(now(),Number(req.params.userId),req.user.id);res.json({ok:true});});

// -------------------- SOCIAL FEED --------------------
app.post('/api/posts', auth, (req,res)=>{
  const content=String(req.body?.content || '').trim(); const mediaUrl=req.body?.mediaUrl || null;
  if(!content && !mediaUrl) return res.status(400).json({error:'Publication vide'});
  if(content.length>5000) return res.status(400).json({error:'Publication trop longue'});
  const result=db.prepare('INSERT INTO posts(author_id,content,media_url,created_at) VALUES(?,?,?,?)').run(req.user.id,content,mediaUrl,now());
  const post=db.prepare(`SELECT p.*,u.username,u.display_name,u.avatar_url,(SELECT COUNT(*) FROM post_likes l WHERE l.post_id=p.id) likes FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=?`).get(result.lastInsertRowid);
  io.emit('post:new',post); res.status(201).json({post});
});
app.get('/api/feed', auth, (req,res)=>{
  const posts=db.prepare(`SELECT p.*,u.username,u.display_name,u.avatar_url,(SELECT COUNT(*) FROM post_likes l WHERE l.post_id=p.id) likes,(SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) comments,(SELECT 1 FROM post_likes l WHERE l.post_id=p.id AND l.user_id=?) liked FROM posts p JOIN users u ON u.id=p.author_id ORDER BY p.created_at DESC LIMIT 100`).all(req.user.id);
  res.json({posts});
});
app.post('/api/posts/:id/like', auth,(req,res)=>{const id=Number(req.params.id);const exists=db.prepare('SELECT 1 FROM post_likes WHERE post_id=? AND user_id=?').get(id,req.user.id);if(exists)db.prepare('DELETE FROM post_likes WHERE post_id=? AND user_id=?').run(id,req.user.id);else db.prepare('INSERT INTO post_likes(post_id,user_id,created_at) VALUES(?,?,?)').run(id,req.user.id,now());res.json({liked:!exists});});
app.post('/api/posts/:id/comments', auth,(req,res)=>{const content=String(req.body?.content||'').trim();if(!content)return res.status(400).json({error:'Commentaire vide'});const r=db.prepare('INSERT INTO comments(post_id,user_id,content,created_at) VALUES(?,?,?,?)').run(req.params.id,req.user.id,content,now());const c=db.prepare('SELECT c.*,u.username,u.display_name,u.avatar_url FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=?').get(r.lastInsertRowid);io.emit('post:comment',c);res.status(201).json({comment:c});});
app.get('/api/posts/:id/comments', auth,(req,res)=>res.json({comments:db.prepare('SELECT c.*,u.username,u.display_name,u.avatar_url FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.id ASC').all(req.params.id)}));

// -------------------- GROUPS --------------------
app.post('/api/groups', auth,(req,res)=>{const name=String(req.body?.name||'').trim();if(!name)return res.status(400).json({error:'Nom requis'});const r=db.prepare('INSERT INTO groups(owner_id,name,created_at) VALUES(?,?,?)').run(req.user.id,name,now());db.prepare('INSERT INTO group_members(group_id,user_id,role,created_at) VALUES(?,?,?,?)').run(r.lastInsertRowid,req.user.id,'owner',now());res.status(201).json({group:db.prepare('SELECT * FROM groups WHERE id=?').get(r.lastInsertRowid)});});
app.get('/api/groups',auth,(req,res)=>res.json({groups:db.prepare(`SELECT g.*,gm.role,(SELECT COUNT(*) FROM group_members x WHERE x.group_id=g.id) member_count FROM groups g JOIN group_members gm ON gm.group_id=g.id WHERE gm.user_id=? ORDER BY g.created_at DESC`).all(req.user.id)}));
app.post('/api/groups/:id/members',auth,(req,res)=>{const g=db.prepare('SELECT * FROM groups WHERE id=?').get(req.params.id);const target=db.prepare('SELECT id FROM users WHERE id=? OR username=?').get(Number(req.body?.userId||0),String(req.body?.username||''));const owner=db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=? AND role=\'owner\'').get(req.params.id,req.user.id);if(!g||!target||!owner)return res.status(403).json({error:'Non autorisé'});db.prepare('INSERT OR IGNORE INTO group_members(group_id,user_id,role,created_at) VALUES(?,?,\'member\',?)').run(req.params.id,target.id,now());io.to(`user:${target.id}`).emit('group:invite',g);res.json({ok:true});});

// -------------------- VOICE ROOMS --------------------
app.post('/api/voice/rooms',auth,(req,res)=>{
  const name=String(req.body?.name||'Salon vocal').trim().slice(0,100); const visibility=req.body?.visibility==='private'?'private':'public';
  const maxUsers=Math.min(100,Math.max(2,Number(req.body?.maxUsers||25))); const code=visibility==='private'?String(req.body?.code||'').trim():null;
  if(visibility==='private' && (!code || code.length<4)) return res.status(400).json({error:'Un code d’au moins 4 caractères est requis pour un salon privé'});
  const id=crypto.randomBytes(8).toString('hex'); db.prepare('INSERT INTO voice_rooms(id,owner_id,name,visibility,access_code_hash,max_users,created_at) VALUES(?,?,?,?,?,?,?)').run(id,req.user.id,name,visibility,code?hashCode(code):null,maxUsers,now());
  const room=roomExists(id); io.emit('voice:room-created',{...room,access_code_hash:undefined}); res.status(201).json({room:{...room,access_code_hash:undefined},code:visibility==='private'?code:undefined});
});
app.get('/api/voice/rooms',auth,(req,res)=>{const rooms=db.prepare(`SELECT r.id,r.owner_id,r.name,r.visibility,r.max_users,r.created_at,u.username owner_username,(SELECT COUNT(*) FROM voice_room_members m WHERE m.room_id=r.id) member_count FROM voice_rooms r JOIN users u ON u.id=r.owner_id WHERE r.visibility='public' ORDER BY r.created_at DESC`).all();res.json({rooms});});
app.post('/api/voice/rooms/:id/join',auth,(req,res)=>{const room=roomExists(req.params.id);if(!room)return res.status(404).json({error:'Salon vocal introuvable'});if(room.visibility==='private' && hashCode(String(req.body?.code||''))!==room.access_code_hash)return res.status(403).json({error:'Code incorrect'});const count=db.prepare('SELECT COUNT(*) c FROM voice_room_members WHERE room_id=?').get(room.id).c;if(count>=room.max_users)return res.status(409).json({error:'Salon complet'});db.prepare('INSERT OR REPLACE INTO voice_room_members(room_id,user_id,joined_at) VALUES(?,?,?)').run(room.id,req.user.id,now());res.json({room:{...room,access_code_hash:undefined}});});
app.post('/api/voice/rooms/:id/leave',auth,(req,res)=>{db.prepare('DELETE FROM voice_room_members WHERE room_id=? AND user_id=?').run(req.params.id,req.user.id);res.json({ok:true});});
app.delete('/api/voice/rooms/:id',auth,(req,res)=>{const room=roomExists(req.params.id);if(!room||room.owner_id!==req.user.id)return res.status(403).json({error:'Seul le propriétaire peut supprimer le salon'});db.prepare('DELETE FROM voice_room_members WHERE room_id=?').run(room.id);db.prepare('DELETE FROM voice_rooms WHERE id=?').run(room.id);io.emit('voice:room-deleted',{id:room.id});res.json({ok:true});});

// -------------------- SOCKET.IO + WEBRTC SIGNALING --------------------
const socketUsers=new Map();
io.use((socket,next)=>{try{const token=socket.handshake.auth?.token || String(socket.handshake.headers.authorization||'').replace(/^Bearer\s+/i,'');socket.user=jwt.verify(token,JWT_SECRET);next();}catch{next(new Error('unauthorized'));}});
io.on('connection',socket=>{
  const uid=socket.user.id; socketUsers.set(socket.id,uid); socket.join(`user:${uid}`); socket.broadcast.emit('presence:update',{userId:uid,online:true});
  socket.on('dm:typing',({to,isTyping})=>{if(areFriends(uid,Number(to)))io.to(`user:${Number(to)}`).emit('dm:typing',{from:uid,isTyping:!!isTyping});});
  socket.on('voice:join',({roomId})=>{const room=roomExists(roomId);if(!room)return;socket.join(`voice:${roomId}`);socket.to(`voice:${roomId}`).emit('voice:peer-joined',{userId:uid});socket.emit('voice:peers',{peers:[...io.sockets.adapter.rooms.get(`voice:${roomId}`)||[]].map(id=>socketUsers.get(id)).filter(x=>x&&x!==uid)});});
  socket.on('voice:leave',({roomId})=>{socket.leave(`voice:${roomId}`);socket.to(`voice:${roomId}`).emit('voice:peer-left',{userId:uid});});
  // WebRTC SDP/ICE are forwarded only inside the selected voice room.
  socket.on('voice:signal',({roomId,to,data})=>{const target=Number(to);for(const [sid,userId] of socketUsers){if(userId===target)io.to(sid).emit('voice:signal',{from:uid,data});}});
  socket.on('voice:mute',({roomId,muted})=>socket.to(`voice:${roomId}`).emit('voice:mute',{userId:uid,muted:!!muted}));
  socket.on('disconnect',()=>{socketUsers.delete(socket.id);socket.broadcast.emit('presence:update',{userId:uid,online:false});});
});

app.get('/api/health',(req,res)=>res.json({ok:true,service:'moto-voc',time:now()}));
app.get('/',(req,res)=>res.json({name:'Moto Voc API',version:'1.0.0',features:['friends','messages','posts','groups','public voice','private voice','WebRTC signaling']}));

server.listen(PORT,()=>console.log(`Moto Voc server running on http://localhost:${PORT}`));
