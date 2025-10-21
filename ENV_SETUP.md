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
- `PORT`: Leave empty (Railway provides automatically for HTTP)
- `WS_PORT`: `3002` (for WebSocket on private network)
- `DEBUG`: `false`

**Note:** The HTTP server runs on the public Railway domain (PORT), while WebSocket runs on a separate port (WS_PORT) using Railway's private networking.

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
- `NEXT_PUBLIC_API_URL`: `https://andre2-backend-production.up.railway.app` (public HTTPS)
- `NEXT_PUBLIC_WS_URL`: `ws://andre2-backend.railway.internal:3002` (private WebSocket)

**Important:** 
- HTTP/HTTPS uses the public Railway domain for external access
- WebSocket uses Railway's private network (`.railway.internal`) for internal service-to-service communication
- The private network is faster and doesn't count against bandwidth limits

## Railway Deployment Setup

### Step 1: Create Projects
1. Go to [railway.app](https://railway.app)
2. Create two projects in the **same Railway project/environment**:
   - Backend service
   - Frontend service
3. Connect your GitHub repository to each service
4. Make sure both services are in the same project for private networking

### Step 2: Backend Environment Variables
In Railway dashboard → Backend Service → Variables:
```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_REDIRECT_URI=https://andre2-backend-production.up.railway.app/api/spotify/callback
FRONTEND_URL=https://andre2-frontend-production.up.railway.app
WS_PORT=3002
POLL_INTERVAL_MS=1000
DEBUG=false
```

**Note:** Do NOT set `PORT` - Railway assigns this automatically for the public HTTP server.

### Step 3: Frontend Environment Variables
In Railway dashboard → Frontend Service → Variables:
```
NEXT_PUBLIC_API_URL=https://andre2-backend-production.up.railway.app
NEXT_PUBLIC_WS_URL=ws://andre2-backend.railway.internal:3002
```

**Important:** 
- `NEXT_PUBLIC_API_URL` uses the public HTTPS domain
- `NEXT_PUBLIC_WS_URL` uses the private `.railway.internal` domain on port 3002

### Step 4: Deploy
- Push to main branch on GitHub
- Railway auto-deploys when changes are detected
- Monitor build logs in Railway dashboard

### Step 5: Verify Private Networking
1. Both services must be in the same Railway project
2. Check that the backend service shows port 3002 is listening
3. The frontend can connect to `andre2-backend.railway.internal:3002` only within Railway's private network

## Notes

- The `.env.example` files in each directory show the required variables
- Never commit `.env` or `.env.local` files to git (they're in `.gitignore`)
- All frontend environment variables must be prefixed with `NEXT_PUBLIC_` to be accessible in the browser
- Railway automatically assigns `PORT` for HTTP server
- Always use `https://` and `wss://` in production (Railway provides TLS automatically)
- Backend URL for frontend must include the full domain (e.g., `https://andre2-backend-production.up.railway.app`)

