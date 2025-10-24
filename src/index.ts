import express, { Request, Response, RequestHandler, NextFunction } from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import logger from './logger';
import { createSpotifyRouter, getSpotifyTrackInfo, spotifyDelegate } from './spotify';
import { QueueManager, SubmittedTrack } from './queueManager';
import fs from 'fs';
import path from 'path';
import http from 'http';
// Import types if available
// import { SpotifyApi } from 'spotify-web-api-node';

// Temporary module declaration for spotify-web-api-node if types are missing
// Remove this if @types/spotify-web-api-node is available
// @ts-ignore
// declare module 'spotify-web-api-node';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

var webSocketServerStarted: boolean = false;

// Types
interface Session {
    ws: WebSocket | null;
    userId: string | null;
    state: Record<string, any>;
    lastHeartbeat: number;
}

interface HistoryEvent {
    type: 'track_added' | 'jam' | 'unjam' | 'airhorn' | 'fallback_play' | 'track_play' | 'user_connected' | 'user_disconnected' | 'message' | 'track_skip';
    timestamp: number;
    userName: string;
    userEmail: string;
    details: any;
}

interface PlayHistoryEntry {
    timestamp: number;
    track: any;
    startedBy?: string;
}

// Message interfaces for each type
interface LoginMessage {
    type: 'login';
    userId: string;
}

interface GenericMessage {
    type: 'message';
    message: string;
}

interface PlayTrackMessage {
    type: 'play_track';
    trackId: string;
}

interface GetTracksMessage {
    type: 'get_tracks';
}

interface JamMessage {
    type: 'jam';
    spotifyUri: string;
    sessionId: string;
    unjam?: boolean; // true for shift-click to unjam
}

interface PlayMessage {
    type: 'master_play';
}

interface PauseMessage {
    type: 'master_pause';
}

interface SessionPlayMessage {
    type: 'session_play';
    sessionId: string;
}

interface SessionPauseMessage {
    type: 'session_pause';
    sessionId: string;
}

interface GetSessionsMessage {
    type: 'get_sessions';
}

interface RemoveTrackMessage {
    type: 'remove_track';
    spotifyUri: string;
    sessionId: string;
}

interface DelayTrackMessage {
    type: 'delay_track';
    spotifyUri: string;
    sessionId: string;
}

interface AirhornMessage {
    type: 'airhorn';
    airhorn: string;
}

interface GetPlayHistoryMessage {
    type: 'get_play_history';
}

interface MasterSkipMessage {
    type: 'master_skip';
    sessionId: string;
}

interface StartFallbackMessage {
    type: 'start_fallback';
    sessionId: string;
}

interface TakeMasterControlMessage {
    type: 'take_master_control';
    sessionId: string;
}

interface HistoryMessageMessage {
    type: 'history_message';
    message: string;
    sessionId: string;
}

interface PingMessage {
    type: 'ping';
    sessionId: string;
}

// Union type for all messages
type Message = LoginMessage | GenericMessage | PlayTrackMessage | GetTracksMessage | JamMessage | PlayMessage | PauseMessage | SessionPlayMessage | SessionPauseMessage | GetSessionsMessage | RemoveTrackMessage | DelayTrackMessage | AirhornMessage | GetPlayHistoryMessage | MasterSkipMessage | StartFallbackMessage | TakeMasterControlMessage | HistoryMessageMessage | PingMessage;

// Middleware
// CORS configuration - must be before other middleware
app.use((req: Request, res: Response, next: NextFunction) => {
    // Log all incoming requests
    logger.info(`[CORS] ${req.method} ${req.path}`, {
        origin: req.headers.origin,
        referer: req.headers.referer,
        userAgent: req.headers['user-agent'],
        contentType: req.headers['content-type'],
    });
    
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.header('Access-Control-Allow-Headers', '*');
    res.header('Access-Control-Max-Age', '86400');
    
    // Handle preflight
    if (req.method === 'OPTIONS') {
        logger.info(`[CORS] Preflight request handled for ${req.path}`);
        res.sendStatus(200);
        return;
    }
    next();
});

app.use(express.json());

// Store active sessions
const sessions = new Map<string, Session>();
const sessionCleanupTimers = new Map<string, NodeJS.Timeout>();

// Queue manager handles all track queuing logic
const queueManager = new QueueManager(process.env.FALLBACK_PLAYLIST_URL);

// Global playback mode state
let mode: 'master_play' | 'master_pause' = 'master_pause';

// Per-session playback mode
const sessionModes = new Map<string, 'session_play' | 'session_pause'>();

// Shared currently playing track
let currentlyPlayingTrack: SubmittedTrack | null = null;
let currentTrackIsFallback: boolean = false;
let currentTrackConsumed: boolean = false; // Track whether current track was removed from queue

// Shared master user state
let masterUserSessionId: string | null = null;
let lastMasterPlaybackState: 'play' | 'pause' | null = null;
let masterTrackStarted: boolean = false;

// Track previous playback state for robust track-end detection
let lastPlaybackState: {
    uri: string | null;
    progress_ms: number | null;
    duration_ms: number | null;
    is_playing: boolean | null;
} | null = null;

// Track when we last commanded a track change (to allow grace period)
let lastTrackChangeCommand: number = 0;
const TRACK_CHANGE_GRACE_PERIOD_MS = 3000; // 3 seconds for Spotify to respond
// Additional guard to suppress end detection right after manual skip
let lastManualSkipAt: number = 0;

// Playback failure tracking
let playbackFailureCheckTime: number = 0;
let expectedPlayingUri: string | null = null;
const PLAYBACK_FAILURE_TIMEOUT_MS = 5000; // 5 seconds to detect playback failure

// Event history
const history: HistoryEvent[] = [];

// Play history
const playHistory: PlayHistoryEntry[] = [];

// Spotify API setup
// const spotifyApi = new SpotifyWebApi({
//     clientId: process.env.SPOTIFY_CLIENT_ID,
//     clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
//     redirectUri: process.env.SPOTIFY_REDIRECT_URI,
// });

// JSON persistence for submittedTracks, sessions, and history
// Use DATA_DIR environment variable if set, otherwise use __dirname for local development
const DATA_DIR = process.env.DATA_DIR || __dirname;
const TRACKS_FILE = path.join(DATA_DIR, 'tracks.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const MAX_HISTORY_EVENTS = 500;
function saveTracksToFile() {
    try {
        fs.writeFileSync(TRACKS_FILE, JSON.stringify(queueManager.getSubmittedTracks(), null, 2));
    } catch (err) {
        logger.error('Failed to save tracks to file:', err);
    }
}

function saveHistoryToFile() {
    try {
        // Keep only the last MAX_HISTORY_EVENTS
        const historyToSave = history.slice(-MAX_HISTORY_EVENTS);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(historyToSave, null, 2));
    } catch (err) {
        logger.error('Failed to save history to file:', err);
    }
}

function loadHistoryFromFile() {
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
            const arr = JSON.parse(data);
            if (Array.isArray(arr)) {
                // Load history events, keeping only the last MAX_HISTORY_EVENTS
                history.push(...arr.slice(-MAX_HISTORY_EVENTS));
                logger.info(`Loaded ${history.length} history events from file`);
            }
        } catch (err) {
            logger.error('Failed to load history from file:', err);
        }
    }
}
async function loadTracksFromFile() {
    if (fs.existsSync(TRACKS_FILE)) {
        try {
            const data = fs.readFileSync(TRACKS_FILE, 'utf-8');
            const arr = JSON.parse(data);
            if (Array.isArray(arr)) {
                const loadedTracks: SubmittedTrack[] = [];
                let needsMigration = false;
                for (const t of arr) {
                    // Migration: convert sessionId to userEmail if needed
                    if (t.sessionId && !t.userEmail) {
                        needsMigration = true;
                        // Try to find the session to get the email
                        const session = sessions.get(t.sessionId);
                        if (session) {
                            const email = session.state?.spotify?.email || session.state?.listener?.email;
                            if (email) {
                                t.userEmail = email;
                                delete t.sessionId;
                            } else {
                                // If we can't find the email, use a placeholder
                                t.userEmail = 'unknown@migration.com';
                                delete t.sessionId;
                            }
                        } else {
                            // Session not found, use placeholder
                            t.userEmail = 'unknown@migration.com';
                            delete t.sessionId;
                        }
                    }
                    
                    // Migration: fetch missing album art
                    if (t.spotifyUri && !t.albumArtUrl && t.name && t.artist) {
                        needsMigration = true;
                        logger.info(`Fetching missing album art for: ${t.name}`);
                        const masterSession = masterUserSessionId ? sessions.get(masterUserSessionId) : null;
                        const masterAccessToken = masterSession?.state?.spotify?.access_token;
                        if (masterAccessToken) {
                            try {
                                const match = t.spotifyUri.match(/spotify:track:([a-zA-Z0-9]+)/);
                                const trackId = match ? match[1] : t.spotifyUri;
                                const trackInfo = await getSpotifyTrackInfo(masterAccessToken, trackId);
                                if (trackInfo.albumArtUrl) {
                                    t.albumArtUrl = trackInfo.albumArtUrl;
                                    logger.info(`✓ Added album art for: ${t.name}`);
                                }
                            } catch (err) {
                                logger.warn(`Failed to fetch album art for ${t.name}:`, err);
                            }
                        }
                    }
                    
                    loadedTracks.push(t);
                }
                queueManager.setSubmittedTracks(loadedTracks);
                // Save the migrated tracks back to file
                if (needsMigration) {
                    saveTracksToFile();
                    logger.info('Migrated tracks: updated userEmail and album art');
                }
            }
        } catch (err) {
            logger.error('Failed to load tracks from file:', err);
        }
    }
}

// Helper to build track list with fallback tracks when needed
function getDisplayTrackList() {
    const submittedTracks = queueManager.getSubmittedTracks();
    const fallbackInfo = queueManager.getFallbackInfo();
    
    // Start with user-submitted tracks (marked as not fallback)
    const trackList = submittedTracks.map(t => ({
        spotifyUri: t.spotifyUri,
        userEmail: t.userEmail,
        spotifyName: t.spotifyName,
        name: t.name,
        artist: t.artist,
        album: t.album,
        albumArtUrl: t.albumArtUrl,
        jammers: t.jammers || [],
        isFallback: false
    }));
    
    // If we have fewer than 10 user tracks, add fallback tracks to reach 10
    if (submittedTracks.length < 10 && fallbackInfo) {
        const fallbackTracks = queueManager.getFallbackTracks();
        const neededFallbackCount = Math.min(10 - submittedTracks.length, fallbackTracks.length);
        
        for (let i = 0; i < neededFallbackCount; i++) {
            const fallbackTrack = fallbackTracks[i];
            trackList.push({
                spotifyUri: fallbackTrack.spotifyUri,
                userEmail: '',
                spotifyName: fallbackInfo.name || 'Fallback Playlist',
                name: fallbackTrack.name,
                artist: fallbackTrack.artist,
                album: fallbackTrack.album,
                albumArtUrl: fallbackTrack.albumArtUrl,
                jammers: fallbackTrack.jammers || [],
                isFallback: true
            });
        }
    }
    
    return trackList;
}

