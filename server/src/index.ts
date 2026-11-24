import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, DATA_DIR } from './db.js';
import { requireAuth } from './auth.js';
import authRoutes from './routes/auth.js';
import entriesRoutes from './routes/entries.js';
import photosRoutes, {
  MAX_PHOTOS_PER_ENTRY,
  MAX_PHOTO_SIZE_MB,
} from './routes/photos.js';
import promptsRoutes from './routes/prompts.js';

initDb();

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'midline-journal' });
});

// Auth routes (public + partially protected internally)
app.use('/api/auth', authRoutes);

// Protected API routes
app.use('/api/entries', requireAuth, entriesRoutes);
app.use('/api/photos', requireAuth, photosRoutes);
app.use('/api/prompts', requireAuth, promptsRoutes);

// Serve built React frontend in production
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');

if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error('Server error:', err);
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        res.status(400).json({
          error: `You can attach up to ${MAX_PHOTOS_PER_ENTRY} photos per entry.`,
        });
        return;
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({
          error: `Each photo must be ${MAX_PHOTO_SIZE_MB} MB or smaller.`,
        });
        return;
      }
    }
    res.status(400).json({ error: err.message || 'Something went wrong.' });
  }
);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Midline Journal server running on http://0.0.0.0:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
