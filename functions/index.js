const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2/options');

setGlobalOptions({ region: 'us-central1', memory: '256MiB' });

// En Functions no se usan claves locales; usa credenciales gestionadas
admin.initializeApp();

const app = express();
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));
app.use(express.json());

// Log simple
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

const db = admin.firestore();

/* -------- HEALTH -------- */
app.get('/health', (_req, res) => {
  res.json({ ok: true, env: 'functions', ts: Date.now() });
});

/* -------- USERS (abierto) -------- */
app.post('/users', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email y password requeridos' });
    const user = await admin.auth().createUser({ email, password });
    res.json({ uid: user.uid, email: user.email });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/* -------- NOTES (abierto) -------- */
app.post('/notes', async (req, res) => {
  try {
    const { uid, text } = req.body || {};
    if (!uid || !text) return res.status(400).json({ error: 'uid y text requeridos' });
    const doc = await db.collection('notes').add({
      uid,
      text,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ id: doc.id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/* -------- Auth middleware (rutas protegidas) -------- */
async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ message: 'No token' });
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid, email: decoded.email || null };
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Token inválido', detail: err.message });
  }
}

/* -------- MATCHES -------- */
// Crear partido (protegido)
app.post('/matches', authMiddleware, async (req, res) => {
  try {
    const payload = req.body || {};
    payload.createdBy = req.user.uid;
    payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
    payload.players = Array.isArray(payload.players) && payload.players.length
      ? payload.players
      : [req.user.uid];
    payload.status = payload.status || 'open';
    // Sugeridos: date (YYYY-MM-DD o Timestamp), levelMin, levelMax, maxPlayers, location
    const ref = await db.collection('matches').add(payload);
    const doc = await ref.get();
    res.status(201).json({ id: ref.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Listar partidos (abierta) con filtros ?level=&date=
// Nota: Firestore no permite dos rangos en campos distintos; hacemos 1 en query y 1 en memoria.
app.get('/matches', async (req, res) => {
  try {
    let q = db.collection('matches');
    const level = req.query.level ? Number(req.query.level) : null;
    const date = req.query.date || null;

    if (date) q = q.where('date', '==', date);
    if (level !== null && !Number.isNaN(level)) q = q.where('levelMin', '<=', level);

    const snap = await q.orderBy('createdAt', 'desc').limit(50).get();
    let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (level !== null && !Number.isNaN(level)) {
      items = items.filter(m => (typeof m.levelMax === 'number' ? m.levelMax >= level : true));
    }

    res.json(items);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Unirse a partido (protegido)
app.post('/matches/:id/join', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const matchRef = db.collection('matches').doc(req.params.id);
    const matchDoc = await matchRef.get();
    if (!matchDoc.exists) return res.status(404).json({ message: 'Partido no encontrado' });

    const match = matchDoc.data() || {};
    const players = Array.isArray(match.players) ? match.players : [];
    const maxPlayers = typeof match.maxPlayers === 'number' ? match.maxPlayers : 4;

    if (players.includes(uid)) return res.status(400).json({ message: 'Ya estás en el partido' });
    if (players.length >= maxPlayers) return res.status(400).json({ message: 'Partido lleno' });

    await matchRef.update({ players: admin.firestore.FieldValue.arrayUnion(uid) });
    res.json({ message: 'Te uniste al partido' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/* -------- Exportar Express como Function HTTPS (Gen2) -------- */
exports.api = onRequest(app);
