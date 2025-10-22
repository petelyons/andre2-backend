import { Request, Response, Router } from 'express';
import SpotifyWebApi from 'spotify-web-api-node';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import logger from './logger';
dotenv.config();

class SpotifyApiDelegate {
    private spotifyApi: SpotifyWebApi;
    constructor() {
        this.spotifyApi = new SpotifyWebApi({
            clientId: process.env.SPOTIFY_CLIENT_ID,
            clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
            redirectUri: process.env.SPOTIFY_REDIRECT_URI,
        });
    }

    setAccessToken(token: string) {
        this.spotifyApi.setAccessToken(token);
    }

    async getMe() {
        return this.spotifyApi.getMe();
    }

    createAuthorizeURL(scopes: string[], state: string) {
        return this.spotifyApi.createAuthorizeURL(scopes, state);
    }

    async authorizationCodeGrant(code: string) {
        return this.spotifyApi.authorizationCodeGrant(code);
    }

    async getTrack(token: string, trackId: string) {
        this.spotifyApi.setAccessToken(token);
        return this.spotifyApi.getTrack(trackId);
    }

    async play(token: string, options: any) {
        this.spotifyApi.setAccessToken(token);
        return this.spotifyApi.play(options);
    }

    async getMyCurrentPlaybackState(token: string) {
        this.spotifyApi.setAccessToken(token);
        return this.spotifyApi.getMyCurrentPlaybackState();
    }

    async refreshAccessToken(refreshToken: string) {
        this.spotifyApi.setRefreshToken(refreshToken);
        const data = await this.spotifyApi.refreshAccessToken();
        return data.body;
    }

    async pause(token: string) {
        this.spotifyApi.setAccessToken(token);
        return this.spotifyApi.pause();
    }

    async getRandomLikedTracks(token: string, count: number = 10) {
        this.spotifyApi.setAccessToken(token);
        // Fetch up to 50 liked tracks (Spotify API max per request)
        const data = await this.spotifyApi.getMySavedTracks({ limit: 50 });
        const items = data.body.items || [];
        // Shuffle and pick random tracks
        const shuffled = items.sort(() => 0.5 - Math.random());
        const selected = shuffled.slice(0, count);
        return selected.map(item => {
            const track = item.track;
            return {
                trackId: track.id,
                spotifyUri: track.uri,
                name: track.name,
                artist: track.artists.map((a: any) => a.name).join(', '),
                album: track.album.name,
                albumArtUrl: track.album.images?.[0]?.url || null
            };
        });
    }

    async getPlaylistTracks(token: string, playlistId: string) {
        this.spotifyApi.setAccessToken(token);
        const tracks: any[] = [];
        let offset = 0;
        const limit = 100;
        
        // Fetch all tracks from the playlist (handles pagination)
        while (true) {
            const data = await this.spotifyApi.getPlaylistTracks(playlistId, { offset, limit });
            const items = data.body.items || [];
            
            for (const item of items) {
                if (item.track && item.track.type === 'track') {
                    tracks.push({
                        trackId: item.track.id,
                        spotifyUri: item.track.uri,
                        name: item.track.name,
                        artist: item.track.artists.map((a: any) => a.name).join(', '),
                        album: item.track.album.name,
                        albumArtUrl: item.track.album.images?.[0]?.url || null
                    });
                }
            }
            
            if (items.length < limit) break;
            offset += limit;
        }
        
        return tracks;
    }

    async getPlaylistInfo(token: string, playlistId: string) {
        this.spotifyApi.setAccessToken(token);
        const data = await this.spotifyApi.getPlaylist(playlistId);
        return {
            id: data.body.id,
            name: data.body.name,
            description: data.body.description,
            owner: data.body.owner.display_name,
            trackCount: data.body.tracks.total,
            imageUrl: data.body.images?.[0]?.url || null
        };
    }

    extractPlaylistId(url: string): string | null {
        // Match Spotify playlist URL patterns:
        // https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
        // spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
        const patterns = [
            /spotify\.com\/playlist\/([a-zA-Z0-9]+)/,
            /spotify:playlist:([a-zA-Z0-9]+)/
        ];
        
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match && match[1]) {
                return match[1];
            }
        }
        
        return null;
    }
}

const spotifyDelegate = new SpotifyApiDelegate();

