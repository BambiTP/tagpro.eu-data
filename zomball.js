const decoder = require('./decoder.js');

// --- CORE ZOMBALL PROCESSOR ---
// This function takes a raw match object from the decoder and converts it 
// into our enriched data structure.
function processZomballMatch(match) {
    const timeline = [];
    const playersData = {};
    const playerStates = {};
    
    let lastSurvivorPopTime = null;
    let lastSurvivorPopTimeString = null;

    let hasSeenValidPop = false;
    let maxZombiesBeforeFirstValidPop = 0;

    const toMMSScc = frames => {
        const m = Math.floor(frames / 3600);
        const s = Math.floor(frames % 3600 / 60);
        const cc = Math.round(frames % 60 / 0.6).toString().padStart(2, '0');
        return `${m}:${s.toString().padStart(2, '0')}.${cc}`;
    };

    // 1. Initialize Player States & Data Object
    for (const p of match.players) {
        playersData[p.name] = { name: p.name, humanStints: [], zombieStints: [] };
        playerStates[p.name] = {
            team: p.team,
            currentStintStart: 0,
            powerups: new Set(),
            validTagsThisStint: 0,
            invalidTagsThisStint: 0
        };
    }

    // 2. Flatten and Chronologically Sort All Events
    const allEvents = [];
    for (const p of match.players) {
        for (const e of p.events) {
            allEvents.push({ ...e, playerName: p.name });
        }
    }
    allEvents.sort((a, b) => a.time - b.time);

    let zombieCount = Object.values(playerStates).filter(s => s.team === 2).length;
    let survivorCount = Object.values(playerStates).filter(s => s.team === 1).length;
    
    // Initialize our pre-infection tracker with the starting team counts
    maxZombiesBeforeFirstValidPop = zombieCount;

    timeline.push({ time: 0, timeString: "0:00.00", zombieCount, survivorCount, type: "match_start" });

    // Helper to close and save a player's stint
    const closeStint = (pName, team, endTime, forceSpawnKill = null) => {
        const pState = playerStates[pName];
        const duration = endTime - pState.currentStintStart;
        
        if (team === 1 && duration > 0) {
            const isSpawnKill = forceSpawnKill !== null ? forceSpawnKill : duration < 300;
            playersData[pName].humanStints.push({
                spawnTime: pState.currentStintStart,
                deathTime: endTime,
                durationFrames: duration,
                isSpawnKill: isSpawnKill,
                zombiesOnDeath: zombieCount,
                powerupsCollected: Array.from(pState.powerups)
            });
        } else if (team === 2 && duration > 0) {
            playersData[pName].zombieStints.push({
                joinedZombieAt: pState.currentStintStart,
                leftZombieAt: endTime,
                validTags: pState.validTagsThisStint,
                invalidTags: pState.invalidTagsThisStint
            });
        }
    };

    // 3. Process Events Frame by Frame
    for (const e of allEvents) {
        const pState = playerStates[e.playerName];
        const pName = e.playerName;
        const timeStr = toMMSScc(e.time);

        // -- Handle Team Changes --
        if (e.team !== undefined && e.team !== pState.team) {
            const oldTeam = pState.team;
            const newTeam = e.team;

            closeStint(pName, oldTeam, e.time);

            if (oldTeam === 1) survivorCount--;
            if (oldTeam === 2) zombieCount--;
            if (newTeam === 1) survivorCount++;
            if (newTeam === 2) zombieCount++;
            
            // If we haven't seen a real infection yet, keep tracking the highest number of zombies
            if (!hasSeenValidPop) {
                maxZombiesBeforeFirstValidPop = Math.max(maxZombiesBeforeFirstValidPop, zombieCount);
            }

            pState.team = newTeam;
            pState.currentStintStart = e.time;
            pState.powerups.clear();
            pState.validTagsThisStint = 0;
            pState.invalidTagsThisStint = 0;

            timeline.push({
                time: e.time, timeString: timeStr, player: pName,
                type: newTeam === 1 ? 'join_survivor' : newTeam === 2 ? 'join_zombie' : 'spec_or_quit',
                team: newTeam,
                teamName: newTeam === 1 ? 'survivor' : newTeam === 2 ? 'zombie' : 'spectator',
                zombieCount, survivorCount
            });
        }

        // -- Handle All Pops --
        if (e.dropPop) {
            const duration = e.time - pState.currentStintStart;
            let typeStr = 'pop'; 
            
            if (pState.team === 1) {
                // Rule: If under 5 seconds OR there are 0 zombies, it's an invalid pop
                const isSpawnKill = duration < 300 || zombieCount === 0; 
                typeStr = isSpawnKill ? 'invalid_pop' : 'valid_pop';
                
                if (typeStr === 'valid_pop') {
                    hasSeenValidPop = true;
                }
                
                closeStint(pName, 1, e.time, isSpawnKill);
                pState.currentStintStart = e.time; 
            }

            timeline.push({
                time: e.time, 
                timeString: timeStr, 
                player: pName,
                type: typeStr,
                team: pState.team,
                teamName: pState.team === 1 ? 'survivor' : pState.team === 2 ? 'zombie' : 'spectator',
                zombieCount, 
                survivorCount
            });

            // Rule: Stop processing if this was the last survivor taking a valid pop
            if (pState.team === 1 && typeStr === 'valid_pop' && survivorCount === 1) {
                lastSurvivorPopTime = e.time;
                lastSurvivorPopTimeString = timeStr;
                
                timeline.push({
                    time: e.time,
                    timeString: timeStr,
                    type: "match_over",
                    message: "Last survivor popped."
                });
                
                break; // Exit the event loop entirely
            }
        }

        // -- Handle Zombie Tags --
        if (e.tags > 0 && pState.team === 2) {
            const simultaneousPops = timeline.filter(t => t.time === e.time && t.type === 'invalid_pop');
            const wasSpawnKillTag = simultaneousPops.length > 0;

            if (wasSpawnKillTag) {
                pState.invalidTagsThisStint += e.tags;
            } else {
                pState.validTagsThisStint += e.tags;
            }
        }

        // -- Handle Powerups --
        for (const bit of [1, 2, 4, 8]) {
            if (e.powersUp & bit) pState.powerups.add({ 1: 'juke juice', 2: 'speed', 4: 'grip', 8: 'bomb' }[bit] || `power ${bit}`);
        }
    }

    // 4. Wrap up any ongoing stints at the end of the match
    // If the game ended early due to the last survivor dying, use that time. Otherwise, use match duration.
    const matchEndTime = lastSurvivorPopTime !== null 
        ? lastSurvivorPopTime 
        : (match.duration || (allEvents.length ? allEvents[allEvents.length - 1].time : 0));
        
    for (const pName of Object.keys(playerStates)) {
        closeStint(pName, playerStates[pName].team, matchEndTime);
    }

    return { 
        multipleStartingZombies: maxZombiesBeforeFirstValidPop > 1,
        startingZombieCount: maxZombiesBeforeFirstValidPop,
        timeline, 
        players: playersData, 
        lastSurvivorPopTime, 
        lastSurvivorPopTimeString 
    };
}


module.exports = {processZomballMatch};
