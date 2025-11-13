/* ====== Firebase Functions Gen2 + Express (Padel) ====== */
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2/options');

setGlobalOptions({ region: 'us-central1', memory: '256MiB' });
admin.initializeApp();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const db = admin.firestore();

/* --------- Utils --------- */
const BAND_RANK = { '8va': 1, '7ma': 2, '6ta': 3, '5ta': 4, '4ta': 5, '3ra': 6 };
const rankOf = (b) => BAND_RANK[b] ?? null;
const nowTs = () => admin.firestore.FieldValue.serverTimestamp();

/* --------- Health --------- */
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* --------- Auth middleware (ID Token de Firebase) --------- */
async function authMiddleware(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ message: 'No token' });
    const decoded = await admin.auth().verifyIdToken(h.slice(7));
    req.user = { uid: decoded.uid, email: decoded.email || null };
    next();
  } catch (e) {
    return res.status(401).json({ message: 'Token inválido', detail: e.message });
  }
}

/* ======================= USERS / PERFIL ======================= */
/** Alta simple de usuario por API (pruebas) */
app.post('/users', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email y password requeridos' });
    const u = await admin.auth().createUser({ email, password });
    res.json({ uid: u.uid, email: u.email });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Obtener/guardar perfil: /profiles/{uid}  */
app.get('/me', authMiddleware, async (req, res) => {
  const ref = db.collection('profiles').doc(req.user.uid);
  const snap = await ref.get();
  res.json(snap.exists ? snap.data() : null);
});

app.put('/profile', authMiddleware, async (req, res) => {
  const p = req.body || {};

  // Campos alineados con el front (bandas, posición, estilo de juego)
  const safe = {
    uid: req.user.uid,
    displayName: (p.displayName || '').trim(),

    // banda y ranking para facilitar filtros futuros
    levelBand: p.levelBand || '8va',
    levelBandRank: rankOf(p.levelBand || '8va'),

    position: p.position || 'Drive',
    styleGame: p.styleGame || 'Ofensivo',

    experienceYears: Number(p.experienceYears) || 0,
    age: p.age ? Number(p.age) : null,
    gender: p.gender || 'Masculino',
    city: p.city || '',
    zone: p.zone || '',

    updatedAt: nowTs(),
    createdAt: nowTs(),
  };

  await db.collection('profiles').doc(req.user.uid).set(safe, { merge: true });
  res.json(safe);
});

/* ======================= MATCHES ======================= */
/**
 * Crear partido (2v2 fijo: 4 jugadores)
 * El creador queda agregado en players.
 * Guardamos bandas y también “rank” para filtros.
 */
app.post('/matches', authMiddleware, async (req, res) => {
  try {
    const p = req.body || {};
    const players = [req.user.uid];

    const levelMinBand = p.levelMin || '8va';
    const levelMaxBand = p.levelMax || '3ra';

    const docData = {
      title: (p.title || 'Partido').trim(),
      date: p.date || null,      // YYYY-MM-DD
      time: p.time || null,      // HH:mm
      location: p.location || null,
      mode: '2v2',
      zone: p.zone || null,

      levelMin: levelMinBand,
      levelMax: levelMaxBand,
      levelMinRank: rankOf(levelMinBand),
      levelMaxRank: rankOf(levelMaxBand),

      createdBy: req.user.uid,
      createdAt: nowTs(),
      updatedAt: nowTs(),
      maxPlayers: 4,             // 2v2 fijo
      players,
      status: players.length >= 4 ? 'full' : 'open', // open|full
    };

    const ref = await db.collection('matches').add(docData);
    const snap = await ref.get();
    res.status(201).json({ id: ref.id, ...snap.data() });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/**
 * Listado general con filtros (?levelBand=&date=).
 * Para NO requerir índices compuestos, si hay filtros NO usamos orderBy en Firestore;
 * traemos hasta 50 y ordenamos en memoria.
 */
app.get('/matches', async (req, res) => {
  try {
    const levelBand = req.query.levelBand || null;
    const levelRank = levelBand ? rankOf(levelBand) : null;
    const date = req.query.date || null;

    let q = db.collection('matches');

    const hasFilter = Boolean(date || levelRank !== null);

    if (date) q = q.where('date', '==', date);
    if (levelRank !== null) q = q.where('levelMinRank', '<=', levelRank);

    const snap = hasFilter
      ? await q.limit(50).get() // sin orderBy → sin índice compuesto
      : await q.orderBy('createdAt', 'desc').limit(50).get();

    let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (levelRank !== null) {
      items = items.filter(m => (typeof m.levelMaxRank === 'number' ? m.levelMaxRank >= levelRank : true));
    }

    // Ordeno en memoria si hubo filtros
    if (hasFilter) {
      items.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
    }

    res.json(items);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/** Mis partidos (creados por mí O a los que me uní) — sin índice compuesto */
app.get('/matches/mine', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;

    // creados por mí
    const createdSnap = await db.collection('matches')
      .where('createdBy', '==', uid)
      .limit(50)
      .get();

    // donde estoy en players
    const joinedSnap = await db.collection('matches')
      .where('players', 'array-contains', uid)
      .limit(50)
      .get();

    const map = new Map();
    createdSnap.docs.forEach(d => map.set(d.id, { id: d.id, ...d.data() }));
    joinedSnap.docs.forEach(d => map.set(d.id, { id: d.id, ...d.data() }));

    const items = Array.from(map.values())
      .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));

    res.json(items);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

/** Partidos abiertos (no llenos, generales) — se mantiene por compatibilidad */
app.get('/matches/open', async (_req, res) => {
  try {
    const snap = await db.collection('matches')
      .where('status', '==', 'open')
      .limit(50)
      .get();

    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));

    res.json(items);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

/** Disponibles para mí: abiertos, no creados por mí y donde no estoy unido */
app.get('/matches/available', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;

    const snap = await db.collection('matches')
      .where('status', '==', 'open')
      .limit(50)
      .get();

    const items = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(m => m.createdBy !== uid && !(Array.isArray(m.players) && m.players.includes(uid)))
      .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));

    res.json(items);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/** Unirse */
app.post('/matches/:id/join', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const ref = db.collection('matches').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ message: 'Partido no encontrado' });

    const m = snap.data();
    const players = Array.isArray(m.players) ? m.players : [];
    const maxPlayers = Number(m.maxPlayers) || 4;

    if (m.createdBy === uid) return res.status(400).json({ message: 'Sos el creador' });
    if (players.includes(uid)) return res.status(400).json({ message: 'Ya estás en el partido' });
    if (players.length >= maxPlayers) return res.status(400).json({ message: 'Partido lleno' });

    await ref.update({
      players: admin.firestore.FieldValue.arrayUnion(uid),
      status: players.length + 1 >= maxPlayers ? 'full' : 'open',
      updatedAt: nowTs(),
    });
    res.json({ message: 'Te uniste' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

/** Salir */
app.post('/matches/:id/leave', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const ref = db.collection('matches').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ message: 'Partido no encontrado' });

    const m = snap.data();
    const players = Array.isArray(m.players) ? m.players : [];
    if (!players.includes(uid)) return res.status(400).json({ message: 'No estabas en el partido' });
    if (m.createdBy === uid) return res.status(400).json({ message: 'El creador debe editar o eliminar' });

    await ref.update({
      players: admin.firestore.FieldValue.arrayRemove(uid),
      status: 'open',
      updatedAt: nowTs(),
    });
    res.json({ message: 'Saliste del partido' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

/** Editar (solo creador) */
app.put('/matches/:id', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const ref = db.collection('matches').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ message: 'Partido no encontrado' });
    if (snap.data().createdBy !== uid) return res.status(403).json({ message: 'No autorizado' });

    const p = req.body || {};

    const patch = {
      title: p.title ?? snap.data().title,
      date: p.date ?? snap.data().date,
      time: p.time ?? snap.data().time,
      location: p.location ?? snap.data().location,
      zone: p.zone ?? snap.data().zone,

      levelMin: p.levelMin ?? snap.data().levelMin,
      levelMax: p.levelMax ?? snap.data().levelMax,
      levelMinRank: p.levelMin ? rankOf(p.levelMin) : snap.data().levelMinRank,
      levelMaxRank: p.levelMax ? rankOf(p.levelMax) : snap.data().levelMaxRank,

      updatedAt: nowTs(),
    };

    await ref.update(patch);
    const updated = await ref.get();
    res.json({ id: ref.id, ...updated.data() });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

/** Eliminar (solo creador) */
app.delete('/matches/:id', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const ref = db.collection('matches').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ message: 'Partido no encontrado' });
    if (snap.data().createdBy !== uid) return res.status(403).json({ message: 'No autorizado' });

    await ref.delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

/* --------- Export --------- */
exports.api = onRequest(app);
