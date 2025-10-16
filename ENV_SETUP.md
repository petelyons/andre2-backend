# Environment Variables Setup

## Backend (.env)

Create a `.env` file in the backend root directory with the following variables:

```bash
# Spotify API credentials
SPOTIFY_CLIENT_ID=your_spotify_client_id_here
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret_here
SPOTIFY_REDIRECT_URI=http://localhost:3001/api/spotify/callback

# Frontend URL for redirects after OAuth
FRONTEND_URL=http://localhost:3000

# Server ports
PORT=3001
WS_PORT=3002

# Optional: Polling interval in milliseconds (default: 1000)
POLL_INTERVAL_MS=1000

# Optional: Debug mode (default: false)
DEBUG=false
```

### For Production/Railway Deployment:

Update the following variables in Railway dashboard:
- `SPOTIFY_CLIENT_ID`: Your Spotify API client ID
- `SPOTIFY_CLIENT_SECRET`: Your Spotify API client secret
- `SPOTIFY_REDIRECT_URI`: `https://andre2-backend-production.up.railway.app/api/spotify/callback`
- `FRONTEND_URL`: `https://andre2-frontend-production.up.railway.app`
- `PORT`: Leave empty (Railway provides automatically)
- `WS_PORT`: `3002`
- `DEBUG`: `false`

## Frontend (.env.local)

Create a `.env.local` file in the frontend root directory:

```bash
# Backend API URL
NEXT_PUBLIC_API_URL=http://localhost:3001

# WebSocket URL  
NEXT_PUBLIC_WS_URL=ws://localhost:3002
```

### For Production/Railway Deployment:

Set in Railway dashboard:
- `NEXT_PUBLIC_API_URL`: `https://andre2-backend-production.up.railway.app`
- `NEXT_PUBLIC_WS_URL`: `wss://andre2-backend-production.up.railway.app`

## Railway Deployment Setup

### Step 1: Create Projects
1. Go to [railway.app](https://railway.app)
2. Create two projects: one for frontend, one for backend
3. Connect your GitHub repository

### Step 2: Backend Environment Variables
In Railway dashboard → Backend Project → Variables:
```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_REDIRECT_URI=https://andre2-backend-production.up.railway.app/api/spotify/callback
FRONTEND_URL=https://andre2-frontend-production.up.railway.app
WS_PORT=3002
POLL_INTERVAL_MS=1000
DEBUG=false
```

### Step 3: Frontend Environment Variables
In Railway dashboard → Frontend Project → Variables:
```
NEXT_PUBLIC_API_URL=https://andre2-backend-production.up.railway.app
NEXT_PUBLIC_WS_URL=wss://andre2-backend-production.up.railway.app
```

### Step 4: Deploy
- Push to main branch on GitHub
- Railway auto-deploys when changes are detected
- Monitor build logs in Railway dashboard

## Notes

- The `.env.example` files in each directory show the required variables
- Never commit `.env` or `.env.local` files to git (they're in `.gitignore`)
- All frontend environment variables must be prefixed with `NEXT_PUBLIC_` to be accessible in the browser
- Railway automatically assigns `PORT` for HTTP server
- Always use `https://` and `wss://` in production (Railway provides TLS automatically)
- Backend URL for frontend must include the full domain (e.g., `https://andre2-backend-production.up.railway.app`)