function createSpotifyRouter(sessions: Map<string, any>) {
    const spotifyRouter = Router();

    // /api/spotify/me
    spotifyRouter.get('/me', (req: Request, res: Response): void => {
        const accessToken = req.headers['spotify-access-token'] as string;
        if (!accessToken) {
            res.status(401).json({ error: 'Missing Spotify access token' });
            return;
        }
        spotifyDelegate.setAccessToken(accessToken);
        spotifyDelegate.getMe()
            .then((data: any) => {
                res.json(data.body);
            })
            .catch((err: Error) => {
                res.status(400).json({ error: 'Failed to fetch Spotify profile', details: err.message });
            });
    });

    // /api/spotify/login
    spotifyRouter.get('/login', (req: Request, res: Response) => {
        logger.info('=== SPOTIFY LOGIN INITIATED ===');
        const scopes = [
            'user-read-private',
            'user-read-email',
            'user-read-playback-state',
            'user-modify-playback-state',
            'playlist-read-private',
            'user-library-read',
            'user-library-modify',
        ];
        // Generate a sessionId and use it as the state parameter
        const sessionId = uuidv4();
        logger.info(`Created session for Spotify login:`, { sessionId });
        // Optionally, create a session entry for this sessionId
        // The sessions map must be managed in the main app
        // We'll pass sessionId back to the main app for session management
        sessions.set(sessionId, { ws: null, userId: null, state: {} });
        const authorizeURL = spotifyDelegate.createAuthorizeURL(scopes, sessionId);
        logger.info(`Redirecting to Spotify with URL:`, { authorizeURL });
        res.redirect(authorizeURL);
    });

    // /api/spotify/callback
    spotifyRouter.get('/callback', (req: Request, res: Response) => {
        logger.info('=== SPOTIFY CALLBACK RECEIVED ===', {
            query: req.query,
            hasCode: !!req.query.code,
            hasState: !!req.query.state,
        });
        
        const code = req.query.code as string;
        const sessionId = req.query.state as string;
        
        if (!code || !sessionId) {
            logger.error('Missing code or sessionId in callback', { code: !!code, sessionId: !!sessionId });
            res.status(400).json({ error: 'Missing code or state (sessionId) from Spotify callback' });
            return;
        }
        
        logger.info('Exchanging code for tokens...', { sessionId });
        
        spotifyDelegate.authorizationCodeGrant(code)
            .then((data: any) => {
                logger.info('Received tokens from Spotify', {
                    sessionId,
                    hasAccessToken: !!data.body['access_token'],
                    hasRefreshToken: !!data.body['refresh_token'],
                    expiresIn: data.body['expires_in'],
                });
                
                const session = sessions.get(sessionId);
                logger.info('Session lookup result:', {
                    sessionId,
                    sessionExists: !!session,
                    totalSessions: sessions.size,
                });
                
                if (session) {
                    session.state.spotify = {
                        access_token: data.body['access_token'],
                        refresh_token: data.body['refresh_token'],
                        expires_in: data.body['expires_in'],
                    };
                    spotifyDelegate.setAccessToken(data.body['access_token']);
                    
                    logger.info('Fetching Spotify user profile...', { sessionId });
                    
                    // Fetch user profile
                    return spotifyDelegate.getMe().then((profile: any) => {
                        logger.info('Spotify profile fetched', {
                            sessionId,
                            userId: profile.body.id,
                            displayName: profile.body.display_name,
                            email: profile.body.email,
                        });
                        
                        session.userId = profile.body.id;
                        session.state.spotify.name = profile.body.display_name;
                        session.state.spotify.email = profile.body.email;
                        sessions.set(sessionId, session);
                        
                        logger.info('Session updated successfully', {
                            sessionId,
                            userId: session.userId,
                            hasSpotifyState: !!session.state.spotify,
                            spotifyEmail: session.state.spotify.email,
                            spotifyName: session.state.spotify.name,
                        });
                        
                        // Verify session was stored
                        const storedSession = sessions.get(sessionId);
                        logger.info('Verification: Session stored check', {
                            sessionId,
                            stored: !!storedSession,
                            hasSpotifyInStored: !!storedSession?.state?.spotify,
                        });
                        
                        const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/?sessionId=${sessionId}`;
                        logger.info('Redirecting to frontend', { redirectUrl, sessionId });
                        res.redirect(redirectUrl);
                    });
                } else {
                    logger.error('Session not found!', {
                        sessionId,
                        availableSessions: Array.from(sessions.keys()),
                    });
                    const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/?sessionId=${sessionId}&error=session_not_found`;
                    logger.warn('Redirecting to frontend with error', { redirectUrl });
                    res.redirect(redirectUrl);
                }
            })
            .catch((err: Error) => {
                logger.error('Spotify token exchange failed', {
                    sessionId,
                    error: err.message,
                    stack: err.stack,
                });
                res.status(400).json({ error: 'Failed to get tokens from Spotify', details: err.message });
            });
    });

    return spotifyRouter;
}

// Helper to get track info by ID
async function getSpotifyTrackInfo(accessToken: string, trackId: string) {
    const data = await spotifyDelegate.getTrack(accessToken, trackId);
    const track = data.body;
    return {
        trackId: track.id,
        name: track.name,
        artist: track.artists.map((a: any) => a.name).join(', '),
        album: track.album.name,
        albumArtUrl: track.album.images?.[0]?.url || null
    };
}

export { spotifyDelegate, createSpotifyRouter, getSpotifyTrackInfo }; 