// Helper to broadcast the full track list to all connected clients
function broadcastTrackList() {
    const trackList = getDisplayTrackList();
    
    logger.info('=== BROADCASTING TRACK LIST ===', {
        userTracks: queueManager.getSubmittedCount(),
        fallbackTracksAdded: trackList.length - queueManager.getSubmittedCount(),
        totalTracks: trackList.length,
        totalSessions: sessions.size,
    });
    
    let broadcastCount = 0;
    for (const [sessionId, session] of sessions.entries()) {
        if (!session.ws || session.ws.readyState !== 1) { // 1 = OPEN
            logger.info(`Skipping broadcast to session ${sessionId} (WebSocket not open, state: ${session.ws?.readyState})`);
            // Do NOT remove closed sessions here; let the cleanup timer handle it
            continue;
        }
        logger.info(`Broadcasting tracks to session: ${sessionId}`);
        session.ws && session.ws.send(JSON.stringify({ type: 'tracks_list', tracks: trackList }));
        broadcastCount++;
    }
    
    logger.info(`Broadcast complete: sent to ${broadcastCount} sessions`);
}

function broadcastMode() {
    for (const [sessionId, session] of sessions.entries()) {
        if (!session.ws || session.ws.readyState !== 1) continue;
        const userEmail = session.state?.spotify?.email || session.state?.listener?.email;
        const canTakeControl = canTakeMasterControl(userEmail);
        session.ws && session.ws.send(JSON.stringify({
            type: 'mode',
            mode,
            currentlyPlayingTrack,
            masterUserSessionId,
            canTakeMasterControl: canTakeControl,
            fallbackPlaylist: queueManager.getFallbackInfo(),
        }));
    }
}

function sendSessionMode(sessionId: string) {
    const session = sessions.get(sessionId);
    if (session && session.ws && session.ws.readyState === 1) {
        session.ws && session.ws.send(JSON.stringify({ type: 'session_mode', sessionMode: sessionModes.get(sessionId) || 'session_pause' }));
    }
}

// Helper to broadcast the list of connected sessions
function broadcastSessionList() {
    // Create a map to deduplicate by email, keeping the most recent session
    const emailToSession = new Map<string, { sessionId: string; userId: string | null; name: string; email: string; isMaster: boolean }>();
    
    for (const [sessionId, session] of sessions.entries()) {
        const spotifyName = session.state?.spotify?.name || '';
        const spotifyEmail = session.state?.spotify?.email;
        const listenerName = session.state?.listener?.name;
        const listenerEmail = session.state?.listener?.email;
        
        let name = '';
        let email = '';
        
        if (spotifyName && spotifyEmail) {
            name = spotifyName;
            email = spotifyEmail;
        } else if (listenerName && listenerEmail) {
            name = listenerName;
            email = listenerEmail;
        } else {
            // Invalid session, skip
            continue;
        }
        
        // If we already have a session for this email, only replace if this session is newer
        // (we'll use sessionId as a proxy for recency since newer sessions have newer UUIDs)
        if (!emailToSession.has(email) || sessionId > emailToSession.get(email)!.sessionId) {
            emailToSession.set(email, {
                sessionId,
                userId: session.userId,
                name,
                email,
                isMaster: sessionId === masterUserSessionId
            });
        }
    }
    
    const sessionList = Array.from(emailToSession.values());
    
    for (const [sessionId, session] of sessions.entries()) {
        if (!session.ws || session.ws.readyState !== 1) continue;
        session.ws && session.ws.send(JSON.stringify({ type: 'sessions_list', sessions: sessionList }));
    }
}

// Helper to assign master user if not set
async function assignMasterUserIfNeeded() {
    if (!masterUserSessionId) {
        for (const [sessionId, session] of sessions.entries()) {
            if (session.state?.spotify?.access_token) {
                masterUserSessionId = sessionId;
                logger.info(`Assigned master user: ${sessionId}`);
                // Fetch current playback state and set currentlyPlayingTrack if a track is playing
                try {
                    const playback = await spotifyDelegate.getMyCurrentPlaybackState(session.state.spotify.access_token);
                    const item = playback.body?.item;
                    if (item && item.type === 'track') {
                        // Fetch full track info
                        const trackInfo = await getSpotifyTrackInfo(session.state.spotify.access_token, item.id);
                        currentlyPlayingTrack = {
                            spotifyUri: item.uri,
                            userEmail: session.state.spotify.email || '',
                            spotifyName: session.state.spotify.name || '',
                            timestamp: Date.now(),
                            name: trackInfo.name,
                            artist: trackInfo.artist,
                            album: trackInfo.album,
                            albumArtUrl: trackInfo.albumArtUrl === null ? undefined : trackInfo.albumArtUrl,
                            jammers: [],
                            progress: playback.body.progress_ms && item.duration_ms ? {
                                position_ms: playback.body.progress_ms,
                                duration_ms: item.duration_ms
                            } : null
                        };
                        logger.info(`Set currentlyPlayingTrack from master user's current playback: ${trackInfo.name} by ${trackInfo.artist}`);
                        // Set play mode based on detected playback state
                        if (typeof playback.body.is_playing === 'boolean') {
                            mode = playback.body.is_playing ? 'master_play' : 'master_pause';
                            logger.info(`Set play mode to ${mode} based on detected master playback state`);
                            broadcastMode();
                            if (mode === 'master_play') {
                                startPolling();
                            }
                        }
                    }
                } catch (err) {
                    logger.warn('Could not fetch master user playback state on assignment:', err);
                }
                
                // Load fallback playlist if not already loaded
                if (queueManager.getFallbackPlaylistUrl() && queueManager.getFallbackCount() === 0) {
                    logger.info('Master user assigned, loading fallback playlist');
                    const accessToken = session.state.spotify.access_token;
                    await queueManager.loadFallbackPlaylist(queueManager.getFallbackPlaylistUrl(), accessToken);
                }
                
                break;
            }
        }
    }
}

// Update notifyMasterToActivateDevice to notify any session by sessionId
function notifyUserToActivateDevice(sessionId: string) {
    const session = sessions.get(sessionId);
    if (session && session.ws && session.ws.readyState === 1) {
        session.ws.send(JSON.stringify({
            type: 'prominent_message',
            message: 'Spotify needs to be activated. Please hit play on your Spotify client to activate your device.'
        }));
    }
}

// Debug mode flag
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
function isDebug() { return DEBUG; }

// Master control backdoor - comma-separated list of emails
const MASTER_CONTROL_EMAILS = process.env.MASTER_CONTROL_EMAILS 
    ? process.env.MASTER_CONTROL_EMAILS.split(',').map(e => e.trim().toLowerCase())
    : [];

function canTakeMasterControl(email: string | undefined): boolean {
    if (!email) return false;
    return MASTER_CONTROL_EMAILS.includes(email.toLowerCase());
}

// Helper to initiate playback failure tracking
function startPlaybackFailureTracking(uri: string) {
    expectedPlayingUri = uri;
    playbackFailureCheckTime = Date.now();
    logger.info(`Started playback failure tracking for ${uri}`);
}

// Helper to record a fallback play history event and broadcast
function recordFallbackPlay(track: SubmittedTrack) {
    history.push({
        type: 'fallback_play',
        timestamp: Date.now(),
        userName: 'System',
        userEmail: 'fallback@system',
        details: {
            track: track.name || track.spotifyUri,
            playlist: track.spotifyName || 'Fallback Playlist'
        }
    });
    broadcastHistory();
}

// Helper to play a track for sessions
async function playTrackForSessions(track: SubmittedTrack, onlySessionPlay: boolean) {
    for (const [sid, sess] of sessions.entries()) {
        if (onlySessionPlay) {
            const sessionMode = sessionModes.get(sid);
            if (sessionMode !== 'session_play') continue;
        }
        const accessToken = sess.state?.spotify?.access_token;
        if (accessToken) {
            try {
                await spotifyDelegate.play(accessToken, { uris: [track.spotifyUri] });
                logger.info(`Started playback for session ${sid}${onlySessionPlay ? ' (session_play mode)' : ''}`);
            } catch (err) {
                logger.error(`Failed to start playback for session ${sid}:`, err);
                const errMsg = getErrorMessage(err);
                if (errMsg.includes('NO_ACTIVE_DEVICE') || errMsg.includes('No active device found')) {
                    notifyUserToActivateDevice(sid);
                }
            }
        }
    }
}

// Helper to set current track, record/history/log, start failure tracking, play, and broadcast
// NOTE: Track should be peeked but NOT consumed yet - consumption happens after playback confirmation
async function setCurrentTrackAndStart(newTrack: SubmittedTrack, isFallback: boolean, onlySessionPlay: boolean) {
    currentlyPlayingTrack = newTrack;
    currentTrackIsFallback = isFallback;
    currentTrackConsumed = false; // Mark as not yet consumed
    
    if (isFallback) {
        logger.info(`Playing from fallback: ${newTrack.name || newTrack.spotifyUri} (not consumed from queue yet)`);
        recordFallbackPlay(newTrack);
    } else {
        logger.info(`Now playing: ${newTrack.name || newTrack.spotifyUri} (not consumed from queue yet)`);
        // Don't save tracks yet - track still in queue until playback confirmed
    }
    masterTrackStarted = false;
    lastTrackChangeCommand = Date.now();
    startPlaybackFailureTracking(newTrack.spotifyUri);
    await playTrackForSessions(newTrack, onlySessionPlay);
    broadcastTrackList();
    broadcastMode();
}

