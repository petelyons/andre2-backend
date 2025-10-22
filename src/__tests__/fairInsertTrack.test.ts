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

    test('inserts new user after all others', () => {
        const qm = new QueueManager();
        qm.setSubmittedTracks([
            { spotifyUri: 'uri1', userEmail: 'a@email.com', spotifyName: 'A', timestamp: 1 },
            { spotifyUri: 'uri2', userEmail: 'a@email.com', spotifyName: 'A', timestamp: 2 },
        ]);
        const newTrack: SubmittedTrack = { spotifyUri: 'uri3', userEmail: 'b@email.com', spotifyName: 'B', timestamp: 3 };
        qm.addTrack(newTrack);
        expect(qm.getSubmittedTracks().map(t => t.spotifyUri)).toEqual(['uri1', 'uri2', 'uri3']);
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

    console.log(`\nTest Results: ${passed} passed, ${failed} failed`);
    return { passed, failed };
}

// Run tests if this file is executed directly
if (require.main === module) {
    runTests();
}

export { runTests }; 