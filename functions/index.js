/* =========================
 * Firebase Functions (Gen2) - PadelPoint API
 * ========================= */
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2/options');

setGlobalOptions({ region: 'us-central1', memory: '256MiB' });

// En Functions usamos credenciales gestionadas
admin.initializeApp();
const db = admin.firestore();

const app = express();

// CORS (agregá dominios de tu front si los tenés)
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    // agregá aquí tu dominio web si lo tenés
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));
app.use(express.json());

// Log simple
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

/* -------- HEALTH -------- */
app.get('/health', (_req, res) => {
  res.json({ ok: true, env: 'functions', ts: Date.now() });
});

/* -------- USERS (abierto) --------
 * Crea usuario en Firebase Auth por email/password (mínimo 6 caracteres).
 */
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

/* =======================================
 * PROFILES
 * ======================================= */

/**
 * POST /profiles/me  (protegido)
 * Crea/actualiza perfil del usuario autenticado.
 * Campos:
 *  - displayName* (string)
 *  - level* (number 1..7)
 *  - availability (array<string>) ej: ["Lun tarde","Sab mañana"]
 *  - experience (string, opcional, 0..140)
 *  - style (string, opcional, 0..140)
 *  - age (number, opcional)
 *  - gender ("masculino"|"femenino"|null)
 *  - city (string, opcional)
 *  - zone (string, opcional)
 */