// Poll master user's playback state
async function pollMasterUserPlayback() {
    if (!masterUserSessionId) return;
    const masterSession = sessions.get(masterUserSessionId);
    if (!masterSession || !masterSession.state?.spotify?.access_token) return;
    try {
        const playback = await spotifyDelegate.getMyCurrentPlaybackState(masterSession.state.spotify.access_token);
        if (isDebug()) {
            logger.info('Spotify playback state: ' + JSON.stringify({
                is_playing: playback.body?.is_playing,
                item_uri: playback.body?.item?.uri,
                progress_ms: playback.body?.progress_ms,
                duration_ms: playback.body?.item?.duration_ms,
                item_name: playback.body?.item?.name,
                item_id: playback.body?.item?.id,
            }));
        }

        // Track-end detection: compare with previous state
        const prev = lastPlaybackState;
        const curr = {
            uri: playback.body?.item?.uri || null,
            progress_ms: typeof playback.body?.progress_ms === 'number' ? playback.body.progress_ms : null,
            duration_ms: typeof playback.body?.item?.duration_ms === 'number' ? playback.body.item.duration_ms : null,
            is_playing: typeof playback.body?.is_playing === 'boolean' ? playback.body.is_playing : null,
        };
        lastPlaybackState = curr;

        // Check for playback failure
        if (expectedPlayingUri && playbackFailureCheckTime > 0) {
            const timeSinceCommand = Date.now() - playbackFailureCheckTime;
            
            if (timeSinceCommand > PLAYBACK_FAILURE_TIMEOUT_MS) {
                // Check if the expected track is playing
                if (curr.uri !== expectedPlayingUri || !curr.is_playing) {
                    logger.error(`Playback failure detected: Expected ${expectedPlayingUri} to be playing, but current state is: ${JSON.stringify(curr)}`);
                    
                    // Broadcast error to all clients
                    for (const [sid, sess] of sessions.entries()) {
                        if (sess.ws && sess.ws.readyState === 1) {
                            sess.ws.send(JSON.stringify({
                                type: 'playback_error',
                                message: 'Playback failed to start. The track may be unavailable or restricted in your region.',
                                track: currentlyPlayingTrack
                            }));
                        }
                    }
                    
                    // Clear the current track and reset state
                    currentlyPlayingTrack = null;
                    expectedPlayingUri = null;
                    playbackFailureCheckTime = 0;
                    broadcastTrackList();
                    
                    // Try to play next track
                    const masterAccessToken = masterSession?.state?.spotify?.access_token;
                    const nextTrackInfo = await queueManager.peekNextTrack(masterAccessToken);
                    
                    if (nextTrackInfo) {
                        const newTrack = nextTrackInfo.track;
                        currentlyPlayingTrack = newTrack;
                        expectedPlayingUri = newTrack.spotifyUri;
                        playbackFailureCheckTime = Date.now();
                        
                        if (!nextTrackInfo.isFallback) {
                            saveTracksToFile();
                            logger.info(`Attempting next track after failure: ${newTrack.name || newTrack.spotifyUri}`);
                        } else {
                            logger.info(`Attempting fallback track after failure: ${newTrack.name || newTrack.spotifyUri}`);
                        }
                        
                        // Try to play on all sessions
                        for (const [sid, sess] of sessions.entries()) {
                            const accessToken = sess.state?.spotify?.access_token;
                            if (accessToken) {
                                try {
                                    await spotifyDelegate.play(accessToken, { uris: [newTrack.spotifyUri] });
                                    logger.info(`Started next track on session ${sid} after failure`);
                                } catch (err) {
                                    logger.error(`Failed to start next track on session ${sid}:`, err);
                                }
                            }
                        }
                        
                        broadcastTrackList();
                    }
                } else {
                    // Playback started successfully, clear failure detection
                    logger.info(`Playback confirmed: ${curr.uri} is playing`);
                    expectedPlayingUri = null;
                    playbackFailureCheckTime = 0;
                }
            }
        }

        let detectedTrackEnd = false;
        // Detect progress_ms reset to 0 after being near the end
        if (
            prev &&
            prev.uri && curr.uri && prev.uri === curr.uri &&
            prev.progress_ms !== null && curr.progress_ms === 0 &&
            prev.duration_ms && prev.progress_ms > 0.9 * prev.duration_ms
        ) {
            logger.info('Detected track end by progress_ms reset to 0');
            detectedTrackEnd = true;
        }
        // Detect track URI change
        if (
            prev && prev.uri && curr.uri && prev.uri !== curr.uri && prev.progress_ms !== null && prev.duration_ms && prev.progress_ms > 0.9 * prev.duration_ms
        ) {
            logger.info(`Detected track change from ${prev.uri} to ${curr.uri}`);
            detectedTrackEnd = true;
        }
        // If detected, advance to next track
        if (detectedTrackEnd) {
            // Suppress auto-advance if we just manually skipped within grace window
            if (lastManualSkipAt && (Date.now() - lastManualSkipAt) < TRACK_CHANGE_GRACE_PERIOD_MS) {
                logger.info('Detected end right after manual skip - suppressing auto-advance');
                lastManualSkipAt = 0;
            } else {
                logger.info('Advancing to next track due to detected end.');
                
                // Before changing currentlyPlayingTrack, push to playHistory
                if (currentlyPlayingTrack) {
                    playHistory.push({
                        timestamp: Date.now(),
                        track: { ...currentlyPlayingTrack },
                        startedBy: masterUserSessionId ? (sessions.get(masterUserSessionId)?.state?.spotify?.name || sessions.get(masterUserSessionId)?.state?.listener?.name || '') : undefined
                    });
                    broadcastPlayHistory();
                }
                
                // Get master user's access token for fallback playlist loading
                const masterAccessToken = masterSession?.state?.spotify?.access_token;
                const nextTrackInfo = await queueManager.peekNextTrack(masterAccessToken);
                
                if (nextTrackInfo) {
                    const newTrack = nextTrackInfo.track;
                    await setCurrentTrackAndStart(newTrack, nextTrackInfo.isFallback, true);
                } else {
                    currentlyPlayingTrack = null;
                    masterTrackStarted = false;
                    currentTrackConsumed = true; // No track to consume
                    if (mode !== 'master_pause') {
                        mode = 'master_pause';
                        logger.info('No more tracks in queue and no fallback playlist, stopping playback');
                        broadcastTrackList();
                        broadcastMode();
                    }
                }
                return; // Skip the rest of the function for this poll
            }
        }
        
        if (mode === 'master_pause' as typeof mode) {
            // Only update progress info, do not check for track end
            if (currentlyPlayingTrack && curr.progress_ms !== null && curr.duration_ms !== null) {
                currentlyPlayingTrack.progress = {
                    position_ms: curr.progress_ms,
                    duration_ms: curr.duration_ms
                };
            } else if (currentlyPlayingTrack) {
                currentlyPlayingTrack.progress = null;
            }
            broadcastMode();
            return;
        }
        
        if (curr.is_playing !== null && curr.is_playing !== undefined) {
            const newState = curr.is_playing ? 'play' : 'pause';
            
            // Check if master is playing the correct track
            // BUT: Don't correct if the track they're playing is in our queue (natural transition case)
            // AND: Don't correct if we just commanded a track change (grace period for Spotify to respond)
            if (currentlyPlayingTrack && curr.uri) {
                const masterTrackUri = curr.uri;
                const isTrackInQueue = queueManager.getSubmittedTracks().some(t => t.spotifyUri === masterTrackUri);
                const timeSinceLastCommand = Date.now() - lastTrackChangeCommand;
                const inGracePeriod = timeSinceLastCommand < TRACK_CHANGE_GRACE_PERIOD_MS;
                
                if (masterTrackUri !== currentlyPlayingTrack.spotifyUri) {
                    if (inGracePeriod) {
                        // We just commanded a track change, give Spotify time to respond
                        logger.info(`Track mismatch but within grace period (${timeSinceLastCommand}ms), waiting for Spotify to catch up...`);
                    } else if (isTrackInQueue) {
                        // Check if this is right after a manual skip
                        const timeSinceManualSkip = lastManualSkipAt ? Date.now() - lastManualSkipAt : Infinity;
                        const justManuallySkipped = timeSinceManualSkip < TRACK_CHANGE_GRACE_PERIOD_MS;
                        
                        if (justManuallySkipped) {
                            // This is the result of a manual skip, don't add duplicate track_play event
                            logger.info(`Master advanced to ${masterTrackUri} after manual skip - suppressing duplicate track_play event`);
                            lastManualSkipAt = 0; // Reset the flag
                        } else {
                            // Master has naturally advanced to a track in our queue - update our state to match
                            logger.info(`Master naturally advanced to ${masterTrackUri} which is in queue. Syncing state...`);
                        }
                        
                        // Find and set as current, remove from queue (do this regardless)
                        const queueIndex = queueManager.getSubmittedTracks().findIndex(t => t.spotifyUri === masterTrackUri);
                        if (queueIndex !== -1) {
                            // Add old track to play history
                            if (currentlyPlayingTrack) {
                                playHistory.push({
                                    timestamp: Date.now(),
                                    track: { ...currentlyPlayingTrack },
                                    startedBy: masterUserSessionId ? (sessions.get(masterUserSessionId)?.state?.spotify?.name || sessions.get(masterUserSessionId)?.state?.listener?.name || '') : undefined
                                });
                            }
                            // Set new current track
                            const newTrack = queueManager.getSubmittedTracks().splice(queueIndex, 1)[0];
                            currentlyPlayingTrack = newTrack;
                            masterTrackStarted = true;
                            saveTracksToFile();
                            
                            // Add track play event to history ONLY if NOT after manual skip
                            // Only add if track has actual details (name, artist, etc.) and not manually skipped
                            if (!justManuallySkipped && newTrack.name && newTrack.artist) {
                                const startingUserName = masterUserSessionId ? (sessions.get(masterUserSessionId)?.state?.spotify?.name || sessions.get(masterUserSessionId)?.state?.listener?.name || 'Unknown') : 'Unknown';
                                const startingUserEmail = masterUserSessionId ? (sessions.get(masterUserSessionId)?.state?.spotify?.email || sessions.get(masterUserSessionId)?.state?.listener?.email || '') : '';
                                const trackPlayEvent = {
                                    type: 'track_play' as const,
                                    timestamp: Date.now(),
                                    userName: startingUserName,
                                    userEmail: startingUserEmail,
                                    details: { track: { ...newTrack } }
                                };
                                logger.info('Adding track_play to history:', JSON.stringify({
                                    name: newTrack.name,
                                    artist: newTrack.artist,
                                    album: newTrack.album,
                                    hasAlbumArt: !!newTrack.albumArtUrl,
                                    albumArtUrl: newTrack.albumArtUrl ? newTrack.albumArtUrl.substring(0, 50) + '...' : null
                                }));
                                history.push(trackPlayEvent);
                            }
                            
                            broadcastTrackList();
                            broadcastMode();
                            broadcastPlayHistory();
                            broadcastHistory();
                        }
                    } else {
                        // Master is playing something not in our queue - try to correct
                        logger.warn(`Master user is playing ${masterTrackUri} but should be playing ${currentlyPlayingTrack.spotifyUri}. Attempting to correct...`);
                        try {
                            await spotifyDelegate.play(masterSession.state.spotify.access_token, { uris: [currentlyPlayingTrack.spotifyUri] });
                            logger.info(`Successfully started correct track (${currentlyPlayingTrack.spotifyUri}) for master user.`);
                        } catch (err) {
                            logger.error(`Failed to start correct track for master user:`, err);
                            const errMsg = getErrorMessage(err);
                            if (errMsg.includes('NO_ACTIVE_DEVICE') || errMsg.includes('No active device found')) {
                                notifyUserToActivateDevice(masterUserSessionId);
                            }
                        }
                    }
                }
            }
            
            // Update currentlyPlayingTrack with progress info
            if (currentlyPlayingTrack && curr.progress_ms !== null && curr.duration_ms !== null) {
                currentlyPlayingTrack.progress = {
                    position_ms: curr.progress_ms,
                    duration_ms: curr.duration_ms
                };
            } else if (currentlyPlayingTrack) {
                currentlyPlayingTrack.progress = null;
            }
            
            // Check if track has finished playing (progress is near the end)
            if (masterTrackStarted && currentlyPlayingTrack?.progress && 
                currentlyPlayingTrack.progress.position_ms > 0 && 
                currentlyPlayingTrack.progress.duration_ms > 0) {
                const progressPercentage = currentlyPlayingTrack.progress.position_ms / currentlyPlayingTrack.progress.duration_ms;
                if (isDebug()) {
                    logger.info('Track progress check: ' + JSON.stringify({
                        position_ms: currentlyPlayingTrack.progress.position_ms,
                        duration_ms: currentlyPlayingTrack.progress.duration_ms,
                        progressPercentage,
                        masterTrackStarted,
                        currentlyPlayingTrack: currentlyPlayingTrack.spotifyUri,
                    }));
                }
                // If track is 100% complete, consider it finished
                if (progressPercentage >= 1.0) {
                    logger.info(`Track "${currentlyPlayingTrack.name}" has finished playing, moving to next track`);
                    
                    // Before changing currentlyPlayingTrack, push to playHistory
                    if (currentlyPlayingTrack) {
                        playHistory.push({
                            timestamp: Date.now(),
                            track: { ...currentlyPlayingTrack },
                            startedBy: masterUserSessionId ? (sessions.get(masterUserSessionId)?.state?.spotify?.name || sessions.get(masterUserSessionId)?.state?.listener?.name || '') : undefined
                        });
                        broadcastPlayHistory();
                    }
                    
                    // Get master user's access token for fallback playlist loading
                    const masterAccessToken = masterSession?.state?.spotify?.access_token;
                    const nextTrackInfo = await queueManager.peekNextTrack(masterAccessToken);
                    
                    if (nextTrackInfo) {
                        const newTrack = nextTrackInfo.track;
                        await setCurrentTrackAndStart(newTrack, nextTrackInfo.isFallback, true);
                    } else {
                        // No more tracks in queue and no fallback
                        currentlyPlayingTrack = null;
                        masterTrackStarted = false;
                        currentTrackConsumed = true; // No track to consume
                        if (mode !== 'master_pause') {
                            mode = 'master_pause';
                            logger.info('No more tracks in queue and no fallback playlist, stopping playback');
                            broadcastTrackList();
                            broadcastMode();
                        }
                    }
                }
            }
            
            if (newState !== lastMasterPlaybackState) {
                lastMasterPlaybackState = newState;
                if (newState === 'play' && mode !== 'master_play') {
                    mode = 'master_play';
                    logger.info('Master user is playing, setting mode to master_play');
                    // Mark that the track has started playing
                    if (currentlyPlayingTrack) {
                        masterTrackStarted = true;
                        logger.info(`Master user started playing track: ${currentlyPlayingTrack.name}`);
                        
                        // Consume track from queue now that playback is confirmed
                        if (!currentTrackConsumed) {
                            queueManager.consumeNextTrack(currentTrackIsFallback);
                            currentTrackConsumed = true;
                            if (!currentTrackIsFallback) {
                                saveTracksToFile(); // Save after consuming submitted track
                            }
                            logger.info(`✓ Track consumed from queue after playback confirmation`);
                        }
                    }
                    broadcastMode();
                } else if (newState === 'pause' && mode !== 'master_pause') {
                    // Check if we just commanded a track change (grace period)
                    const timeSinceLastCommand = Date.now() - lastTrackChangeCommand;
                    const inGracePeriod = timeSinceLastCommand < TRACK_CHANGE_GRACE_PERIOD_MS;
                    
                    if (inGracePeriod) {
                        // We just commanded a track change, this pause is temporary during transition
                        logger.info(`Pause detected but within grace period (${timeSinceLastCommand}ms), ignoring (likely track transition)`);
                        return; // Don't change to master_pause
                    }
                    
                    // Check if pause is due to track completion before changing mode
                    if (masterTrackStarted && currentlyPlayingTrack?.progress && 
                        currentlyPlayingTrack.progress.position_ms > 0 && 
                        currentlyPlayingTrack.progress.duration_ms > 0) {
                        const progressPercentage = currentlyPlayingTrack.progress.position_ms / currentlyPlayingTrack.progress.duration_ms;
                        if (progressPercentage >= 1.0) {
                            // Track completed, don't change mode, let the completion logic handle it
                            logger.info(`Track "${currentlyPlayingTrack.name}" completed and paused, advancing to next track (not setting master_pause).`);
                            return; // Skip mode change, let completion logic handle advancement
                        }
                    }
                    // Normal pause (not due to completion or track transition)
                    mode = 'master_pause';
                    logger.info('Master user is paused, setting mode to master_pause');
                    broadcastMode();
                }
            } else if (currentlyPlayingTrack?.progress) {
                // Always broadcast progress updates
                broadcastMode();
            }
        }
    } catch (err) {
        logger.error('Error polling master user playback:', err);
    }
}

