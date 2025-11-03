import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';

const app = express();
app.use(cors());
app.use(express.json());

// Inicializa Firebase Admin (usa la Service Account que pondrás luego)
admin.initializeApp();

// Endpoint de prueba
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Crear usuario en Firebase Auth
app.post('/users', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await admin.auth().createUser({ email, password });
    res.json({ uid: user.uid, email: user.email });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Guardar una nota en Firestore
app.post('/notes', async (req, res) => {
  try {
    const { uid, text } = req.body;
    const db = admin.firestore();
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

// Arrancar el servidor
const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`✅ API corriendo en http://localhost:${port}`));
