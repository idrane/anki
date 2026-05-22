# Personal SRS Web

Private spaced repetition web app with Supabase Auth, Google login, and
per-user Supabase Postgres storage.

## Local development

```bash
npm install
cp .env.example .env
npm run dev
```

Set `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env` before starting local development.

## Netlify

The repository root has a `netlify.toml` that points Netlify at this app.
When creating a site manually, use `personal-srs-web` as the base directory.

- Build command: `npm run build`
- Publish directory: `dist`

Required build environment variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

The app stores cards and review logs in Supabase tables protected by row-level
security. It also keeps a browser cache after sign-in, and the Files tab can
import/export JSON backups.

## Google login

Enable Google in the Supabase project's Auth Providers settings. Google Cloud
must allow this origin:

- `https://personal-srs.netlify.app`

The Google OAuth redirect URI must be the Supabase callback URL:

- `https://seeptjqmaqhheiklypla.supabase.co/auth/v1/callback`