app.post('/profiles/me', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const {
      displayName,
      level,
      availability,
      experience,
      style,
      age,
      gender,
      city,
      zone,
    } = req.body || {};

    if (!displayName || !String(displayName).trim()) {
      return res.status(400).json({ error: 'displayName es obligatorio' });
    }
    const lvlNum = Number(level);
    if (!Number.isFinite(lvlNum) || lvlNum < 1 || lvlNum > 7) {
      return res.status(400).json({ error: 'level debe estar entre 1 y 7' });
    }

    const doc = {
      uid,
      displayName: String(displayName).trim(),
      level: lvlNum,
      availability: Array.isArray(availability) ? availability.slice(0, 10) : null,
      experience: experience ? String(experience).slice(0, 140) : null,
      style: style ? String(style).slice(0, 140) : null,
      age: Number.isFinite(Number(age)) ? Number(age) : null,
      gender: (gender === 'masculino' || gender === 'femenino') ? gender : null,
      city: city || null,
      zone: zone || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection('profiles').doc(uid).set(doc, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /profiles/me  (protegido)
 * Devuelve el perfil del usuario autenticado (o null).
 */
app.get('/profiles/me', authMiddleware, async (req, res) => {
  try {
    const snap = await db.collection('profiles').doc(req.user.uid).get();
    res.json(snap.exists ? snap.data() : null);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* =======================================
 * MATCHES
 * ======================================= */

/**
 * POST /matches  (protegido)
 * Crea partido con modalidad y cupo:
 *  - mode: "1v1" (maxPlayers=2) | "2v2" (maxPlayers=4)  *obligatorio
 *  - levelMin / levelMax (si no se envían, se auto-derivan del nivel del creador ±0.5)
 *  - players arranca con el creador
 *  - status: "open" → pasa a "full" cuando se completa el cupo
 */
app.post('/matches', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;

    // Nivel del creador (obligatorio para auto-limitar)
    const meSnap = await db.collection('profiles').doc(uid).get();
    const myProfile = meSnap.exists ? meSnap.data() : null;
    if (!myProfile || !myProfile.level) {
      return res.status(400).json({ error: 'Completá tu perfil (nivel) antes de crear partidos' });
    }

    const {
      title,
      date,          // "YYYY-MM-DD" (MVP simple)
      time,          // "HH:mm"
      location,      // club/cancha
      mode,          // "1v1" | "2v2"
      levelMin,
      levelMax,
      zone,
    } = req.body || {};

    if (!mode || !['1v1', '2v2'].includes(mode)) {
      return res.status(400).json({ error: 'mode debe ser "1v1" o "2v2"' });
    }
    const maxPlayers = mode === '1v1' ? 2 : 4;

    const lvlMin = Number.isFinite(Number(levelMin)) ? Number(levelMin) : Math.max(1, myProfile.level - 0.5);
    const lvlMax = Number.isFinite(Number(levelMax)) ? Number(levelMax) : Math.min(7, myProfile.level + 0.5);
    if (lvlMin > lvlMax) return res.status(400).json({ error: 'levelMin no puede ser > levelMax' });

    const payload = {
      title: (title || location || 'Partido'),
      date: date || null,
      time: time || null,
      location: location || null,
      zone: zone || myProfile.zone || null,
      mode,
      maxPlayers,
      levelMin: lvlMin,
      levelMax: lvlMax,
      players: [uid], // el creador se anota
      createdBy: uid,
      status: 'open', // open | full | closed
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await db.collection('matches').add(payload);
    const doc = await ref.get();
    res.status(201).json({ id: ref.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /matches  (abierta)
 * Lista partidos abiertos con filtros opcionales:
 *  - ?level=N       (devuelve los que incluyan N entre [levelMin, levelMax])
 *  - ?date=YYYY-MM-DD
 *  - ?zone=Palermo
 */
app.get('/matches', async (req, res) => {
  try {
    let q = db.collection('matches').where('status', '==', 'open');
    const level = req.query.level ? Number(req.query.level) : null;
    const date = req.query.date || null;
    const zone = req.query.zone || null;

    if (date) q = q.where('date', '==', date);
    if (zone) q = q.where('zone', '==', zone);
    if (level !== null && !Number.isNaN(level)) q = q.where('levelMin', '<=', level);

    const snap = await q.orderBy('createdAt', 'desc').limit(50).get();
    let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (level !== null && !Number.isNaN(level)) {
      items = items.filter(m => (typeof m.levelMax === 'number' ? m.levelMax >= level : true));
    }

    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /matches/:id/join  (protegido)
 * Se une al partido si:
 *  - está "open"
 *  - hay cupo (players < maxPlayers)
 *  - el nivel del jugador está dentro de [levelMin, levelMax]
 *  - no está ya unido
 * Si se completa el cupo, marca `status: full`.
 */
app.post('/matches/:id/join', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;

    // Perfil del que se une
    const profSnap = await db.collection('profiles').doc(uid).get();
    const myProfile = profSnap.exists ? profSnap.data() : null;
    if (!myProfile || !myProfile.level) {
      return res.status(400).json({ message: 'Completá tu perfil (nivel) antes de unirte' });
    }

    const matchRef = db.collection('matches').doc(req.params.id);
    const matchDoc = await matchRef.get();
    if (!matchDoc.exists) return res.status(404).json({ message: 'Partido no encontrado' });

    const match = matchDoc.data() || {};
    const players = Array.isArray(match.players) ? match.players : [];
    const maxPlayers = typeof match.maxPlayers === 'number' ? match.maxPlayers : 4;

    if (match.status !== 'open') return res.status(400).json({ message: 'Partido cerrado' });
    if (players.includes(uid)) return res.status(400).json({ message: 'Ya estás en el partido' });
    if (players.length >= maxPlayers) return res.status(400).json({ message: 'Partido lleno' });

    // Chequeo de nivel compatible
    const lvlOk =
      (typeof match.levelMin !== 'number' || myProfile.level >= match.levelMin) &&
      (typeof match.levelMax !== 'number' || myProfile.level <= match.levelMax);
    if (!lvlOk) return res.status(400).json({ message: 'Tu nivel no coincide con el requerido' });

    // Anotar jugador
    await matchRef.update({ players: admin.firestore.FieldValue.arrayUnion(uid) });

    // Si se llenó, cerrar
    const updated = await matchRef.get();
    const after = updated.data();
    if ((after.players?.length || 0) >= after.maxPlayers) {
      await matchRef.update({ status: 'full' });
    }

    res.json({ message: 'Te uniste al partido' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/* -------- Exportar Express como Function HTTPS (Gen2) -------- */
exports.api = onRequest(app);
