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

# Server port
PORT=3001

# Optional: Polling interval in milliseconds (default: 1000)
POLL_INTERVAL_MS=1000

# Optional: Debug mode (default: false)
DEBUG=false

# Optional: Comma-separated list of emails that can take master control
MASTER_CONTROL_EMAILS=admin@example.com,pete@example.com

# Optional: Fallback playlist URL to play when the main queue is empty
# Must be a user-created public playlist (Spotify-curated playlists are not supported)
# Defaults to a public user playlist if not set
FALLBACK_PLAYLIST_URL=https://open.spotify.com/playlist/your_playlist_id
```

### For Production/Railway Deployment:

Update the following variables in Railway dashboard:
- `SPOTIFY_CLIENT_ID`: Your Spotify API client ID
- `SPOTIFY_CLIENT_SECRET`: Your Spotify API client secret
- `SPOTIFY_REDIRECT_URI`: `https://andre2-backend-production.up.railway.app/api/spotify/callback`
- `FRONTEND_URL`: `https://andre2-frontend-production.up.railway.app`
- `PORT`: Leave empty (Railway provides automatically)
- `DEBUG`: `false`

**Note:** WebSocket connections now share the same port as HTTP, using the `/websocket` path.

## Frontend (.env.local)

Create a `.env.local` file in the frontend root directory:

```bash
# Backend API URL
NEXT_PUBLIC_API_URL=http://localhost:3001
```

### For Production/Railway Deployment:

Set in Railway dashboard:
- `NEXT_PUBLIC_API_URL`: `https://andre2-backend-production.up.railway.app`

**Important:** 
- WebSocket connections automatically use the same URL as the API at the `/websocket` path
- No separate WebSocket URL configuration is needed

## Railway Deployment Setup

### Step 1: Create Projects
1. Go to [railway.app](https://railway.app)
2. Create two projects:
   - Backend service
   - Frontend service
3. Connect your GitHub repository to each service

### Step 2: Backend Environment Variables
In Railway dashboard → Backend Service → Variables:
```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_REDIRECT_URI=https://andre2-backend-production.up.railway.app/api/spotify/callback
FRONTEND_URL=https://andre2-frontend-production.up.railway.app
POLL_INTERVAL_MS=1000
DEBUG=false
MASTER_CONTROL_EMAILS=admin@example.com
# Optional - must be a user-created public playlist (Spotify-curated playlists not supported)
FALLBACK_PLAYLIST_URL=https://open.spotify.com/playlist/your_playlist_id
```

**Notes:** 
- Do NOT set `PORT` - Railway assigns this automatically
- `MASTER_CONTROL_EMAILS` is optional - only set if you want to allow specific users to take master control

### Step 3: Frontend Environment Variables
In Railway dashboard → Frontend Service → Variables:
```
NEXT_PUBLIC_API_URL=https://andre2-backend-production.up.railway.app
```

### Step 4: Deploy
- Push to main branch on GitHub
- Railway auto-deploys when changes are detected
- Monitor build logs in Railway dashboard

## Notes

- The `.env.example` files in each directory show the required variables
- Never commit `.env` or `.env.local` files to git (they're in `.gitignore`)
- All frontend environment variables must be prefixed with `NEXT_PUBLIC_` to be accessible in the browser
- Railway automatically assigns `PORT` for the HTTP server
- Always use `https://` in production (Railway provides TLS automatically)
- WebSocket connections automatically upgrade from HTTP/HTTPS on the same port at the `/websocket` path
- Backend URL for frontend must include the full domain (e.g., `https://andre2-backend-production.up.railway.app`)

