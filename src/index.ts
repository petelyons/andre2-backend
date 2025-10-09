import express, { Request, Response, RequestHandler } from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import logger from './logger';
import { createSpotifyRouter, getSpotifyTrackInfo, spotifyDelegate } from './spotify';
import fs from 'fs';
import path from 'path';
// Import types if available
// import { SpotifyApi } from 'spotify-web-api-node';

// Temporary module declaration for spotify-web-api-node if types are missing
// Remove this if @types/spotify-web-api-node is available
// @ts-ignore
// declare module 'spotify-web-api-node';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;
const wsPort = 3002;

var webSocketServerStarted: boolean = false;

// Types
interface Session {
    ws: WebSocket | null;
    userId: string | null;
    state: Record<string, any>;
}

// New type for submittedTracks
export interface SubmittedTrack {
    spotifyUri: string;
    userEmail: string | null;
    spotifyName: string | null;
    timestamp: number;
    name?: string;
    artist?: string;
    album?: string;
    albumArtUrl?: string;
    jammers?: string[];
    progress?: { position_ms: number; duration_ms: number } | null;
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

// Event history
interface HistoryEvent {
    type: 'track_added' | 'jam' | 'unjam' | 'airhorn';
    timestamp: number;
    userName: string;
    userEmail: string;
    details: any;
}

// Play history
interface PlayHistoryEntry {
    timestamp: number;
    track: any;
    startedBy?: string;
}

// Union type for all messages
type Message = LoginMessage | GenericMessage | PlayTrackMessage | GetTracksMessage | JamMessage | PlayMessage | PauseMessage | SessionPlayMessage | SessionPauseMessage | GetSessionsMessage | RemoveTrackMessage | AirhornMessage | GetPlayHistoryMessage | MasterSkipMessage;

// Middleware
app.use(cors());
app.use(express.json());

// Store active sessions
const sessions = new Map<string, Session>();
const sessionCleanupTimers = new Map<string, NodeJS.Timeout>();

// Store all submitted tracks in chronological order
const submittedTracks: SubmittedTrack[] = [];

// Global playback mode state
let mode: 'master_play' | 'master_pause' = 'master_pause';

// Per-session playback mode
const sessionModes = new Map<string, 'session_play' | 'session_pause'>();

// Shared currently playing track
let currentlyPlayingTrack: SubmittedTrack | null = null;

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

// JSON persistence for submittedTracks
const TRACKS_FILE = path.join(__dirname, 'tracks.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
function saveTracksToFile() {
    try {
        fs.writeFileSync(TRACKS_FILE, JSON.stringify(submittedTracks, null, 2));
    } catch (err) {
        logger.error('Failed to save tracks to file:', err);
    }
}
function loadTracksFromFile() {
    if (fs.existsSync(TRACKS_FILE)) {
        try {
            const data = fs.readFileSync(TRACKS_FILE, 'utf-8');
            const arr = JSON.parse(data);
            if (Array.isArray(arr)) {
                submittedTracks.length = 0;
                for (const t of arr) {
                    // Migration: convert sessionId to userEmail if needed
                    if (t.sessionId && !t.userEmail) {
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
                    submittedTracks.push(t);
                }
                // Save the migrated tracks back to file
                if (arr.some(t => t.sessionId)) {
                    saveTracksToFile();
                    logger.info('Migrated tracks from sessionId to userEmail format');
                }
            }
        } catch (err) {
            logger.error('Failed to load tracks from file:', err);
        }
    }
}

// Helper to broadcast the full track list to all connected clients
function broadcastTrackList() {
    const trackList = submittedTracks.map(t => ({
        spotifyUri: t.spotifyUri,
        userEmail: t.userEmail,
        spotifyName: t.spotifyName,
        name: t.name,
        artist: t.artist,
        album: t.album,
        albumArtUrl: t.albumArtUrl,
        jammers: t.jammers || []
    }));
    for (const [sessionId, session] of sessions.entries()) {
        if (!session.ws || session.ws.readyState !== 1) { // 1 = OPEN
            logger.info(`Skipping broadcast to session ${sessionId} (WebSocket not open)`);
            // Do NOT remove closed sessions here; let the cleanup timer handle it
            continue;
        }
        logger.info(`Broadcasting to: ${session.userId}`);
        session.ws && session.ws.send(JSON.stringify({ type: 'tracks_list', tracks: trackList }));
    }
}

function broadcastMode() {
    for (const [sessionId, session] of sessions.entries()) {
        if (!session.ws || session.ws.readyState !== 1) continue;
        session.ws && session.ws.send(JSON.stringify({
            type: 'mode',
            mode,
            currentlyPlayingTrack,
            masterUserSessionId,
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
            logger.info('Advancing to next track due to detected end.');
            if (submittedTracks.length > 0) {
                currentlyPlayingTrack = submittedTracks.shift()!;
                saveTracksToFile();
                logger.info(`Now playing: ${currentlyPlayingTrack.name || currentlyPlayingTrack.spotifyUri}`);
                masterTrackStarted = false; // Reset flag for new track
                // Play the new track for all sessions with session_play mode
                for (const [sid, sess] of sessions.entries()) {
                    const sessionMode = sessionModes.get(sid);
                    if (sessionMode === 'session_play') {
                        const accessToken = sess.state?.spotify?.access_token;
                        if (accessToken) {
                            try {
                                await spotifyDelegate.play(accessToken, { uris: [currentlyPlayingTrack.spotifyUri] });
                                logger.info(`Auto-started playback for session ${sid} (session_play mode)`);
                            } catch (err) {
                                logger.error(`Failed to auto-start playback for session ${sid}:`, err);
                                const errMsg = getErrorMessage(err);
                                if (errMsg.includes('NO_ACTIVE_DEVICE') || errMsg.includes('No active device found')) {
                                    notifyUserToActivateDevice(sid);
                                }
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
                    logger.info('No more tracks in queue, stopping playback');
                    broadcastTrackList();
                    broadcastMode();
                }
            }
            // Before changing currentlyPlayingTrack, push to playHistory
            if (currentlyPlayingTrack) {
                playHistory.push({
                    timestamp: Date.now(),
                    track: { ...currentlyPlayingTrack },
                    startedBy: masterUserSessionId ? (sessions.get(masterUserSessionId)?.state?.spotify?.name || sessions.get(masterUserSessionId)?.state?.listener?.name || '') : undefined
                });
                broadcastPlayHistory();
            }
            return; // Skip the rest of the function for this poll
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
            if (currentlyPlayingTrack && curr.uri) {
                const masterTrackUri = curr.uri;
                if (masterTrackUri !== currentlyPlayingTrack.spotifyUri) {
                    // Attempt to play the correct track for the master user
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
                    
                    // Pop next track from queue
                    if (submittedTracks.length > 0) {
                        currentlyPlayingTrack = submittedTracks.shift()!;
                        saveTracksToFile();
                        logger.info(`Now playing: ${currentlyPlayingTrack.name || currentlyPlayingTrack.spotifyUri}`);
                        masterTrackStarted = false; // Reset flag for new track
                        
                        // Play the new track for all sessions with session_play mode
                        for (const [sid, sess] of sessions.entries()) {
                            const sessionMode = sessionModes.get(sid);
                            if (sessionMode === 'session_play') {
                                const accessToken = sess.state?.spotify?.access_token;
                                if (accessToken) {
                                    try {
                                        await spotifyDelegate.play(accessToken, { uris: [currentlyPlayingTrack.spotifyUri] });
                                        logger.info(`Auto-started playback for session ${sid} (session_play mode)`);
                                    } catch (err) {
                                        logger.error(`Failed to auto-start playback for session ${sid}:`, err);
                                        const errMsg = getErrorMessage(err);
                                        if (errMsg.includes('NO_ACTIVE_DEVICE') || errMsg.includes('No active device found')) {
                                            notifyUserToActivateDevice(sid);
                                        }
                                    }
                                }
                            }
                        }
                        
                        // Broadcast updated track list and mode
                        broadcastTrackList();
                        broadcastMode();
                    } else {
                        // No more tracks in queue
                        currentlyPlayingTrack = null;
                        masterTrackStarted = false;
                        if (mode !== 'master_pause') {
                            mode = 'master_pause';
                            logger.info('No more tracks in queue, stopping playback');
                            broadcastTrackList();
                            broadcastMode();
                        }
                    }
                    // Before changing currentlyPlayingTrack, push to playHistory
                    if (currentlyPlayingTrack) {
                        playHistory.push({
                            timestamp: Date.now(),
                            track: { ...currentlyPlayingTrack },
                            startedBy: masterUserSessionId ? (sessions.get(masterUserSessionId)?.state?.spotify?.name || sessions.get(masterUserSessionId)?.state?.listener?.name || '') : undefined
                        });
                        broadcastPlayHistory();
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
                    }
                    broadcastMode();
                } else if (newState === 'pause' && mode !== 'master_pause') {
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
                    // Normal pause (not due to completion)
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
function startWebSocketServer(retries = 3, delay = 2000): void {
    try {
        if (webSocketServerStarted) {
            logger.info('WebSocket server already started');
            return;
        }
        webSocketServerStarted = true;
        logger.info(`Starting WebSocket server on port ${wsPort}`);

        const wss = new WebSocketServer({ port: wsPort });
        logger.info(`WebSocket server started on port ${wsPort}`);

        wss.on('connection', (ws: WebSocket) => {
            let sessionId: string = '';
            let session: Session | null = null;

            // Wait for login message to associate session
            ws.on('message', async (data: Buffer) => {
                try {
                    const message: Message = JSON.parse(data.toString());
                    switch (message.type) {
                        case 'login':
                            sessionId = message.userId || '';
                            if (sessionId && sessions.has(sessionId)) {
                                session = sessions.get(sessionId)!;
                                session.ws = ws;
                                logger.info(`Reusing session: ${sessionId}`);
                            } else if (sessionId) {
                                session = { ws, userId: sessionId, state: {} };
                                sessions.set(sessionId, session);
                                logger.info(`Created new session: ${sessionId}`);
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
                            assignMasterUserIfNeeded();
                                    ws.send(JSON.stringify({
                                        type: 'login_success',
                                        sessionId,
                                        userId: message.userId
                                    }));
                            // Send initial state
                            ws.send(JSON.stringify({
                                type: 'tracks_list',
                                tracks: submittedTracks.map(t => ({
                                    spotifyUri: t.spotifyUri,
                                    userEmail: t.userEmail,
                                    spotifyName: t.spotifyName,
                                    name: t.name,
                                    artist: t.artist,
                                    album: t.album,
                                    albumArtUrl: t.albumArtUrl,
                                    jammers: t.jammers || []
                                }))
                            }));
                            ws.send(JSON.stringify({
                                type: 'mode',
                                mode,
                                currentlyPlayingTrack,
                                masterUserSessionId,
                            }));
                            if (sessionId) sendSessionMode(sessionId);
                            broadcastSessionList();
                            serializeSessions();
                            break;
                        case 'get_tracks':
                            // Respond with the current track list
                            ws.send(JSON.stringify({
                                type: 'tracks_list',
                                tracks: submittedTracks.map(t => ({
                                    spotifyUri: t.spotifyUri,
                                    userEmail: t.userEmail,
                                    spotifyName: t.spotifyName,
                                    name: t.name,
                                    artist: t.artist,
                                    album: t.album,
                                    albumArtUrl: t.albumArtUrl,
                                    jammers: t.jammers || []
                                }))
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
                                const trackIndex = submittedTracks.findIndex(t => t.spotifyUri === message.spotifyUri);
                                if (trackIndex !== -1) {
                                    const removedTrack = submittedTracks.splice(trackIndex, 1)[0];
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
                                if (!jammerEmail) return; // Don't allow jam if no email
                                // Update in queue
                                const track = submittedTracks.find(t => t.spotifyUri === message.spotifyUri);
                                let jammed = false;
                                if (track) {
                                    if (!Array.isArray(track.jammers)) track.jammers = [];
                                    const idx = track.jammers.indexOf(jammerEmail);
                                    if (idx === -1) {
                                        track.jammers.push(jammerEmail);
                                        updated = true;
                                        jammed = true;
                                    } else {
                                        track.jammers.splice(idx, 1);
                                        updated = true;
                                        jammed = false;
                                    }
                                }
                                // Update currently playing track if it matches
                                if (
                                    currentlyPlayingTrack &&
                                    currentlyPlayingTrack.spotifyUri === message.spotifyUri
                                ) {
                                    if (!Array.isArray(currentlyPlayingTrack.jammers)) currentlyPlayingTrack.jammers = [];
                                    const idx = currentlyPlayingTrack.jammers.indexOf(jammerEmail);
                                    if (idx === -1) {
                                        currentlyPlayingTrack.jammers.push(jammerEmail);
                                        updated = true;
                                        jammed = true;
                                    } else {
                                        currentlyPlayingTrack.jammers.splice(idx, 1);
                                        updated = true;
                                        jammed = false;
                                    }
                                }
                                if (updated) {
                                    logger.info(`User ${jammerEmail} toggled jam for track ${message.spotifyUri}`);
                                    const jammerName = jammerSession?.state?.spotify?.name || jammerSession?.state?.listener?.name || 'Unknown';
                                    history.push({
                                        type: jammed ? 'jam' : 'unjam',
                                        timestamp: Date.now(),
                                        userName: jammerName,
                                        userEmail: jammerEmail,
                                        details: { track: (track?.name || currentlyPlayingTrack?.name || message.spotifyUri), jammed }
                                    });
                                    broadcastTrackList();
                                    broadcastMode();
                                    broadcastHistory();
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
                                // If no currently playing track, pop the first from the queue
                                if (!currentlyPlayingTrack && submittedTracks.length > 0) {
                                    currentlyPlayingTrack = submittedTracks.shift()!;
                                    saveTracksToFile();
                                    logger.info(`Now playing: ${currentlyPlayingTrack.name || currentlyPlayingTrack.spotifyUri}`);
                                    broadcastTrackList();
                                }
                                // Play/resume the current track on Spotify for each session
                                if (currentlyPlayingTrack && currentlyPlayingTrack.spotifyUri) {
                                    for (const [sid, sess] of sessions.entries()) {
                                        const accessToken = sess.state?.spotify?.access_token;
                                        if (accessToken) {
                                            try {
                                                let playOptions: any = { uris: [currentlyPlayingTrack.spotifyUri] };
                                                if (currentlyPlayingTrack.progress && currentlyPlayingTrack.progress.position_ms > 0) {
                                                    playOptions.position_ms = currentlyPlayingTrack.progress.position_ms;
                                                }
                                                await spotifyDelegate.play(accessToken, playOptions);
                                                logger.info(`Started playback for session ${sid} from ${playOptions.position_ms ? `position ${playOptions.position_ms}` : 'beginning'}`);
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
                                if (submittedTracks.length > 0) {
                                    currentlyPlayingTrack = submittedTracks.shift()!;
                                    saveTracksToFile();
                                    masterTrackStarted = false;
                                    // Play the new track for all sessions with session_play mode
                                    for (const [sid, sess] of sessions.entries()) {
                                        const sessionMode = sessionModes.get(sid);
                                        if (sessionMode === 'session_play') {
                                            const accessToken = sess.state?.spotify?.access_token;
                                            if (accessToken) {
                                                try {
                                                    await spotifyDelegate.play(accessToken, { uris: [currentlyPlayingTrack.spotifyUri] });
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
                    }
                } catch (error) {
                    logger.error('Error processing message:', error);
                }
            });

            // Handle disconnection
            ws.on('close', () => {
                if (sessionId) {
                    logger.info(`Session ${sessionId} disconnected, scheduling cleanup.`);
                    // Schedule session removal after 60 seconds
                    const timer = setTimeout(() => {
                sessions.delete(sessionId);
                        sessionCleanupTimers.delete(sessionId);
                        logger.info(`Session ${sessionId} removed after timeout.`);
                        broadcastSessionList();
                    }, 60000);
                    sessionCleanupTimers.set(sessionId, timer);
                }
            });
        });

        // Handle server errors
        wss.on('error', (error) => {
            logger.error('WebSocket server error:', error);
        });

    } catch (error) {
        if (retries > 0) {
            logger.info(`Failed to start WebSocket server. Retrying in ${delay/1000} seconds... (${retries} attempts remaining)`);
            setTimeout(() => startWebSocketServer(retries - 1, delay), delay);
        } else {
            logger.error('Failed to start WebSocket server after multiple attempts:', error);
            process.exit(1);
        }
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
    const { trackId: spotifyUri, sessionId } = req.body;
    if (!spotifyUri || !sessionId) {
        res.status(400).json({ error: 'Spotify URI and sessionId are required' });
        return;
    }
    // Prevent duplicate tracks
    if (submittedTracks.some(t => t.spotifyUri === spotifyUri)) {
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
    fairInsertTrack({ spotifyUri, userEmail: submitterEmail, spotifyName: submitterName, timestamp: Date.now(), ...trackInfo }, submittedTracks);
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
    const session = sessions.get(sessionId);
    if (
        session &&
        session.state &&
        (
            (session.state.spotify && session.state.spotify.access_token) ||
            (session.state.listener && session.state.listener.name && session.state.listener.email)
        )
    ) {
        res.json({ loggedIn: true });
    } else {
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
        state: { listener: { name, email } }
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
        airhornsDir: path.join(__dirname, '../../frontend/public/airhorns'),
        // Add other config values here as needed
    };
    static get(key: keyof typeof Config.config) {
        return Config.config[key];
    }
}

// REST endpoint to list available airhorns
app.get('/api/airhorns', (req: Request, res: Response) => {
    const airhornDir = Config.get('airhornsDir');
    let airhorns: string[] = [];
    try {
        airhorns = fs.readdirSync(airhornDir)
            .filter(f => f.endsWith('.mp3'))
            .map(f => f.replace(/\.mp3$/, ''));
    } catch (err) {
        res.status(500).json({ error: 'Failed to read airhorns directory' });
        return;
    }
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
            if (submittedTracks.some(t => t.spotifyUri === track.spotifyUri)) continue;
            submittedTracks.push({
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

// Start HTTP server
(async () => {
  await loadSessionsFromFile();
  loadTracksFromFile();
  cleanupInvalidSessions();
app.listen(port, () => {
    logger.info(`HTTP Server is running on port ${port}`);
    // Start WebSocket server after HTTP server is running
    startWebSocketServer(); 
}); 
})(); 

function broadcastHistory() {
    const historyList = history.slice(-100); // Limit to last 100 events
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
                    const session = { ws: null, userId, state };
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

// Helper to fairly insert a track into the queue
function fairInsertTrack(track: SubmittedTrack, queue: SubmittedTrack[]) {
    // Count tracks per user
    const userCounts: Record<string, number> = {};
    for (const t of queue) {
        if (!t.userEmail) continue;
        userCounts[t.userEmail] = (userCounts[t.userEmail] || 0) + 1;
    }
    const thisUser = track.userEmail;
    const thisUserCount = thisUser ? (userCounts[thisUser] || 0) : 0;
    // Find the minimum count among all users (excluding this user if they have 0)
    let minCount = Infinity;
    for (const sid in userCounts) {
        if (sid !== thisUser && userCounts[sid] < minCount) {
            minCount = userCounts[sid];
        }
    }
    if (minCount === Infinity) minCount = 0;
    // Find the last index where this user has a track
    let lastUserIdx = -1;
    let userSeen = 0;
    for (let i = 0; i < queue.length; ++i) {
        if (queue[i].userEmail === thisUser) {
            userSeen++;
            if (userSeen === thisUserCount) {
                lastUserIdx = i;
            }
        }
    }
    // Find the first index after all tracks from users with fewer tracks
    let insertIdx = queue.length;
    if (thisUserCount > minCount) {
        // Find the last index where a user with minCount tracks appears
        const counts: Record<string, number> = { ...userCounts };
        for (let i = 0; i < queue.length; ++i) {
            const sid = queue[i].userEmail;
            if (sid && counts[sid] === minCount) {
                insertIdx = i + 1;
            }
        }
    }
    // Insert after the last track from this user, but not before insertIdx
    const finalIdx = Math.max(lastUserIdx + 1, insertIdx);
    queue.splice(finalIdx, 0, track);
} 

// Log all configured values at startup
logger.info('Configured values:');
logger.info(`  HTTP port: ${port}`);
logger.info(`  WebSocket port: ${wsPort}`);
logger.info(`  POLL_INTERVAL_MS: ${POLL_INTERVAL_MS}`);
logger.info(`  DEBUG: ${DEBUG}`);
logger.info(`  Tracks file: ${TRACKS_FILE}`);
logger.info(`  Sessions file: ${SESSIONS_FILE}`); 

export { fairInsertTrack }; 