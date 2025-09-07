import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';

dotenv.config();

const app = express();
const server = http.createServer(app);

// CORS
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ? process.env.ALLOW_ORIGIN.split(',') : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002', 'https://aisfrontend.vercel.app/'];
app.use(cors({ 
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Optional Mongo (fallback to in-memory/json file)
const MONGO_URI = process.env.MONGO_URI || '';
let QuizModel = null;

const quizSchema = new mongoose.Schema({
  id: String,
  title: String,
  questions: [{
    q: String,
    choices: [String],
    answer: Number,
    hint: String
  }]
});

async function initDB() {
  if (!MONGO_URI) {
    console.log('[DB] No MONGO_URI provided. Using JSON file fallback.');
    return false;
  }
  try {
    await mongoose.connect(MONGO_URI);
    QuizModel = mongoose.model('Quiz', quizSchema);
    console.log('[DB] Connected to Mongo.');
    // Seed if empty
    const count = await QuizModel.countDocuments();
    if (count === 0) {
      const data = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'quizzes.json'), 'utf-8'));
      await QuizModel.insertMany(data.quizzes);
      console.log('[DB] Seeded quizzes.');
    }
    // Always sync (upsert) JSON quizzes so new additions appear without manual reseed
    try {
      const data = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'quizzes.json'), 'utf-8'));
      let changed = 0;
      for (const quiz of data.quizzes) {
        const res = await QuizModel.updateOne({ id: quiz.id }, { $set: quiz }, { upsert: true });
        if (res.upsertedCount || res.modifiedCount) changed++;
      }
      console.log(`[DB] Synced quizzes (upserted/modified: ${changed}).`);
    } catch (syncErr) {
      console.warn('[DB] Quiz sync failed:', syncErr.message);
    }
    return true;
  } catch (e) {
    console.error('[DB] Failed to connect, fallback to JSON.', e.message);
    return false;
  }
}

const io = new SocketIOServer(server, {
  cors: { origin: ALLOW_ORIGIN }
});

// Whiteboard socket rooms
io.on('connection', (socket) => {
  // Join a room (classroom) namespace
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    socket.emit('joined', roomId);
  });
  // Broadcast drawing events to room
  socket.on('draw-line', ({ roomId, line }) => {
    socket.to(roomId).emit('draw-line', { line });
  });
  socket.on('clear-board', ({ roomId }) => {
    socket.to(roomId).emit('clear-board');
  });
  socket.on('ping-check', () => {
    socket.emit('pong-check', Date.now());
  });
});

// API
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Quizzes API with DB fallback
app.get('/api/quizzes', async (req, res) => {
  try {
    if (QuizModel) {
      const docs = await QuizModel.find({}).lean();
      return res.json({ quizzes: docs });
    }
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'quizzes.json'), 'utf-8'));
    return res.json(raw);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load quizzes' });
  }
});

app.get('/api/quizzes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    if (QuizModel) {
      const doc = await QuizModel.findOne({ id }).lean();
      if (!doc) return res.status(404).json({ error: 'Not found' });
      return res.json(doc);
    }
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'quizzes.json'), 'utf-8'));
    const found = raw.quizzes.find(q => q.id === id);
    if (!found) return res.status(404).json({ error: 'Not found' });
    return res.json(found);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load quiz' });
  }
});

app.post('/api/quizzes', async (req, res) => {
  const body = req.body;
  try {
    if (QuizModel) {
      const created = await QuizModel.create(body);
      return res.json(created);
    }
    // JSON fallback: append to file
    const file = path.join(process.cwd(), 'data', 'quizzes.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.quizzes.push(body);
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    return res.json(body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to save quiz' });
  }
});

const PORT = process.env.PORT || 4000;
const start = async () => {
  const usingMongo = await initDB();
  server.listen(PORT, () => {
    console.log(`[Server] listening on http://localhost:${PORT} (Mongo: ${usingMongo ? 'ON' : 'OFF'})`);
  });
};

start();
