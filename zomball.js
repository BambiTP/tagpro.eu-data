const decoder = require('./decoder.js');

// --- CORE ZOMBALL PROCESSOR ---
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
            validPlayersTagged: [],
            invalidTagsThisStint: 0,
            invalidPlayersTagged: []
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

    // Lookahead Map for zombie tags
    const zombieTagsByFrame = {};
    // Per-tagger queue of resolved {playerTagged, validTag} — filled during pop processing, consumed post-loop
    const resolvedTagsByTagger = {};
    for (const e of allEvents) {
        if (e.type === 'tag') {
            const roundedTime = Math.round(e.time);
            if (!zombieTagsByFrame[roundedTime]) zombieTagsByFrame[roundedTime] = [];
            zombieTagsByFrame[roundedTime].push(e.playerName);
        }
    }

    let zombieCount = Object.values(playerStates).filter(s => s.team === 2).length;
    let survivorCount = Object.values(playerStates).filter(s => s.team === 1).length;
    
    maxZombiesBeforeFirstValidPop = zombieCount;

    timeline.push({ time: 0, timeString: "0:00.00", zombieCount, survivorCount, type: "match_start" });

    const closeStint = (pName, team, endTime, forceSpawnKill = null, killedBy = "map") => {
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
                killedBy: killedBy,
                powerupsCollected: Array.from(pState.powerups)
            });
        } else if (team === 2 && duration > 0) {
            playersData[pName].zombieStints.push({
                joinedZombieAt: pState.currentStintStart,
                leftZombieAt: endTime,
                validTags: pState.validTagsThisStint,
                validPlayersTagged: [...pState.validPlayersTagged],
                invalidTags: pState.invalidTagsThisStint,
                invalidPlayersTagged: [...pState.invalidPlayersTagged]
            });
        }
    };

    // 3. Process Events Frame by Frame
    for (const e of allEvents) {
        const pState = playerStates[e.playerName];
        const pName = e.playerName;
        const timeStr = toMMSScc(e.time);

        // -- Handle Team Changes --
        if (e.type === 'join' || e.type === 'switch' || e.type === 'quit') {
            const oldTeam = pState.team;
            const newTeam = e.type === 'quit' ? 0 : e.team;

            closeStint(pName, oldTeam, e.time);

            if (oldTeam === 1) survivorCount--;
            if (oldTeam === 2) zombieCount--;
            if (newTeam === 1) survivorCount++;
            if (newTeam === 2) zombieCount++;
            
            if (!hasSeenValidPop) {
                maxZombiesBeforeFirstValidPop = Math.max(maxZombiesBeforeFirstValidPop, zombieCount);
            }

            pState.team = newTeam;
            pState.currentStintStart = e.time;
            pState.powerups.clear();
            pState.validTagsThisStint = 0;
            pState.validPlayersTagged = [];
            pState.invalidTagsThisStint = 0;
            pState.invalidPlayersTagged = [];

            timeline.push({
                time: e.time, timeString: timeStr, player: pName,
                type: newTeam === 1 ? 'join_survivor' : newTeam === 2 ? 'join_zombie' : 'spec_or_quit',
                team: newTeam,
                teamName: newTeam === 1 ? 'survivor' : newTeam === 2 ? 'zombie' : 'spectator',
                zombieCount, survivorCount
            });
        }

        // -- Handle Tags --
        if (e.type === 'tag') {
            timeline.push({
                time: e.time,
                timeString: timeStr,
                player: pName,
                type: 'tag',
                tagsCount: 1,
                team: pState.team,
                teamName: pState.team === 1 ? 'survivor' : pState.team === 2 ? 'zombie' : 'spectator',
                zombieCount,
                survivorCount
            });
        }

        // -- Handle All Pops --
        if (e.type === 'pop') {
            const duration = e.time - pState.currentStintStart;
            let typeStr = 'pop'; 
            let killerName = "map"; 
            
            if (pState.team === 1) {
                const isSpawnKill = duration < 300 || zombieCount === 0; 
                typeStr = isSpawnKill ? 'invalid_pop' : 'valid_pop';
                
                if (typeStr === 'valid_pop') hasSeenValidPop = true;

                // Always search for a tag event to "consume" it from the timeline, 
                // preventing phantom stats from polluting later kills.
                let foundTagger = "map";
                const searchWindow = 300; 
                let closestDist = Infinity;
                let bestFrame = -1;

                for (const frame in zombieTagsByFrame) {
                    const diff = Math.abs(parseInt(frame) - e.time);
                    if (diff <= searchWindow && diff < closestDist) {
                        const hasValidKiller = zombieTagsByFrame[frame].some(name => 
                            name !== pName && playerStates[name] && playerStates[name].team === 2
                        );
                        if (hasValidKiller) {
                            closestDist = diff;
                            bestFrame = frame;
                        }
                    }
                }
                
                // If we found a raw tag in the timeframe, remove it from the lookahead array
                if (bestFrame !== -1) {
                    const idx = zombieTagsByFrame[bestFrame].findIndex(name => 
                        name !== pName && playerStates[name] && playerStates[name].team === 2
                    );
                    if (idx !== -1) {
                        foundTagger = zombieTagsByFrame[bestFrame].splice(idx, 1)[0];
                    }
                }

                // If it was a valid pop, credit the tagger. Otherwise, throw it away.
                if (typeStr === 'valid_pop') {
                    if (foundTagger !== "map") {
                        killerName = foundTagger;
                        if (!resolvedTagsByTagger[killerName]) resolvedTagsByTagger[killerName] = [];
                        resolvedTagsByTagger[killerName].push({ playerTagged: pName, validTag: true });
                    } else {
                        // Fallback: If no tag was found, but exactly one zombie is alive, credit them
                        // No resolution recorded — the fallback has no corresponding tag event to annotate
                        const currentZombies = Object.keys(playerStates).filter(name => playerStates[name].team === 2);
                        if (currentZombies.length === 1) {
                            killerName = currentZombies[0];
                        }
                    }

                    if (killerName !== "map" && playerStates[killerName]) {
                        playerStates[killerName].validPlayersTagged.push(pName);
                        playerStates[killerName].validTagsThisStint++;
                    }
                } else if (foundTagger !== "map" && playerStates[foundTagger]) {
                    playerStates[foundTagger].invalidTagsThisStint++;
                    playerStates[foundTagger].invalidPlayersTagged.push(pName);
                    if (!resolvedTagsByTagger[foundTagger]) resolvedTagsByTagger[foundTagger] = [];
                    resolvedTagsByTagger[foundTagger].push({ playerTagged: pName, validTag: false });
                }
                
                closeStint(pName, 1, e.time, isSpawnKill, killerName);
                pState.currentStintStart = e.time; 
            }

            timeline.push({
                time: e.time, 
                timeString: timeStr, 
                player: pName,
                type: typeStr,
                team: pState.team,
                teamName: pState.team === 1 ? 'survivor' : pState.team === 2 ? 'zombie' : 'spectator',
                taggedBy: killerName, 
                zombieCount, 
                survivorCount
            });

            if (pState.team === 1 && typeStr === 'valid_pop' && survivorCount === 1) {
                lastSurvivorPopTime = e.time;
                lastSurvivorPopTimeString = timeStr;
                
                timeline.push({
                    time: e.time,
                    timeString: timeStr,
                    type: "match_over",
                    message: "Last survivor popped."
                });
                break;
            }
        }

        // -- Handle Powerups --
        if (e.type === 'powerup') {
            pState.powerups.add({ 1: 'juke juice', 2: 'speed', 4: 'grip', 8: 'bomb' }[e.power] || `power ${e.power}`);
        }
    }

    const matchEndTime = lastSurvivorPopTime !== null 
        ? lastSurvivorPopTime 
        : (match.duration || (allEvents.length ? allEvents[allEvents.length - 1].time : 0));
        
    for (const pName of Object.keys(playerStates)) {
        closeStint(pName, playerStates[pName].team, matchEndTime);
    }

    for (const entry of timeline) {
        if (entry.type === 'tag') {
            const queue = resolvedTagsByTagger[entry.player];
            const resolution = queue && queue.shift();
            entry.playerTagged = resolution ? resolution.playerTagged : null;
            entry.validTag = resolution ? resolution.validTag : false;
        }
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

module.exports = { processZomballMatch };