// Polling interval for master playback state (ms)
const POLL_INTERVAL_MS = process.env.POLL_INTERVAL_MS ? parseInt(process.env.POLL_INTERVAL_MS, 10) : 1000;

// Instead, manage polling interval based on mode changes:
let pollInterval: NodeJS.Timeout | null = null;
function startPolling() {
    if (!pollInterval) pollInterval = setInterval(pollMasterUserPlayback, POLL_INTERVAL_MS);
}
function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

// Function to start WebSocket server with retry
function startWebSocketServer(server: http.Server): void {
    try {
        if (webSocketServerStarted) {
            logger.info('WebSocket server already started');
            return;
        }
        webSocketServerStarted = true;
        logger.info(`Starting WebSocket server on path /websocket`);

        const wss = new WebSocketServer({ 
            server,
            path: '/websocket'
        });
        logger.info(`WebSocket server started on path /websocket`);

        wss.on('connection', (ws: WebSocket) => {
            logger.info('=== NEW WEBSOCKET CONNECTION ===');
            let sessionId: string = '';
            let session: Session | null = null;

            // Wait for login message to associate session
            ws.on('message', async (data: Buffer) => {
                try {
                    const message: Message = JSON.parse(data.toString());
                    logger.info(`WebSocket message received: ${message.type}`, { sessionId: sessionId || 'none' });
                    
                    switch (message.type) {
                        case 'login':
                            sessionId = message.userId || '';
                            logger.info('=== WEBSOCKET LOGIN ATTEMPT ===', { sessionId });
                            
                            let isNewSession = false;
                            if (sessionId && sessions.has(sessionId)) {
                                session = sessions.get(sessionId)!;
                                session.ws = ws;
                                session.lastHeartbeat = Date.now(); // Update heartbeat on reconnect
                                logger.info(`Reusing existing session: ${sessionId}`, {
                                    hasSpotify: !!session.state?.spotify,
                                    hasListener: !!session.state?.listener,
                                });
                                isNewSession = false; // Reconnection, not a new session
                            } else if (sessionId) {
                                session = { ws, userId: sessionId, state: {}, lastHeartbeat: Date.now() };
                                sessions.set(sessionId, session);
                                logger.warn(`Created new empty session (should not happen): ${sessionId}`);
                                isNewSession = true;
                            }
                            // Clear any pending cleanup timer
                            if (sessionId && sessionCleanupTimers.has(sessionId)) {
                                clearTimeout(sessionCleanupTimers.get(sessionId));
                                sessionCleanupTimers.delete(sessionId);
                            }
                            if (!session) {
                                logger.warn(`Rejected null session on login: ${sessionId}`);
                                sessions.delete(sessionId);
                                ws.send(JSON.stringify({ type: 'login_error', error: 'Invalid session. Please log in again.' }));
                                ws.close();
                                break;
                            }
                            // Strict validation: must have valid Spotify or listener info
                            const spotifyName = session.state?.spotify?.name || '';
                            const spotifyEmail = session.state?.spotify?.email;
                            const listenerName = session.state?.listener?.name;
                            const listenerEmail = session.state?.listener?.email;
                            if (!(spotifyName && spotifyEmail) && !(listenerName && listenerEmail)) {
                                logger.warn(`Rejected invalid session on login: ${sessionId}`);
                                sessions.delete(sessionId);
                                ws.send(JSON.stringify({ type: 'login_error', error: 'Invalid session. Please log in again.' }));
                                ws.close();
                                break;
                            }
                            
                            // Check for and remove duplicate sessions for the same email
                            // Policy: Only one session per email address is allowed
                            const currentUserEmail = spotifyEmail || listenerEmail;
                            let masterWasTransferred = false;
                            
                            if (currentUserEmail) {
                                const duplicateSessions: string[] = [];
                                
                                for (const [existingSessionId, existingSession] of sessions.entries()) {
                                    // Skip the current session
                                    if (existingSessionId === sessionId) continue;
                                    
                                    const existingEmail = existingSession.state?.spotify?.email || existingSession.state?.listener?.email;
                                    if (existingEmail && existingEmail.toLowerCase() === currentUserEmail.toLowerCase()) {
                                        duplicateSessions.push(existingSessionId);
                                    }
                                }
                                
                                // Remove duplicate sessions and transfer master status if needed
                                for (const duplicateSessionId of duplicateSessions) {
                                    const duplicateSession = sessions.get(duplicateSessionId);
                                    const duplicateWs = duplicateSession?.ws;
                                    
                                    // If this duplicate session is the master, transfer master status to new session
                                    if (duplicateSessionId === masterUserSessionId && spotifyEmail && session.state?.spotify?.access_token) {
                                        logger.info(`Transferring master status from old session ${duplicateSessionId} to new session ${sessionId} (same user: ${currentUserEmail})`);
                                        masterUserSessionId = sessionId;
                                        masterWasTransferred = true;
                                        
                                        // Restart polling if we're in play mode
                                        if (mode === 'master_play') {
                                            stopPolling();
                                            startPolling();
                                        }
                                    }
                                    
                                    // Delete the duplicate session
                                    logger.info(`Removing duplicate session ${duplicateSessionId} for user ${currentUserEmail}`);
                                    if (duplicateWs && duplicateWs.readyState === 1) {
                                        duplicateWs.close();
                                    }
                                    sessions.delete(duplicateSessionId);
                                    
                                    // Clear any cleanup timer for the duplicate session
                                    if (sessionCleanupTimers.has(duplicateSessionId)) {
                                        clearTimeout(sessionCleanupTimers.get(duplicateSessionId));
                                        sessionCleanupTimers.delete(duplicateSessionId);
                                    }
                                }
                            }
                            
                            assignMasterUserIfNeeded();
                            
                            // If master was transferred, broadcast the mode update to all clients
                            if (masterWasTransferred) {
                                broadcastMode();
                            }
                            
                                    ws.send(JSON.stringify({
                                        type: 'login_success',
                                        sessionId,
                                        userId: message.userId
                                    }));
                            // Send initial state
                            ws.send(JSON.stringify({
                                type: 'tracks_list',
                                tracks: getDisplayTrackList()
                            }));
                            ws.send(JSON.stringify({
                                type: 'mode',
                                mode,
                                currentlyPlayingTrack,
                                masterUserSessionId,
                                canTakeMasterControl: canTakeMasterControl(currentUserEmail),
                                fallbackPlaylist: queueManager.getFallbackInfo(),
                            }));
                            if (sessionId) sendSessionMode(sessionId);
                            broadcastSessionList();
                            serializeSessions();
                            
                            // Add user connected event to history ONLY for new sessions (not reconnections)
                            if (isNewSession) {
                                const loginType = spotifyName ? 'spotify' : 'offline';
                                const connectEvent = {
                                    type: 'user_connected' as const,
                                    timestamp: Date.now(),
                                    userName: spotifyName || listenerName || 'Unknown',
                                    userEmail: currentUserEmail || '',
                                    details: { loginType }
                                };
                                logger.info('Adding user_connected event to history (new session):', JSON.stringify(connectEvent));
                                history.push(connectEvent);
                                broadcastHistory();
                            } else {
                                logger.info(`Skipping user_connected event for ${currentUserEmail} (reconnection, not new session)`);
                            }
                            break;
                        case 'get_tracks':
                            // Respond with the current track list
                            ws.send(JSON.stringify({
                                type: 'tracks_list',
                                tracks: getDisplayTrackList()
                            }));
                            break;
                        case 'get_sessions':
                            // Respond with the current session list (deduplicated by email)
                            const emailToSession = new Map<string, { sessionId: string; userId: string | null; name: string; email: string; isMaster: boolean }>();
                            
                            for (const [sessionId, session] of sessions.entries()) {
                                let name = 'Unknown';
                                let email = 'No email';
                                
                                // Check for Spotify session first
                                if (session.state?.spotify?.name) {
                                    name = session.state.spotify.name;
                                    email = session.state.spotify.email || 'No email';
                                } else if (session.state?.listener?.name) {
                                    // Check for listener session
                                    name = session.state.listener.name;
                                    email = session.state.listener.email || 'No email';
                                } else {
                                    // Invalid session, skip
                                    continue;
                                }
                                
                                // If we already have a session for this email, only replace if this session is newer
                                if (!emailToSession.has(email) || sessionId > emailToSession.get(email)!.sessionId) {
                                    emailToSession.set(email, {
                                        sessionId,
                                        userId: session.userId,
                                        name,
                                        email,
                                        isMaster: sessionId === masterUserSessionId
                                    });
                                }
                            }
                            
                            const sessionList = Array.from(emailToSession.values());
                            ws.send(JSON.stringify({ type: 'sessions_list', sessions: sessionList }));
                            break;
                        case 'remove_track':
                            // Remove track from the queue
                            if (message.spotifyUri && message.sessionId) {
                                const removedTrack = queueManager.removeTrack(message.spotifyUri);
                                if (removedTrack) {
                                    saveTracksToFile();
                                    const removerSession = sessions.get(message.sessionId);
                                    const removerName = removerSession?.state?.spotify?.name || 'Unknown User';
                                    const removerEmail = removerSession?.state?.spotify?.email || 'No email';
                                    const trackName = removedTrack.name || 'Unknown Track';
                                    const trackArtist = removedTrack.artist || 'Unknown Artist';
                                    const trackAlbum = removedTrack.album || 'Unknown Album';
                                    
                                    logger.info(`Track removed: "${trackName}" by ${trackArtist} (${trackAlbum}) [${message.spotifyUri}] - Removed by ${removerName} (${removerEmail}) [${message.sessionId}]`);
                                    broadcastTrackList();
                                }
                            }
                            break;
                        case 'jam':
                            if (message.spotifyUri && message.sessionId) {
                                let updated = false;
                                // Get the user's email
                                const jammerSession = sessions.get(message.sessionId);
                                const jammerEmail = jammerSession?.state?.spotify?.email || jammerSession?.state?.listener?.email || '';
                                const jammerName = jammerSession?.state?.spotify?.name || jammerSession?.state?.listener?.name || 'Unknown';
                                if (!jammerEmail) return; // Don't allow jam if no email
                                
                                // Check if this is a fallback track (not currently playing)
                                const fallbackTrack = queueManager.getFallbackTracks().find(t => t.spotifyUri === message.spotifyUri);
                                const isCurrentlyPlaying = currentlyPlayingTrack && currentlyPlayingTrack.spotifyUri === message.spotifyUri;
                                
                                if (fallbackTrack && !isCurrentlyPlaying) {
                                    // For fallback tracks NOT currently playing: jamming means adding to the real queue
                                    logger.info(`User ${jammerEmail} is adding fallback track ${message.spotifyUri} to real queue`);
                                    
                                    // Check if already in submitted tracks
                                    if (!queueManager.hasTrack(message.spotifyUri)) {
                                        // Remove from fallback queue to avoid playing it twice
                                        queueManager.removeFallbackTrack(message.spotifyUri);
                                        
                                        // Add to real queue
                                        queueManager.addTrack({
                                            spotifyUri: fallbackTrack.spotifyUri,
                                            userEmail: jammerEmail,
                                            spotifyName: jammerName,
                                            timestamp: Date.now(),
                                            name: fallbackTrack.name || '',
                                            artist: fallbackTrack.artist || '',
                                            album: fallbackTrack.album || '',
                                            albumArtUrl: fallbackTrack.albumArtUrl || '',
                                            jamCounts: { [jammerEmail]: 1 } // Start with 1 jam from the user who added it
                                        });
                                        saveTracksToFile();
                                        history.push({
                                            type: 'track_added',
                                            timestamp: Date.now(),
                                            userName: jammerName,
                                            userEmail: jammerEmail,
                                            details: { track: fallbackTrack.name || message.spotifyUri }
                                        });
                                        broadcastTrackList();
                                        broadcastHistory();
                                    } else {
                                        logger.info(`Fallback track ${message.spotifyUri} already in submitted queue`);
                                    }
                                    break; // Exit early for fallback tracks in queue
                                }
                                
                                // If it's a fallback track that's currently playing, fall through to normal jam logic below
                                
                                // Helper function to migrate old jammers array to jamCounts
                                const migrateJammers = (t: any) => {
                                    if (!t.jamCounts) t.jamCounts = {};
                                    if (Array.isArray(t.jammers) && t.jammers.length > 0) {
                                        // Migrate: each email in jammers gets 1 jam
                                        for (const email of t.jammers) {
                                            if (!t.jamCounts[email]) t.jamCounts[email] = 1;
                                        }
                                        t.jammers = []; // Clear old array after migration
                                    }
                                };
                                
                                // Update in queue (for regular submitted tracks)
                                const track = queueManager.getSubmittedTracks().find(t => t.spotifyUri === message.spotifyUri);
                                let jammed = false;
                                if (track) {
                                    migrateJammers(track);
                                    if (message.unjam) {
                                        // Shift-click: unjam (decrement or remove)
                                        if (track.jamCounts![jammerEmail] && track.jamCounts![jammerEmail] > 0) {
                                            track.jamCounts![jammerEmail]--;
                                            if (track.jamCounts![jammerEmail] === 0) {
                                                delete track.jamCounts![jammerEmail];
                                            }
                                            updated = true;
                                            jammed = false;
                                        }
                                    } else {
                                        // Regular click: jam (increment)
                                        if (!track.jamCounts![jammerEmail]) track.jamCounts![jammerEmail] = 0;
                                        track.jamCounts![jammerEmail]++;
                                        updated = true;
                                        jammed = true;
                                    }
                                }
                                // Update currently playing track if it matches
                                if (
                                    currentlyPlayingTrack &&
                                    currentlyPlayingTrack.spotifyUri === message.spotifyUri
                                ) {
                                    migrateJammers(currentlyPlayingTrack);
                                    if (message.unjam) {
                                        // Shift-click: unjam (decrement or remove)
                                        if (currentlyPlayingTrack.jamCounts![jammerEmail] && currentlyPlayingTrack.jamCounts![jammerEmail] > 0) {
                                            currentlyPlayingTrack.jamCounts![jammerEmail]--;
                                            if (currentlyPlayingTrack.jamCounts![jammerEmail] === 0) {
                                                delete currentlyPlayingTrack.jamCounts![jammerEmail];
                                            }
                                            updated = true;
                                            jammed = false;
                                        }
                                    } else {
                                        // Regular click: jam (increment)
                                        if (!currentlyPlayingTrack.jamCounts![jammerEmail]) currentlyPlayingTrack.jamCounts![jammerEmail] = 0;
                                        currentlyPlayingTrack.jamCounts![jammerEmail]++;
                                        updated = true;
                                        jammed = true;
                                    }
                                }
                                if (updated) {
                                    const action = message.unjam ? 'unjammed' : 'jammed';
                                    logger.info(`User ${jammerEmail} ${action} track ${message.spotifyUri}`);
                                    history.push({
                                        type: jammed ? 'jam' : 'unjam',
                                        timestamp: Date.now(),
                                        userName: jammerName,
                                        userEmail: jammerEmail,
                                        details: { track: (track?.name || currentlyPlayingTrack?.name || message.spotifyUri), jammed }
                                    });
                                    saveTracksToFile(); // Save the updated jam counts
                                    broadcastTrackList();
                                    broadcastMode();
                                    broadcastHistory();
                                }
                            }
                            break;
                        
                        case 'delay_track':
                            // Move track back by one position in the queue
                            if (message.spotifyUri && message.sessionId) {
                                const moved = queueManager.moveTrackBackOne(message.spotifyUri);
                                if (moved) {
                                    saveTracksToFile();
                                    logger.info(`Track delayed one position: ${message.spotifyUri} by ${message.sessionId}`);
                                    broadcastTrackList();
                                } else {
                                    logger.info(`Delay request ignored (not found or last item): ${message.spotifyUri}`);
                                }
                            }
                            break;
                        
                        case 'play_track':
                            // Broadcast play_track to all clients
                            if (message.trackId) {
                                for (const s of sessions.values()) {
                                    if (s.ws) s.ws.send(JSON.stringify({ type: 'play_track', trackId: message.trackId }));
                                }
                            }
                            break;
                        case 'master_play':
                            if (mode !== 'master_play') {
                                mode = 'master_play';
                                logger.info('Playback mode set to master_play');
                                // If no currently playing track, try to get the next track (submitted or fallback)
                                if (!currentlyPlayingTrack) {
                                    const masterSession = masterUserSessionId ? sessions.get(masterUserSessionId) : null;
                                    const masterAccessToken = masterSession?.state?.spotify?.access_token;
                                    const nextTrackInfo = await queueManager.peekNextTrack(masterAccessToken);
                                    if (nextTrackInfo) {
                                        const newTrack = nextTrackInfo.track;
                                        currentlyPlayingTrack = newTrack;
                                        currentTrackIsFallback = nextTrackInfo.isFallback;
                                        currentTrackConsumed = false; // Track not yet consumed
                                        if (!nextTrackInfo.isFallback) {
                                            logger.info(`Now playing: ${newTrack.name || newTrack.spotifyUri} (not consumed yet)`);
                                        } else {
                                            logger.info(`Now playing fallback track: ${newTrack.name || newTrack.spotifyUri} (not consumed yet)`);
                                            // Don't add fallback plays to history per user request
                                        }
                                        broadcastTrackList();
                                    }
                                }
                                // Play/resume the current track on Spotify for each session
                                if (currentlyPlayingTrack && currentlyPlayingTrack.spotifyUri) {
                                    lastTrackChangeCommand = Date.now(); // Mark that we commanded playback
                                    startPlaybackFailureTracking(currentlyPlayingTrack.spotifyUri);
                                    await playTrackForSessions(currentlyPlayingTrack, false);
                                }
                                broadcastMode();
                                startPolling();
                            }
                            break;
                        case 'master_pause':
                            if (mode !== 'master_pause') {
                                mode = 'master_pause';
                                logger.info('Playback mode set to master_pause');
                                // Pause all Spotify sessions
                                for (const [sid, sess] of sessions.entries()) {
                                    const accessToken = sess.state?.spotify?.access_token;
                                    if (accessToken) {
                                        try {
                                            await spotifyDelegate.pause(accessToken);
                                            logger.info(`Paused Spotify playback for session ${sid}`);
                                        } catch (err) {
                                            logger.error(`Failed to pause Spotify for session ${sid}:`, err);
                                        }
                                    }
                                }
                                broadcastMode();
                                stopPolling();
                            }
                            break;
                        case 'master_skip':
                            // Skip to next track (user-submitted or fallback)
                            logger.info('Master skip requested');
                            if (mode === 'master_play') {
                                lastManualSkipAt = Date.now();
                                // Before changing currentlyPlayingTrack, push to playHistory and history
                                if (currentlyPlayingTrack) {
                                    const trackCopy = { ...currentlyPlayingTrack };
                                    logger.info('Adding to play history:', JSON.stringify({ 
                                        name: trackCopy.name, 
                                        artist: trackCopy.artist, 
                                        album: trackCopy.album,
                                        albumArtUrl: trackCopy.albumArtUrl,
                                        spotifyUri: trackCopy.spotifyUri
                                    }));
                                    playHistory.push({
                                        timestamp: Date.now(),
                                        track: trackCopy,
                                        startedBy: masterUserSessionId ? (sessions.get(masterUserSessionId)?.state?.spotify?.name || sessions.get(masterUserSessionId)?.state?.listener?.name || '') : undefined
                                    });
                                    broadcastPlayHistory();
                                    
                                    // Add skip event to history
                                    const skipperName = masterUserSessionId ? (sessions.get(masterUserSessionId)?.state?.spotify?.name || sessions.get(masterUserSessionId)?.state?.listener?.name || 'Unknown') : 'Unknown';
                                    const skipperEmail = masterUserSessionId ? (sessions.get(masterUserSessionId)?.state?.spotify?.email || sessions.get(masterUserSessionId)?.state?.listener?.email || '') : '';
                                    history.push({
                                        type: 'track_skip',
                                        timestamp: Date.now(),
                                        userName: skipperName,
                                        userEmail: skipperEmail,
                                        details: { track: { ...currentlyPlayingTrack } }
                                    });
                                    broadcastHistory();
                                }
                                
                                // Get master user's access token for fallback playlist loading
                                const masterSession = masterUserSessionId ? sessions.get(masterUserSessionId) : null;
                                const masterAccessToken = masterSession?.state?.spotify?.access_token;
                                const nextTrackInfo = await queueManager.peekNextTrack(masterAccessToken);
                                
                                if (nextTrackInfo) {
                                    const newTrack = nextTrackInfo.track;
                                    await setCurrentTrackAndStart(newTrack, nextTrackInfo.isFallback, false);
                                } else {
                                    logger.info('No more tracks to skip to');
                                }
                            } else {
                                logger.info('Cannot skip when playback is paused');
                            }
                            break;
                        case 'start_fallback':
                            // Manually start playing from fallback playlist
                            logger.info('Start fallback playlist requested');
                            const fbMasterSession = masterUserSessionId ? sessions.get(masterUserSessionId) : null;
                            const fbMasterAccessToken = fbMasterSession?.state?.spotify?.access_token;
                            
                            if (!fbMasterAccessToken) {
                                logger.warn('No master user token available to start fallback');
                                break;
                            }
                            
                            // Clear current track and get first fallback track
                            if (currentlyPlayingTrack) {
                                playHistory.push({
                                    timestamp: Date.now(),
                                    track: { ...currentlyPlayingTrack },
                                    startedBy: masterUserSessionId ? (fbMasterSession?.state?.spotify?.name || fbMasterSession?.state?.listener?.name || '') : undefined
                                });
                                broadcastPlayHistory();
                            }
                            
                            const fallbackTrackInfo = await queueManager.peekNextTrack(fbMasterAccessToken);
                            
                            if (fallbackTrackInfo) {
                                const fbTrack = fallbackTrackInfo.track;
                                mode = 'master_play';
                                await setCurrentTrackAndStart(fbTrack, fallbackTrackInfo.isFallback, false);
                                startPolling();
                            } else {
                                logger.warn('No fallback tracks available');
                            }
                            break;
                        case 'session_play':
                            if (message.sessionId) {
                                sessionModes.set(message.sessionId, 'session_play');
                                logger.info(`Session ${message.sessionId} set to session_play`);
                                // If there's a currently playing track, start playback for this session at the master's position
                                if (currentlyPlayingTrack && currentlyPlayingTrack.spotifyUri) {
                                    const session = sessions.get(message.sessionId);
                                    const accessToken = session?.state?.spotify?.access_token;
                                    if (accessToken) {
                                        try {
                                            await spotifyDelegate.play(accessToken, { uris: [currentlyPlayingTrack.spotifyUri] });
                                            logger.info(`Session ${message.sessionId} started playback from beginning`);
                                        } catch (err) {
                                            logger.error(`Failed to start playback for session ${message.sessionId}:`, err);
                                        }
                                    }
                                }
                                sendSessionMode(message.sessionId);
                            }
                            break;
                        case 'session_pause':
                            if (message.sessionId) {
                                sessionModes.set(message.sessionId, 'session_pause');
                                logger.info(`Session ${message.sessionId} set to session_pause`);
                                // Pause only this user's Spotify session
                                const session = sessions.get(message.sessionId);
                                const accessToken = session?.state?.spotify?.access_token;
                                if (accessToken) {
                                    try {
                                        await spotifyDelegate.pause(accessToken);
                                        logger.info(`Paused Spotify playback for session ${message.sessionId}`);
                                    } catch (err) {
                                        logger.error(`Failed to pause Spotify for session ${message.sessionId}:`, err);
                                    }
                                }
                                sendSessionMode(message.sessionId);
                            }
                            break;
                        case 'airhorn':
                            if (message.airhorn) {
                                for (const [sid, sess] of sessions.entries()) {
                                    if (sess.ws && sess.ws.readyState === 1) {
                                        sess.ws.send(JSON.stringify({ type: 'play_airhorn', airhorn: message.airhorn }));
                                    }
                                }
                                const senderSession = sessions.get(sessionId);
                                const senderName = senderSession?.state?.spotify?.name || senderSession?.state?.listener?.name || 'Unknown';
                                const senderEmail = senderSession?.state?.spotify?.email || senderSession?.state?.listener?.email || '';
                                history.push({
                                    type: 'airhorn',
                                    timestamp: Date.now(),
                                    userName: senderName,
                                    userEmail: senderEmail,
                                    details: { airhorn: message.airhorn }
                                });
                                logger.info(`Broadcasted play_airhorn: ${message.airhorn}`);
                                broadcastHistory();
                            }
                            break;
                        case 'get_play_history':
                            ws.send(JSON.stringify({ type: 'play_history', playHistory: playHistory.slice(-100) }));
                            break;
                        case 'master_skip':
                            if (message.sessionId && message.sessionId === masterUserSessionId) {
                                // Push current track to play history if present
                                if (currentlyPlayingTrack) {
                                    playHistory.push({
                                        timestamp: Date.now(),
                                        track: { ...currentlyPlayingTrack },
                                        startedBy: masterUserSessionId ? (sessions.get(masterUserSessionId)?.state?.spotify?.name || sessions.get(masterUserSessionId)?.state?.listener?.name || '') : undefined
                                    });
                                    broadcastPlayHistory();
                                }
                                
                                // Get master user's access token for fallback playlist loading
                                const masterSession = masterUserSessionId ? sessions.get(masterUserSessionId) : null;
                                const masterAccessToken = masterSession?.state?.spotify?.access_token;
                                const nextTrackInfo = await queueManager.peekNextTrack(masterAccessToken);
                                
                                if (nextTrackInfo) {
                                    const newTrack = nextTrackInfo.track;
                                    currentlyPlayingTrack = newTrack;
                                    currentTrackIsFallback = nextTrackInfo.isFallback;
                                    currentTrackConsumed = false; // Track not yet consumed
                                    if (!nextTrackInfo.isFallback) {
                                        logger.info(`Skipped to: ${newTrack.name || newTrack.spotifyUri} (not consumed yet)`);
                                    } else {
                                        logger.info(`Skipped to fallback queue: ${newTrack.name || newTrack.spotifyUri} (not consumed yet)`);
                                        
                                        // Record fallback play in history
                                        history.push({
                                            type: 'fallback_play',
                                            timestamp: Date.now(),
                                            userName: 'System',
                                            userEmail: 'fallback@system',
                                            details: { 
                                                track: newTrack.name || newTrack.spotifyUri,
                                                playlist: newTrack.spotifyName || 'Fallback Playlist'
                                            }
                                        });
                                        broadcastHistory();
                                    }

                                    masterTrackStarted = false;
                                    lastTrackChangeCommand = Date.now();
                                    
                                    // Play the new track for all sessions with session_play mode
                                    for (const [sid, sess] of sessions.entries()) {
                                        const sessionMode = sessionModes.get(sid);
                                        if (sessionMode === 'session_play') {
                                            const accessToken = sess.state?.spotify?.access_token;
                                            if (accessToken) {
                                                try {
                                                    await spotifyDelegate.play(accessToken, { uris: [newTrack.spotifyUri] });
                                                } catch (err) {
                                                    logger.error(`Failed to auto-start playback for session ${sid}:`, err);
                                                }
                                            }
                                        }
                                    }
                                    
                                    broadcastTrackList();
                                    broadcastMode();
                                } else {
                                    currentlyPlayingTrack = null;
                                    masterTrackStarted = false;
                                    if (mode !== 'master_pause') {
                                        mode = 'master_pause';
                                        broadcastTrackList();
                                        broadcastMode();
                                    }
                                }
                            }
                            break;
                        case 'take_master_control':
                            if (message.sessionId) {
                                const takingSession = sessions.get(message.sessionId);
                                const userEmail = takingSession?.state?.spotify?.email;
                                const userName = takingSession?.state?.spotify?.name;
                                
                                if (canTakeMasterControl(userEmail) && takingSession?.state?.spotify?.access_token) {
                                    const oldMasterId = masterUserSessionId;
                                    const oldMasterSession = oldMasterId ? sessions.get(oldMasterId) : null;
                                    const oldMasterName = oldMasterSession?.state?.spotify?.name || oldMasterSession?.state?.listener?.name || 'Unknown';
                                    
                                    masterUserSessionId = message.sessionId;
                                    logger.info(`Master control taken by ${userName} (${userEmail}) from ${oldMasterName}`);
                                    
                                    // If there's a current track and master_play mode, start polling
                                    if (mode === 'master_play') {
                                        stopPolling(); // Stop old polling
                                        startPolling(); // Start new polling for new master
                                    }
                                    
                                    broadcastSessionList();
                                    broadcastMode();
                                } else {
                                    logger.warn(`Unauthorized attempt to take master control by ${userName} (${userEmail})`);
                                }
                            }
                            break;
                        case 'history_message':
                            if (message.message && message.sessionId) {
                                const msgSession = sessions.get(message.sessionId);
                                const userName = msgSession?.state?.spotify?.name || msgSession?.state?.listener?.name || 'Unknown';
                                const userEmail = msgSession?.state?.spotify?.email || msgSession?.state?.listener?.email || '';
                                
                                history.push({
                                    type: 'message',
                                    timestamp: Date.now(),
                                    userName,
                                    userEmail,
                                    details: { message: message.message }
                                });
                                broadcastHistory();
                                logger.info(`History message posted by ${userName}: ${message.message}`);
                            }
                            break;
                        case 'ping':
                            // Update last heartbeat timestamp
                            if (message.sessionId) {
                                const session = sessions.get(message.sessionId);
                                if (session) {
                                    session.lastHeartbeat = Date.now();
                                    // Send pong response
                                    if (session.ws && session.ws.readyState === 1) {
                                        session.ws.send(JSON.stringify({ type: 'pong' }));
                                    }
                                }
                            }
                            break;
                    }
                } catch (error) {
                    logger.error('Error processing message:', error);
                }
            });

            // Handle disconnection
            ws.on('close', () => {
                if (sessionId) {
                    const session = sessions.get(sessionId);
                    if (session) {
                        logger.info(`WebSocket closed for session ${sessionId}, marking as disconnected (will cleanup after missed heartbeats)`);
                        // Set WebSocket to null but keep session alive
                        session.ws = null;
                        // Session will be cleaned up by periodic heartbeat check if client doesn't reconnect
                    }
                }
            });
        });

        // Handle server errors
        wss.on('error', (error) => {
            logger.error('WebSocket server error:', error);
        });

    } catch (error) {
        logger.error('Failed to start WebSocket server:', error);
        process.exit(1);
    }
}

