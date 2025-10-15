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

Update the following variables:
- `SPOTIFY_REDIRECT_URI`: Your production backend URL + `/api/spotify/callback`
- `FRONTEND_URL`: Your production frontend URL
- `PORT`: Railway will provide this automatically
- `WS_PORT`: Set to your WebSocket port

## Frontend (.env.local)

Create a `.env.local` file in the frontend root directory:

```bash
# Backend API URL
NEXT_PUBLIC_API_URL=http://localhost:3001

# WebSocket URL  
NEXT_PUBLIC_WS_URL=ws://localhost:3002
```

### For Production/Vercel/Railway Deployment:

Update with your production URLs:
- `NEXT_PUBLIC_API_URL`: Your production backend URL
- `NEXT_PUBLIC_WS_URL`: Your production WebSocket URL (e.g., `wss://your-backend.railway.app`)

## Notes

- The `.env.example` files in each directory show the required variables
- Never commit `.env` or `.env.local` files to git (they're in `.gitignore`)
- All frontend environment variables must be prefixed with `NEXT_PUBLIC_` to be accessible in the browser
- Railway and other platforms will automatically provide `PORT` for the HTTP server

