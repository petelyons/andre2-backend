import logger from './logger';
import { spotifyDelegate } from './spotify';

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

// Default fallback playlist (Spotify's "Lorem" playlist)
const DEFAULT_FALLBACK_PLAYLIST = 'spotify:playlist:37i9dQZF1DWUoqEG4WY6ce';

/**
 * Manages the music queue including user-submitted tracks and fallback playlist tracks
 */
export class QueueManager {
    private submittedTracks: SubmittedTrack[] = [];
    private fallbackQueue: SubmittedTrack[] = [];
    private currentFallbackPlaylistUrl: string = '';
    private currentFallbackPlaylistName: string = '';

    constructor(initialFallbackUrl?: string) {
        this.currentFallbackPlaylistUrl = initialFallbackUrl || DEFAULT_FALLBACK_PLAYLIST;
    }

    /**
     * Get the current fallback playlist URL
     */
    getFallbackPlaylistUrl(): string {
        return this.currentFallbackPlaylistUrl;
    }

    /**
     * Get the current fallback playlist name
     */
    getFallbackPlaylistName(): string {
        return this.currentFallbackPlaylistName;
    }

    /**
     * Get fallback playlist info for broadcasting to clients
     */
    getFallbackInfo(): { url: string; name: string; trackCount: number } | null {
        if (!this.currentFallbackPlaylistUrl) {
            return null;
        }
        return {
            url: this.currentFallbackPlaylistUrl,
            name: this.currentFallbackPlaylistName || 'Fallback Playlist',
            trackCount: this.fallbackQueue.length
        };
    }

    /**
     * Get all submitted tracks
     */
    getSubmittedTracks(): SubmittedTrack[] {
        return this.submittedTracks;
    }

    /**
     * Get all fallback tracks
     */
    getFallbackTracks(): SubmittedTrack[] {
        return this.fallbackQueue;
    }

    /**
     * Get the count of submitted tracks
     */
    getSubmittedCount(): number {
        return this.submittedTracks.length;
    }

    /**
     * Get the count of fallback tracks
     */
    getFallbackCount(): number {
        return this.fallbackQueue.length;
    }

    /**
     * Check if a track already exists in the submitted queue
     */
    hasTrack(spotifyUri: string): boolean {
        return this.submittedTracks.some(t => t.spotifyUri === spotifyUri);
    }

    /**
     * Add a track to the queue using fair insertion algorithm
     */
    addTrack(track: SubmittedTrack): void {
        this.fairInsertTrack(track);
    }

    /**
     * Remove a track from the queue by URI
     */
    removeTrack(spotifyUri: string): SubmittedTrack | null {
        const trackIndex = this.submittedTracks.findIndex(t => t.spotifyUri === spotifyUri);
        if (trackIndex !== -1) {
            return this.submittedTracks.splice(trackIndex, 1)[0];
        }
        return null;
    }

    /**
     * Get the next track to play (prioritizes submitted tracks over fallback)
     * Returns null if no tracks available
     */
    async getNextTrack(accessToken?: string): Promise<{ track: SubmittedTrack; isFallback: boolean } | null> {
        // First check submitted tracks
        if (this.submittedTracks.length > 0) {
            const track = this.submittedTracks.shift()!;
            return { track, isFallback: false };
        }

        // Then check fallback queue
        if (this.fallbackQueue.length > 0) {
            const track = this.fallbackQueue.shift()!;
            
            // If fallback queue is now empty, reload it
            if (this.fallbackQueue.length === 0 && this.currentFallbackPlaylistUrl && accessToken) {
                logger.info('Fallback queue empty, reloading from playlist');
                await this.loadFallbackPlaylist(this.currentFallbackPlaylistUrl, accessToken);
            }
            
            return { track, isFallback: true };
        }

        // No tracks available - try to load fallback if not loaded yet
        if (this.fallbackQueue.length === 0 && this.currentFallbackPlaylistUrl && accessToken) {
            logger.info('No tracks in fallback queue, attempting to load from playlist');
            const success = await this.loadFallbackPlaylist(this.currentFallbackPlaylistUrl, accessToken);
            if (success && this.fallbackQueue.length > 0) {
                const track = this.fallbackQueue.shift()!;
                return { track, isFallback: true };
            }
        }

        logger.info(`No tracks available. Fallback queue: ${this.fallbackQueue.length}, Fallback URL: ${this.currentFallbackPlaylistUrl}, Has token: ${!!accessToken}`);
        return null;
    }