// REST endpoints
const loginHandler: RequestHandler = (req: Request<{}, {}, LoginMessage>, res: Response): void => {
    const { userId } = req.body;
    if (!userId) {
        res.status(400).json({ error: 'User ID is required' });
        return;
    }
    res.json({ success: true, userId });
};

app.post('/api/login', loginHandler);


// REST endpoint to submit a track
app.post('/api/tracks', async (req: Request, res: Response): Promise<void> => {
    const { trackId: rawInput, sessionId } = req.body;
    if (!rawInput || !sessionId) {
        res.status(400).json({ error: 'Spotify URI/URL/ID and sessionId are required' });
        return;
    }
    
    // Parse and normalize the input
    const parsed = spotifyDelegate.parseSpotifyInput(rawInput);
    
    if (!parsed) {
        logger.warn(`Invalid Spotify input: ${rawInput}`);
        res.status(400).json({ 
            error: 'Invalid Spotify input. Please provide a valid track URL, URI, or ID.' 
        });
        return;
    }
    
    // Check if this is a supported entity type
    if (!spotifyDelegate.isSupportedForPlayback(rawInput)) {
        logger.warn(`Unsupported entity type: ${parsed.type} for input: ${rawInput}`);
        res.status(400).json({ 
            error: `Sorry, ${parsed.type}s are not supported. Please submit a track or playlist.` 
        });
        return;
    }
    
    const spotifyUri = parsed.uri;
    logger.info(`Normalized input "${rawInput}" to URI: ${spotifyUri} (type: ${parsed.type})`);
    
    // Check if this is a playlist
    if (parsed.type === 'playlist') {
        // User submitted a playlist URL - validate it before replacing fallback playlist
        logger.info(`User submitted playlist URL: ${spotifyUri}, attempting to validate and load`);
        const masterSession = masterUserSessionId ? sessions.get(masterUserSessionId) : null;
        const masterAccessToken = masterSession?.state?.spotify?.access_token;
        
        if (!masterAccessToken) {
            logger.warn('No master user token available to validate playlist');
            res.status(400).json({ error: 'Cannot validate playlist - no master user connected' });
            return;
        }
        
        // Try to load the playlist - this validates that it's readable
        const success = await queueManager.loadFallbackPlaylist(spotifyUri, masterAccessToken);
        
        if (success) {
            logger.info(`Successfully validated and loaded fallback playlist: ${spotifyUri}`);
            // Broadcast the updated fallback info to all clients
            broadcastMode();
            res.json({ success: true, message: 'Fallback playlist updated' });
        } else {
            logger.warn(`Failed to load playlist ${spotifyUri} - it may not be readable or may not exist`);
            res.status(400).json({ 
                error: 'Unable to load playlist. Please ensure the playlist exists and is publicly accessible or owned by you.' 
            });
        }
        return;
    }
    
    // Prevent duplicate tracks
    if (queueManager.hasTrack(spotifyUri)) {
        logger.info(`Track ${spotifyUri} already exists, not adding duplicate.`);
        res.json({ success: true });
        return;
    }
    // Extract the track ID from the URI (e.g., spotify:track:3wel4QF756fwoAUocFbYsm)
    const match = spotifyUri.match(/spotify:track:([a-zA-Z0-9]+)/);
    const trackId = match ? match[1] : spotifyUri;
            const session = sessions.get(sessionId);
    const spotifyName = session?.state?.spotify?.name || '';
    const accessToken = session?.state?.spotify?.access_token;
    let trackInfo: any = {};
    const masterSession = masterUserSessionId ? sessions.get(masterUserSessionId) : null;
    const masterAccessToken = masterSession?.state?.spotify?.access_token;
    if (masterAccessToken && trackId) {
        try {
            trackInfo = await getSpotifyTrackInfo(masterAccessToken, trackId);
            if (trackInfo && trackInfo.name && trackInfo.artist && trackInfo.album) {
                logger.info(`Track info: ${trackInfo.name} | ${trackInfo.artist} | ${trackInfo.album}`);
            }
        } catch (err) {
            logger.error('Failed to fetch track info from Spotify', err);
        }
    }
    // Determine submitter name for both Spotify and listener users
    let submitterName = '';
    let submitterEmail = '';
    if (session?.state?.spotify?.name) {
        submitterName = session.state.spotify.name;
        submitterEmail = session.state.spotify.email || '';
    } else if (session?.state?.listener?.name) {
        submitterName = session.state.listener.name;
        submitterEmail = session.state.listener.email || '';
    }
    logger.info(`Track submitted: ${spotifyUri} by session ${sessionId} (${submitterName})`);
    queueManager.addTrack({ spotifyUri, userEmail: submitterEmail, spotifyName: submitterName, timestamp: Date.now(), ...trackInfo });
    saveTracksToFile();
    history.push({
        type: 'track_added',
        timestamp: Date.now(),
        userName: submitterName,
        userEmail: submitterEmail,
        details: { track: trackInfo.name || spotifyUri }
    });
    broadcastTrackList();
    broadcastHistory();
    res.json({ success: true });
});

