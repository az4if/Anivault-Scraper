import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import routes from './routes';

const app = express();
const PORT = parseInt(process.env.PORT || '3000');

// Railway (and most PaaS hosts) sit behind a reverse proxy that sets
// X-Forwarded-For. Without this, Express doesn't trust that header, and
// express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every
// /api request — which was breaking requests before they ever reached the
// route handlers (senshi servers/embeds included). `1` trusts exactly one
// hop (the platform's own proxy), which is correct for Railway's setup.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_MAX || '60'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api', limiter);

// API routes
app.use('/api', routes);

// Serve static docs/tester
app.use(express.static(path.join(__dirname, '../public')));

// Catch-all → docs
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🟢 AniVault API running on http://localhost:${PORT}`);
  console.log(`📄 Docs + Tester: http://localhost:${PORT}/`);
  console.log(`🔗 API base:      http://localhost:${PORT}/api\n`);
});

export default app;