    /**
     * Load tracks from a fallback playlist
     */
    async loadFallbackPlaylist(playlistUrl: string, accessToken: string): Promise<boolean> {
        if (!playlistUrl) {
            logger.warn('No fallback playlist URL provided');
            return false;
        }

        const playlistId = spotifyDelegate.extractPlaylistId(playlistUrl);
        if (!playlistId) {
            logger.error('Invalid fallback playlist URL:', playlistUrl);
            return false;
        }

        if (!accessToken) {
            logger.warn('No access token available to load fallback playlist');
            return false;
        }

        try {
            logger.info(`Loading fallback playlist: ${playlistUrl} (ID: ${playlistId})`);
            
            // Fetch playlist info and tracks
            const [playlistInfo, tracks] = await Promise.all([
                spotifyDelegate.getPlaylistInfo(accessToken, playlistId),
                spotifyDelegate.getPlaylistTracks(accessToken, playlistId)
            ]);

            // Clear existing fallback queue and populate with new tracks
            this.fallbackQueue.length = 0;
            for (const track of tracks) {
                this.fallbackQueue.push({
                    spotifyUri: track.spotifyUri,
                    userEmail: 'fallback@system',
                    spotifyName: 'Fallback Playlist',
                    timestamp: Date.now(),
                    name: track.name,
                    artist: track.artist,
                    album: track.album,
                    albumArtUrl: track.albumArtUrl
                });
            }

            this.currentFallbackPlaylistUrl = playlistUrl;
            this.currentFallbackPlaylistName = playlistInfo.name;
            logger.info(`Loaded ${this.fallbackQueue.length} tracks from fallback playlist "${playlistInfo.name}"`);
            return true;
        } catch (err) {
            logger.error('Failed to load fallback playlist:', err);
            return false;
        }
    }

    /**
     * Check if a string is a playlist URL
     */
    isPlaylistUrl(url: string): boolean {
        return spotifyDelegate.extractPlaylistId(url) !== null;
    }

    /**
     * Set the submitted tracks (used for loading from disk)
     */
    setSubmittedTracks(tracks: SubmittedTrack[]): void {
        this.submittedTracks = tracks;
    }

    /**
     * Clear all tracks from the queue
     */
    clear(): void {
        this.submittedTracks.length = 0;
    }

    /**
     * Fair insertion algorithm - ensures even distribution of tracks among users
     */
    private fairInsertTrack(track: SubmittedTrack): void {
        // Count tracks per user
        const userCounts: Record<string, number> = {};
        for (const t of this.submittedTracks) {
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
        for (let i = 0; i < this.submittedTracks.length; ++i) {
            if (this.submittedTracks[i].userEmail === thisUser) {
                userSeen++;
                if (userSeen === thisUserCount) {
                    lastUserIdx = i;
                }
            }
        }

        // Find the first index after all tracks from users with fewer tracks
        let insertIdx = this.submittedTracks.length;
        if (thisUserCount > minCount) {
            // Find the last index where a user with minCount tracks appears
            const counts: Record<string, number> = { ...userCounts };
            for (let i = 0; i < this.submittedTracks.length; ++i) {
                const sid = this.submittedTracks[i].userEmail;
                if (sid && counts[sid] === minCount) {
                    insertIdx = i + 1;
                }
            }
        }

        // Insert after the last track from this user, but not before insertIdx
        const finalIdx = Math.max(lastUserIdx + 1, insertIdx);
        this.submittedTracks.splice(finalIdx, 0, track);
    }
}