// Endpoint to check session state
app.get('/api/session/:sessionId', (req: Request, res: Response) => {
    const sessionId = req.params.sessionId;
    logger.info('=== SESSION CHECK ===', { sessionId });
    
    const session = sessions.get(sessionId);
    
    if (session) {
        logger.info('Session found', {
            sessionId,
            hasState: !!session.state,
            hasSpotify: !!session.state?.spotify,
            hasSpotifyToken: !!session.state?.spotify?.access_token,
            spotifyEmail: session.state?.spotify?.email,
            spotifyName: session.state?.spotify?.name,
            hasListener: !!session.state?.listener,
            listenerEmail: session.state?.listener?.email,
            listenerName: session.state?.listener?.name,
        });
    } else {
        logger.warn('Session not found', {
            sessionId,
            totalSessions: sessions.size,
            availableSessions: Array.from(sessions.keys()),
        });
    }
    
    if (
        session &&
        session.state &&
        (
            (session.state.spotify && session.state.spotify.access_token) ||
            (session.state.listener && session.state.listener.name && session.state.listener.email)
        )
    ) {
        logger.info('Session is valid - returning loggedIn: true', { sessionId });
        res.json({ loggedIn: true });
    } else {
        logger.warn('Session is invalid - returning loggedIn: false', { sessionId });
        res.json({ loggedIn: false });
    }
});

