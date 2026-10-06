# WizardChat

A WhatsApp-style chat platform with strong security guarantees.

## Architecture

| Layer | Technology | Hosting |
|---|---|---|
| Frontend | React 19 + Vite + TypeScript + Tailwind CSS 4 | GitHub Pages (`wizardchat.github.io`) |
| Backend API + realtime | Node.js 22 + Express 5 + Socket.IO | Render (free tier) |
| Database | PostgreSQL | Neon (free tier) |
| File storage | Cloudinary | Cloudinary (free tier) |

**Security model:** the frontend is untrusted. Every REST request and WebSocket
handshake is authenticated server-side (JWT + rotating refresh tokens).
Passwords are hashed with Argon2id. Private 1-on-1 chats use client-side
end-to-end encryption (X25519 + AES-256-GCM); group chats and metadata are
encrypted at rest on the server. Admin actions are role-checked in API
middleware and written to an audit log.

## Repository layout

```
frontend/   React SPA  → deployed to GitHub Pages
backend/    Node API   → deployed to Render (uses Neon Postgres)
```

## Local development

Prerequisites: Node.js >= 22, npm >= 10.

```bash
npm install

# Backend
cp backend/.env.example backend/.env   # fill in DATABASE_URL (Neon connection string)
npm run dev -w backend

# Frontend (separate terminal)
cp frontend/.env.example frontend/.env
npm run dev -w frontend
```

Or run both at once: `npm run dev`

- API: http://localhost:3000 (health: `/health`, DB check: `/ready`)
- Web: http://localhost:5173

### Database migrations

```bash
npm run prisma:generate -w backend      # generate client
npm run prisma:migrate:dev -w backend   # create/apply migration (local)
npm run prisma:migrate:deploy -w backend # apply committed migrations (CI/Render)
```

## Deploying

### 1. Database — Neon

1. Create a free project at [neon.tech](https://neon.tech).
2. Copy the pooled connection string (looks like
   `postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require`).
3. Store it in Render → your service → Environment → `DATABASE_URL`.

### 2. Backend — Render

1. Push this repository to GitHub.
2. In [render.com](https://render.com) → **New** → **Blueprint**, select the repo.
   Render reads `render.yaml` and creates the web service automatically.
3. Set environment variables (see `render.yaml` for the full list):
   - `DATABASE_URL` — Neon connection string
   - `CORS_ORIGINS` — `https://wizardchat.github.io`
   - `CLOUDINARY_URL` — `cloudinary://API_KEY:API_SECRET@CLOUD_NAME`, pasted
     from your [Cloudinary](https://cloudinary.com) dashboard. This enables
     attachments and avatars; without it the API returns `503` for upload
     signatures and the frontend hides the upload buttons.
4. Render runs `prisma migrate deploy` on every deploy, so schema changes
   ship with the code.

### Attachments & avatars (Cloudinary, free tier)

- The client requests a **signed** upload from `POST /uploads/signature`
  (per-user `wizardchat/<userId>` folder, SHA-1 params + API secret — the secret
  never leaves the server) and uploads the file directly to Cloudinary.
- Attachment descriptors (URL, type, size, dims) are stored encrypted at rest
  with the server key alongside the message; avatars use the same upload
  pipeline. URLs must be HTTPS and update restricted to an allowlist
  (`ALLOWED_ATTACHMENT_HOSTS`, default `res.cloudinary.com`) in production.
- Privacy limitation: in 1-on-1 chats the **caption** is end-to-end encrypted,
  but the attachment itself is server-routable — the server must relay URLs to
  recipients, so it cannot be content-encrypted client-side. Assume media is
  visible to the server.

### 3. Frontend — GitHub Pages

1. Create a GitHub repository **named exactly** `wizardchat.github.io`
   (this is what produces the `wizardchat.github.io` domain).
2. Push the code. The workflow in `.github/workflows/deploy-frontend.yml`
   builds the Vite app and publishes it to GitHub Pages on every push to `main`.
3. In the repo **Settings → Pages → Build and deployment**, set Source to
   **GitHub Actions**.
4. Set a repository variable `VITE_API_URL` (Settings → Secrets and variables
   → Actions → Variables) to your Render URL, e.g.
   `https://wizardchat-api-xxxx.onrender.com`.

> The Vite `base` is `/`, which is correct for a user/organization site
> (`wizardchat.github.io`). If you later deploy as a project page under
> `/repo-name/`, change `base` in `frontend/vite.config.ts`.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Run API + web together |
| `npm run build` | Build both workspaces |
| `npm run lint` | ESLint across the repo |
| `npm run typecheck` | TypeScript checks for both workspaces |

## Security notes

- Never commit `.env` files — only `.env.example` templates exist in the repo.
- The admin account is seeded from Render environment variables, never from
  frontend code.
- CORS is an explicit allowlist (`CORS_ORIGINS`); the API rejects unknown origins.
- Changing any user's password (admin reset) revokes all of that user's sessions.
- File uploads are signed per-user and the upload URL host is restricted in
  production (`ALLOWED_ATTACHMENT_HOSTS`). Attachment descriptors are encrypted
  at rest; DM captions stay end-to-end encrypted on top.
