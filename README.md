# Andre2 Backend

Backend server for the Andre2 music sharing application. Provides Spotify integration, WebSocket real-time communication, and session management.

## Features

- **Spotify Integration**: OAuth authentication and API integration
- **WebSocket Server**: Real-time communication for music playback sync
- **Session Management**: Create and manage music sharing sessions
- **REST API**: Endpoints for authentication, sessions, and Spotify data

## Tech Stack

- **Node.js** - Runtime environment
- **Express.js** - Web framework
- **TypeScript** - Type safety
- **WebSocket (ws)** - Real-time communication
- **Spotify Web API** - Music integration

## Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- Spotify Developer Account

## Installation

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Set up environment variables**

   Create a `.env` file in the root directory:
   ```env
   SPOTIFY_CLIENT_ID=your_spotify_client_id
   SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
   SPOTIFY_REDIRECT_URI=http://localhost:3001/api/spotify/callback
   PORT=3001
   ```

3. **Build the project**
   ```bash
   npm run build
   ```

## Development

Start the development server with hot reload:
```bash
npm run dev
```

The server will be available at:
- HTTP API: http://localhost:3001
- WebSocket: ws://localhost:3002

## Scripts

- `npm run dev` - Start development server with nodemon
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Start production server
- `npm test` - Run tests
- `npm run watch` - Watch mode for TypeScript compilation

## API Endpoints

### Authentication
- `POST /api/listener-login` - Login as listener
- `GET /api/spotify/login` - Initiate Spotify OAuth
- `GET /api/spotify/callback` - Spotify OAuth callback

### Sessions
- `GET /api/session/:sessionId` - Get session info
- `POST /api/session` - Create new session

### Spotify
- `GET /api/spotify/search` - Search Spotify tracks
- `GET /api/spotify/me` - Get user profile

## Deployment

Deploy to any Node.js hosting platform:
- Railway
- Render
- Heroku
- AWS
- Digital Ocean

**Important**: Ensure your hosting provider supports WebSockets.

## License

ISC


