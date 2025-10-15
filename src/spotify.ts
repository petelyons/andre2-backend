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
        // Optionally, create a session entry for this sessionId
        // The sessions map must be managed in the main app
        // We'll pass sessionId back to the main app for session management
        sessions.set(sessionId, { ws: null, userId: null, state: {} });
        const authorizeURL = spotifyDelegate.createAuthorizeURL(scopes, sessionId);
        res.redirect(authorizeURL);
    });

    // /api/spotify/callback
    spotifyRouter.get('/callback', (req: Request, res: Response) => {
        const code = req.query.code as string;
        const sessionId = req.query.state as string;
        if (!code || !sessionId) {
            res.status(400).json({ error: 'Missing code or state (sessionId) from Spotify callback' });
            return;
        }
        spotifyDelegate.authorizationCodeGrant(code)
            .then((data: any) => {
                const session = sessions.get(sessionId);
                if (session) {
                    session.state.spotify = {
                        access_token: data.body['access_token'],
                        refresh_token: data.body['refresh_token'],
                        expires_in: data.body['expires_in'],
                    };
                    spotifyDelegate.setAccessToken(data.body['access_token']);
                    // Fetch user profile
                    return spotifyDelegate.getMe().then((profile: any) => {
                        session.userId = profile.body.id;
                        session.state.spotify.name = profile.body.display_name;
                        session.state.spotify.email = profile.body.email;
                        sessions.set(sessionId, session);
                        res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/?sessionId=${sessionId}`);
                    });
                } else {
                    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/?sessionId=${sessionId}`);
                }
            })
            .catch((err: Error) => {
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