// Basic route
app.get('/', (_req: Request, res: Response) => {
    res.json({ message: 'Backend server is running!' });
});

// Mount the Spotify router with sessions
app.use('/api/spotify', createSpotifyRouter(sessions));

// Periodically refresh Spotify access tokens for all connected users
async function refreshAllSpotifyTokens() {
    for (const [sessionId, session] of sessions.entries()) {
        const spotifyState = session.state?.spotify;
        if (spotifyState && spotifyState.refresh_token) {
            try {
                const data = await spotifyDelegate.refreshAccessToken(spotifyState.refresh_token);
                if (data && data.access_token) {
                    spotifyState.access_token = data.access_token;
                    if (data.expires_in) spotifyState.expires_in = data.expires_in;
                    if (data.refresh_token) spotifyState.refresh_token = data.refresh_token;
                    logger.info(`Refreshed Spotify access token for session ${sessionId}`);
                }
            } catch (err) {
                logger.error(`Failed to refresh Spotify token for session ${sessionId}:`, err);
            }
        }
    }
    serializeSessions();
}

// Refresh tokens every 30 minutes
setInterval(refreshAllSpotifyTokens, 30 * 60 * 1000);

// Listener login endpoint
app.post('/api/listener-login', (req: Request, res: Response) => {
    const { name, email } = req.body;
    if (!name || !email) {
        res.status(400).json({ error: 'Name and email are required' });
        return;
    }
    const sessionId = uuidv4();
    sessions.set(sessionId, {
        ws: null,
        userId: null,
        state: { listener: { name, email } },
        lastHeartbeat: Date.now()
    });
    logger.info(`Listener session created: ${name} <${email}> [${sessionId}]`);
    res.json({ sessionId });
    serializeSessions();
});

// Proactive session cleanup on server start
function cleanupInvalidSessions() {
    for (const [sessionId, session] of sessions.entries()) {
        const spotifyName = session.state?.spotify?.name || '';
        const spotifyEmail = session.state?.spotify?.email;
        const listenerName = session.state?.listener?.name;
        const listenerEmail = session.state?.listener?.email;
        if (!(spotifyName && spotifyEmail) && !(listenerName && listenerEmail)) {
            sessions.delete(sessionId);
            logger.info(`Removed invalid session on startup: ${sessionId}`);
        }
    }
    serializeSessions();
}

// Configuration class
class Config {
    private static config = {
        // Hardcoded list of available airhorns (must match frontend's /public/airhorns/)
        airhorns: [
            'air-horn',
            'airhorn',
            'America',
            'baking_soda',
            'boat',
            'dj_airhorn',
            'evil-giggle',
            'foghorn',
            'fuck_all_yall',
            'gedolah',
            'growl',
            'here-we-go',
            'hohoho',
            'mk_toasty',
            'reemix',
            'reload_shot',
            'shevarim',
            'ship-horn',
            'tekiah',
            'teruah',
            'trombone',
            'vintage-car-horn',
            'vuvuzela',
            'wookie',
            'zillaroar'
        ]
    };
    static get(key: keyof typeof Config.config) {
        return Config.config[key];
    }
}

// REST endpoint to list available airhorns
app.get('/api/airhorns', (req: Request, res: Response) => {
    const airhorns = Config.get('airhorns');
    res.json({ airhorns });
});

// Endpoint for master to load 10 random liked tracks
async function masterRandomLikedHandler(req: Request, res: Response) {
    const { sessionId } = req.body;
    if (!sessionId || sessionId !== masterUserSessionId) {
        return res.status(403).json({ error: 'Only the master can use this feature.' });
    }
    const session = sessions.get(sessionId);
    const accessToken = session?.state?.spotify?.access_token;
    const spotifyName = (session?.state?.spotify?.name as string) || '';
    if (!accessToken) {
        return res.status(400).json({ error: 'Master does not have a valid Spotify session.' });
    }
    try {
        const tracks = await spotifyDelegate.getRandomLikedTracks(accessToken, 10);
        for (const track of tracks) {
            // Prevent duplicates
            if (queueManager.hasTrack(track.spotifyUri)) continue;
            queueManager.addTrack({
                spotifyUri: track.spotifyUri,
                userEmail: session?.state?.spotify?.email || '',
                spotifyName: spotifyName || '',
                timestamp: Date.now(),
                name: track.name || '',
                artist: track.artist || '',
                album: track.album || '',
                albumArtUrl: track.albumArtUrl || ''
            });
        }
        saveTracksToFile();
        broadcastTrackList();
        res.json({ success: true, added: tracks.length });
    } catch (err) {
        logger.error('Failed to load random liked tracks:', err);
        res.status(500).json({ error: 'Failed to load liked tracks.' });
    }
}
app.post('/api/master-random-liked', (req, res, next) => {
    masterRandomLikedHandler(req, res).catch(next);
});

// ============================================
// DEBUG ENDPOINTS
// ============================================

