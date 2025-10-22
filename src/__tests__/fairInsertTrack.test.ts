import { QueueManager, SubmittedTrack } from '../queueManager';

// Simple test runner
function runTests() {
    let passed = 0;
    let failed = 0;

    function test(name: string, testFn: () => void) {
        try {
            testFn();
            console.log(`✅ ${name}`);
            passed++;
        } catch (error) {
            console.log(`❌ ${name}: ${error}`);
            failed++;
        }
    }

    function expect(actual: any) {
        return {
            toEqual: (expected: any) => {
                if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
                }
            },
            toBe: (expected: any) => {
                if (actual !== expected) {
                    throw new Error(`Expected ${expected}, got ${actual}`);
                }
            }
        };
    }

    // Test cases
    test('inserts first track for a user', () => {
        const qm = new QueueManager();
        const track: SubmittedTrack = { spotifyUri: 'uri1', userEmail: 'a@email.com', spotifyName: 'A', timestamp: 1 };
        qm.addTrack(track);
        expect(qm.getSubmittedTracks()).toEqual([track]);
    });

    test('alternates between users (round robin)', () => {
        const qm = new QueueManager();
        qm.setSubmittedTracks([
            { spotifyUri: 'uri1', userEmail: 'a@email.com', spotifyName: 'A', timestamp: 1 },
            { spotifyUri: 'uri2', userEmail: 'b@email.com', spotifyName: 'B', timestamp: 2 },
        ]);
        const newTrack: SubmittedTrack = { spotifyUri: 'uri3', userEmail: 'a@email.com', spotifyName: 'A', timestamp: 3 };
        qm.addTrack(newTrack);
        expect(qm.getSubmittedTracks().map(t => t.spotifyUri)).toEqual(['uri1', 'uri2', 'uri3']);
    });

    test('new user joins a single-user queue: insert after first round', () => {
        const qm = new QueueManager();
        qm.setSubmittedTracks([
            { spotifyUri: 'uri1', userEmail: 'a@email.com', spotifyName: 'A', timestamp: 1 },
            { spotifyUri: 'uri2', userEmail: 'a@email.com', spotifyName: 'A', timestamp: 2 },
        ]);
        const newTrack: SubmittedTrack = { spotifyUri: 'uri3', userEmail: 'b@email.com', spotifyName: 'B', timestamp: 3 };
        qm.addTrack(newTrack);
        // Expect B to be placed after first A: [A, B, A]
        expect(qm.getSubmittedTracks().map(t => t.spotifyUri)).toEqual(['uri1', 'uri3', 'uri2']);
    });

    test('keeps fairness when one user has more tracks', () => {
        const qm = new QueueManager();
        qm.setSubmittedTracks([
            { spotifyUri: 'uri1', userEmail: 'a@email.com', spotifyName: 'A', timestamp: 1 },
            { spotifyUri: 'uri2', userEmail: 'b@email.com', spotifyName: 'B', timestamp: 2 },
            { spotifyUri: 'uri3', userEmail: 'a@email.com', spotifyName: 'A', timestamp: 3 },
        ]);
        const newTrack: SubmittedTrack = { spotifyUri: 'uri4', userEmail: 'b@email.com', spotifyName: 'B', timestamp: 4 };
        qm.addTrack(newTrack);
        expect(qm.getSubmittedTracks().map(t => t.spotifyUri)).toEqual(['uri1', 'uri2', 'uri3', 'uri4']);
    });

    test('handles null userEmail gracefully', () => {
        const qm = new QueueManager();
        qm.setSubmittedTracks([
            { spotifyUri: 'uri1', userEmail: null, spotifyName: 'A', timestamp: 1 },
        ]);
        const newTrack: SubmittedTrack = { spotifyUri: 'uri2', userEmail: null, spotifyName: 'A', timestamp: 2 };
        qm.addTrack(newTrack);
        expect(qm.getSubmittedCount()).toBe(2);
    });

    // Regression: 5 tracks from user1, then user2 adds 1 → A,F,B,C,D,E
    test('user1 has A..E, user2 adds F → A,F,B,C,D,E', () => {
        const qm = new QueueManager();
        qm.setSubmittedTracks([
            { spotifyUri: 'A', userEmail: 'u1@example.com', spotifyName: 'U1', timestamp: 1 },
            { spotifyUri: 'B', userEmail: 'u1@example.com', spotifyName: 'U1', timestamp: 2 },
            { spotifyUri: 'C', userEmail: 'u1@example.com', spotifyName: 'U1', timestamp: 3 },
            { spotifyUri: 'D', userEmail: 'u1@example.com', spotifyName: 'U1', timestamp: 4 },
            { spotifyUri: 'E', userEmail: 'u1@example.com', spotifyName: 'U1', timestamp: 5 },
        ]);
        const f: SubmittedTrack = { spotifyUri: 'F', userEmail: 'u2@example.com', spotifyName: 'U2', timestamp: 6 };
        qm.addTrack(f);
        expect(qm.getSubmittedTracks().map(t => t.spotifyUri)).toEqual(['A','F','B','C','D','E']);
    });

    // New user (user3) joins when two users are present → goes after first track of user2
    test('user3 first track goes after user2 first track', () => {
        const qm = new QueueManager();
        // Pre-existing interleaved queue of user1 and user2
        qm.setSubmittedTracks([
            { spotifyUri: 'A1', userEmail: 'u1@example.com', spotifyName: 'U1', timestamp: 1 },
            { spotifyUri: 'B1', userEmail: 'u2@example.com', spotifyName: 'U2', timestamp: 2 },
            { spotifyUri: 'A2', userEmail: 'u1@example.com', spotifyName: 'U1', timestamp: 3 },
            { spotifyUri: 'B2', userEmail: 'u2@example.com', spotifyName: 'U2', timestamp: 4 },
            { spotifyUri: 'A3', userEmail: 'u1@example.com', spotifyName: 'U1', timestamp: 5 },
        ]);
        const c1: SubmittedTrack = { spotifyUri: 'C1', userEmail: 'u3@example.com', spotifyName: 'U3', timestamp: 6 };
        qm.addTrack(c1);
        expect(qm.getSubmittedTracks().map(t => t.spotifyUri)).toEqual(['A1','B1','C1','A2','B2','A3']);
    });

    // user3 second track goes after user2 second track
    test('user3 second track goes after user2 second track', () => {
        const qm = new QueueManager();
        qm.setSubmittedTracks([
            { spotifyUri: 'A1', userEmail: 'u1@example.com', spotifyName: 'U1', timestamp: 1 },
            { spotifyUri: 'B1', userEmail: 'u2@example.com', spotifyName: 'U2', timestamp: 2 },
            { spotifyUri: 'A2', userEmail: 'u1@example.com', spotifyName: 'U1', timestamp: 3 },
            { spotifyUri: 'B2', userEmail: 'u2@example.com', spotifyName: 'U2', timestamp: 4 },
            { spotifyUri: 'A3', userEmail: 'u1@example.com', spotifyName: 'U1', timestamp: 5 },
            { spotifyUri: 'C1', userEmail: 'u3@example.com', spotifyName: 'U3', timestamp: 6 },
        ]);
        const c2: SubmittedTrack = { spotifyUri: 'C2', userEmail: 'u3@example.com', spotifyName: 'U3', timestamp: 7 };
        qm.addTrack(c2);
        expect(qm.getSubmittedTracks().map(t => t.spotifyUri)).toEqual(['A1','B1','C1','A2','B2','C2','A3']);
    });

    console.log(`\nTest Results: ${passed} passed, ${failed} failed`);
    return { passed, failed };
}

// Run tests if this file is executed directly
if (require.main === module) {
    runTests();
}

export { runTests }; 