// Debug endpoint for connection testing
app.post('/api/debug/connection', (req: Request, res: Response) => {
    const timestamp = new Date().toISOString();
    const clientInfo = {
        ip: req.ip || req.socket.remoteAddress,
        userAgent: req.headers['user-agent'],
        origin: req.headers.origin,
        referer: req.headers.referer,
        host: req.headers.host,
        method: req.method,
        protocol: req.protocol,
        secure: req.secure,
        contentType: req.headers['content-type'],
    };
    
    logger.info('=== DEBUG CONNECTION REQUEST ===', {
        timestamp,
        clientInfo,
        body: req.body,
        query: req.query,
        headers: req.headers,
    });
    
    const response = {
        success: true,
        timestamp,
        message: 'Connection test successful',
        server: {
            nodeVersion: process.version,
            platform: process.platform,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            env: {
                NODE_ENV: process.env.NODE_ENV,
                PORT: process.env.PORT,
                WS_PORT: process.env.WS_PORT,
                FRONTEND_URL: process.env.FRONTEND_URL,
            }
        },
        client: clientInfo,
        requestData: {
            body: req.body,
            query: req.query,
            params: req.params,
        },
        cors: {
            allowOrigin: res.getHeader('Access-Control-Allow-Origin'),
            allowMethods: res.getHeader('Access-Control-Allow-Methods'),
            allowHeaders: res.getHeader('Access-Control-Allow-Headers'),
        }
    };
    
    logger.info('=== DEBUG CONNECTION RESPONSE ===', response);
    res.json(response);
});

// Health check endpoint with extensive diagnostics
app.get('/api/debug/health', (req: Request, res: Response) => {
    const timestamp = new Date().toISOString();
    
    logger.info('=== DEBUG HEALTH CHECK ===', { timestamp });
    
    // Check WebSocket server
    const wsServerStatus = webSocketServerStarted ? 'running' : 'not started';
    
    // Count active sessions
    const activeSessions = Array.from(sessions.entries()).map(([id, session]) => ({
        sessionId: id,
        hasWebSocket: !!session.ws,
        wsState: session.ws ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][session.ws.readyState] : 'N/A',
        userId: session.userId,
        hasSpotify: !!session.state?.spotify,
        hasListener: !!session.state?.listener,
        spotifyEmail: session.state?.spotify?.email || null,
        listenerEmail: session.state?.listener?.email || null,
    }));
    
    const health = {
        status: 'ok',
        timestamp,
        server: {
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            uptime: process.uptime(),
            uptimeFormatted: formatUptime(process.uptime()),
            memory: {
                used: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
                total: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`,
                rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
            },
        },
        environment: {
            NODE_ENV: process.env.NODE_ENV || 'development',
            PORT: port,
            WS_PATH: '/websocket',
            FRONTEND_URL: process.env.FRONTEND_URL || 'not set',
            SPOTIFY_CLIENT_ID: process.env.SPOTIFY_CLIENT_ID ? 'set' : 'not set',
            SPOTIFY_CLIENT_SECRET: process.env.SPOTIFY_CLIENT_SECRET ? 'set' : 'not set',
            SPOTIFY_REDIRECT_URI: process.env.SPOTIFY_REDIRECT_URI || 'not set',
        },
        services: {
            express: 'running',
            webSocket: wsServerStatus,
        },
        sessions: {
            total: sessions.size,
            active: activeSessions.filter(s => s.wsState === 'OPEN').length,
            withSpotify: activeSessions.filter(s => s.hasSpotify).length,
            listeners: activeSessions.filter(s => s.hasListener).length,
            master: masterUserSessionId || 'none',
            details: activeSessions,
        },
        tracks: {
            total: queueManager.getSubmittedCount(),
            currentlyPlaying: currentlyPlayingTrack ? {
                name: currentlyPlayingTrack.name,
                artist: currentlyPlayingTrack.artist,
                uri: currentlyPlayingTrack.spotifyUri,
            } : null,
        },
        playback: {
            mode,
            masterUserSessionId,
        },
        cors: {
            enabled: true,
            allowOrigin: '*',
            allowMethods: 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
        },
        request: {
            ip: req.ip || req.socket.remoteAddress,
            userAgent: req.headers['user-agent'],
            origin: req.headers.origin,
        }
    };
    
    logger.info('=== DEBUG HEALTH CHECK RESPONSE ===', health);
    res.json(health);
});

// Helper function to format uptime
function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

// ============================================
// END DEBUG ENDPOINTS
// ============================================

// Start HTTP server
(async () => {
  await loadSessionsFromFile();
  await loadTracksFromFile();
  loadHistoryFromFile();
  
  // Add system restart event to history
  history.push({
    type: 'user_connected',
    timestamp: Date.now(),
    userName: 'System',
    userEmail: 'system@server',
    details: { loginType: 'system', restart: true }
  });
  logger.info('Added system restart event to history');
  
  cleanupInvalidSessions();
  
  // Load fallback playlist if configured
  if (queueManager.getFallbackPlaylistUrl()) {
    logger.info('Loading fallback playlist on startup');
    // Try to find a master user token, otherwise it will be loaded later
    const masterSession = masterUserSessionId ? sessions.get(masterUserSessionId) : null;
    const masterAccessToken = masterSession?.state?.spotify?.access_token;
    if (masterAccessToken) {
      await queueManager.loadFallbackPlaylist(queueManager.getFallbackPlaylistUrl(), masterAccessToken);
    } else {
      logger.info('No master user token available yet, fallback playlist will load when master user connects');
    }
  }
  
  const httpServer = http.createServer(app);
  
  httpServer.listen(port, () => {
    logger.info(`HTTP Server is running on port ${port}`);
    // Start WebSocket server on same port at /websocket path
    startWebSocketServer(httpServer); 
  }); 
})(); 

function broadcastHistory() {
    // Trim history to MAX_HISTORY_EVENTS
    if (history.length > MAX_HISTORY_EVENTS) {
        history.splice(0, history.length - MAX_HISTORY_EVENTS);
        logger.info(`Trimmed history to ${MAX_HISTORY_EVENTS} events`);
    }
    
    // Save to file whenever history is broadcast
    saveHistoryToFile();
    
    const historyList = history.slice(-100); // Limit to last 100 events for broadcast
    logger.info(`Broadcasting history (${historyList.length} events). Sample of last event:`, historyList.length > 0 ? JSON.stringify(historyList[historyList.length - 1]) : 'none');
    for (const [sessionId, session] of sessions.entries()) {
        if (!session.ws || session.ws.readyState !== 1) continue;
        session.ws.send(JSON.stringify({ type: 'history', history: historyList }));
    }
} 

// Helper to broadcast play history to all connected clients
function broadcastPlayHistory() {
    const historyList = playHistory.slice(-100); // Limit to last 100
    for (const [sessionId, session] of sessions.entries()) {
        if (!session.ws || session.ws.readyState !== 1) continue;
        session.ws.send(JSON.stringify({ type: 'play_history', playHistory: historyList }));
    }
} 

function getErrorMessage(err: unknown): string {
    if (err && typeof err === 'object' && 'message' in err && (err as any).message) {
        return (err as any).message;
    }
    return err ? err.toString() : '';
} 

function serializeSessions() {
    // Only persist Spotify sessions (exclude listener sessions and ws)
    const arr = Array.from(sessions.entries())
        .filter(([sessionId, session]) => {
            // Only include sessions that have Spotify state (exclude listener sessions)
            return session.state?.spotify?.access_token;
        })
        .map(([sessionId, session]) => {
            const { ws, ...rest } = session;
            return { sessionId, ...rest };
        });
    try {
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(arr, null, 2));
    } catch (err) {
        logger.error('Failed to save sessions to file:', err);
    }
}

async function loadSessionsFromFile() {
    if (fs.existsSync(SESSIONS_FILE)) {
        try {
            const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
            const arr = JSON.parse(data);
            if (Array.isArray(arr)) {
                for (const s of arr) {
                    // Rehydrate session object, ws is always null on startup
                    const { sessionId, userId, state } = s;
                    const session = { ws: null, userId, state, lastHeartbeat: Date.now() };
                    // For Spotify sessions, try to refresh token if possible
                    if (state && state.spotify && state.spotify.refresh_token) {
                        try {
                            const data = await spotifyDelegate.refreshAccessToken(state.spotify.refresh_token);
                            if (data && data.access_token) {
                                state.spotify.access_token = data.access_token;
                                if (data.expires_in) state.spotify.expires_in = data.expires_in;
                                if (data.refresh_token) state.spotify.refresh_token = data.refresh_token;
                                logger.info(`Refreshed Spotify access token for session ${sessionId}`);
                            }
                        } catch (err) {
                            logger.error(`Failed to refresh Spotify token for session ${sessionId}:`, err);
                            continue; // Skip adding this session if refresh fails
                        }
                    }
                    sessions.set(sessionId, session);
                }
            }
        } catch (err) {
            logger.error('Failed to load sessions from file:', err);
        }
    }
} 

// Periodic cleanup of stale sessions (those that haven't sent heartbeat in a while)
const HEARTBEAT_TIMEOUT_MS = 60000; // 60 seconds - 2 missed heartbeats (clients ping every 30s)
const CLEANUP_INTERVAL_MS = 30000; // Check every 30 seconds

function cleanupStaleSessions() {
    const now = Date.now();
    const sessionsToRemove: string[] = [];
    
    for (const [sessionId, session] of sessions.entries()) {
        const timeSinceHeartbeat = now - session.lastHeartbeat;
        if (timeSinceHeartbeat > HEARTBEAT_TIMEOUT_MS) {
            logger.info(`Session ${sessionId} is stale (no heartbeat for ${Math.floor(timeSinceHeartbeat / 1000)}s), removing`);
            sessionsToRemove.push(sessionId);
        }
    }
    
    // Remove stale sessions and add disconnection events
    for (const sessionId of sessionsToRemove) {
        const session = sessions.get(sessionId);
        if (session) {
            const userName = session.state?.spotify?.name || session.state?.listener?.name || 'Unknown';
            const userEmail = session.state?.spotify?.email || session.state?.listener?.email || '';
            
            // Add disconnection event to history
            history.push({
                type: 'user_disconnected',
                timestamp: Date.now(),
                userName,
                userEmail,
                details: {}
            });
            
            sessions.delete(sessionId);
            logger.info(`Removed stale session ${sessionId} (${userName})`);
        }
    }
    
    // Broadcast updates if any sessions were removed
    if (sessionsToRemove.length > 0) {
        broadcastSessionList();
        broadcastHistory();
        serializeSessions();
    }
}

// Start periodic cleanup
setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
logger.info(`Started periodic session cleanup (checking every ${CLEANUP_INTERVAL_MS / 1000}s, timeout after ${HEARTBEAT_TIMEOUT_MS / 1000}s)`);

// Log all configured values at startup
logger.info('Configured values:');
logger.info(`  HTTP port: ${port}`);
logger.info(`  WebSocket path: /websocket`);
logger.info(`  POLL_INTERVAL_MS: ${POLL_INTERVAL_MS}`);
logger.info(`  DEBUG: ${DEBUG}`);
logger.info(`  Tracks file: ${TRACKS_FILE}`);
logger.info(`  Sessions file: ${SESSIONS_FILE}`);
logger.info(`  Fallback playlist URL: ${queueManager.getFallbackPlaylistUrl() || 'not configured'}`); 