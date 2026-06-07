const fs = require('fs');

// --- Internal Utilities (Not Exported) ---

class LogReader {
    constructor(data) {
        this.data = data;
        this.pos = 0;
    }
    end() { return (this.pos >> 3) >= this.data.length; }
    readBool() {
        if (this.end()) return 0;
        const result = (this.data[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
        this.pos++;
        return result;
    }
    readFixed(bits) {
        let result = 0;
        while (bits--) result = (result << 1) | this.readBool();
        return result;
    }
    readTally() {
        let result = 0;
        while (this.readBool()) result++;
        return result;
    }
    readFooter() {
        let size = this.readFixed(2) << 3;
        let free = (8 - (this.pos & 7)) & 7;
        size |= free;
        let minimum = 0;
        while (free < size) {
            minimum += 1 << free;
            free += 8;
        }
        return this.readFixed(size) + minimum;
    }
}

function decodeBase64ToBytes(base64Str) {
    if (!base64Str) return new Uint8Array(0);
    const binaryString = Buffer.from(base64Str, 'base64').toString('binary');
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes;
}

function getBitSizes(size) {
    size *= 40;
    let grid = size - 1;
    let result = 32;
    if (!(grid & 0xFFFF0000)) { result -= 16; grid <<= 16; }
    if (!(grid & 0xFF000000)) { result -= 8;  grid <<= 8;  }
    if (!(grid & 0xF0000000)) { result -= 4;  grid <<= 4;  }
    if (!(grid & 0xC0000000)) { result -= 2;  grid <<= 2;  }
    if (!(grid & 0x80000000))   result--;
    // PHP: ((1 << $result) - $size >> 1) + 20
    // In PHP, '-' binds tighter than '>>', so this is (((1 << result) - size) >> 1) + 20
    return [result, (((1 << result) - size) >> 1) + 20];
}

// --- Constants (mirrors PHP class constants) ---

const Team  = { none: 0, red: 1, blue: 2 };
const Flag  = { none: 0, opponent: 1, opponentPotato: 2, neutral: 3, neutralPotato: 4, temporary: 5 };
const Power = { none: 0, jukeJuice: 1, rollingBomb: 2, tagPro: 4, topSpeed: 8 };

// --- Internal Decoders ---

function decodeMap(base64Data, width) {
    const reader = new LogReader(decodeBase64ToBytes(base64Data));
    const grid = [];
    let x = 0, y = 0, currentRow = [];

    while (!reader.end() || x !== 0) {
        let tile = reader.readFixed(6);
        if (tile) {
            if      (tile <  6) tile +=   9;              //  1- 5 ->  10- 14
            else if (tile < 13) tile  = (tile -  4) * 10; //  6-12 ->  20- 80
            else if (tile < 17) tile +=  77;              // 13-16 ->  90- 93
            else if (tile < 20) tile  = (tile -  7) * 10; // 17-19 -> 100-120
            else if (tile < 22) tile += 110;              // 20-21 -> 130-131
            else if (tile < 32) tile  = (tile -  8) * 10; // 22-31 -> 140-230
            else if (tile < 34) tile += 208;              // 32-33 -> 240-241
            else if (tile < 36) tile += 216;              // 34-35 -> 250-251
            else                tile  = (tile - 10) * 10; // 36-63 -> 260-530
        }

        let count = 1 + reader.readFooter();
        for (let i = 0; i < count; i++) {
            currentRow.push(tile);
            x++;
            if (x === width) {
                grid.push(currentRow);
                currentRow = [];
                x = 0;
                y++;
            }
        }
    }
    return grid;
}

function decodePlayerEvents(base64Data, startingTeam, duration) {
    const reader = new LogReader(decodeBase64ToBytes(base64Data));
    const events = [];
    let time = 0, flag = Flag.none, powers = Power.none;
    let team = startingTeam;
    let prevent = false, button = false, block = false;

    while (!reader.end()) {
        // Read new team: quit | switch | join | stay
        let newTeam;
        if (reader.readBool()) {
            if (team) newTeam = reader.readBool() ? Team.none : 3 - team; // quit or switch
            else      newTeam = 1 + reader.readBool();                     // join red or blue
        } else {
            newTeam = team;                                                  // stay
        }

        const dropPop  = reader.readBool();
        const returns  = reader.readTally();
        const tags     = reader.readTally();
        const grab     = !flag && reader.readBool();
        let   captures = reader.readTally();

        // readBool() is conditionally consumed here — must match PHP's short-circuit exactly
        let keep = !dropPop && newTeam && (newTeam === team || !team) &&
                   (!captures || (!flag && !grab) || reader.readBool());

        const newFlag  = grab ? (keep ? 1 + reader.readFixed(2) : Flag.temporary) : flag;
        let   powerups = reader.readTally();

        let powersDown = Power.none, powersUp = Power.none;
        for (let i = 1; i < 16; i <<= 1) {
            if (powers & i) { if (reader.readBool()) powersDown |= i; }
            else if (powerups && reader.readBool()) { powersUp |= i; powerups--; }
        }

        const togglePrevent = reader.readBool();
        const toggleButton  = reader.readBool();
        const toggleBlock   = reader.readBool();

        time += 1 + reader.readFooter();

        // ---- Fire events in exactly the same order as PHP ----

        // Join: had no team, now has one
        if (!team && newTeam) {
            team = newTeam;
            events.push({ type: 'join', time, team });
        }

        // Returns and tags use flag/powers state before grab
        for (let i = 0; i < returns; i++) events.push({ type: 'return', time, flag, powers, team });
        for (let i = 0; i < tags;    i++) events.push({ type: 'tag',    time, flag, powers, team });

        // Grab: update flag before firing event
        if (grab) {
            flag = newFlag;
            events.push({ type: 'grab', time, flag, powers, team });
        }

        // Captures: PHP is `if($captures--) do {...} while($captures--)` — runs exactly `captures` times
        if (captures--) {
            do {
                if (keep || !flag) {
                    events.push({ type: 'flaglessCapture', time, flag, powers, team });
                } else {
                    events.push({ type: 'capture', time, flag, powers, team });
                    flag = Flag.none; // flag resets mid-tick after a real capture
                    keep = true;
                }
            } while (captures--);
        }

        // Power changes: apply to `powers` before firing each event
        for (let i = 1; i < 16; i <<= 1) {
            if (powersDown & i) {
                powers ^= i;
                events.push({ type: 'powerdown', time, flag, power: i, powers, team });
            } else if (powersUp & i) {
                powers |= i;
                events.push({ type: 'powerup', time, flag, power: i, powers, team });
            }
        }

        // Remaining tally (powerups claimed that matched no distinct bit)
        for (let i = 0; i < powerups; i++) events.push({ type: 'duplicatePowerup', time, flag, powers, team });

        // Prevent toggle
        if (togglePrevent) {
            if (prevent) { events.push({ type: 'stopPrevent',  time, flag, powers, team }); prevent = false; }
            else          { events.push({ type: 'startPrevent', time, flag, powers, team }); prevent = true;  }
        }

        // Button toggle
        if (toggleButton) {
            if (button) { events.push({ type: 'stopButton',  time, flag, powers, team }); button = false; }
            else         { events.push({ type: 'startButton', time, flag, powers, team }); button = true;  }
        }

        // Block toggle
        if (toggleBlock) {
            if (block) { events.push({ type: 'stopBlock',  time, flag, powers, team }); block = false; }
            else        { events.push({ type: 'startBlock', time, flag, powers, team }); block = true;  }
        }

        // Drop or pop: flag resets mid-tick here too
        if (dropPop) {
            if (flag) {
                events.push({ type: 'drop', time, flag, powers, team });
                flag = Flag.none;
            } else {
                events.push({ type: 'pop', time, powers, team });
            }
        }

        // Quit or switch: flag already reflects any drop above
        if (newTeam !== team) {
            if (!newTeam) {
                events.push({ type: 'quit', time, flag, powers, team });
                powers = Power.none; // powers reset only on quit, not switch
            } else {
                // switchEvent passes newTeam, not oldTeam, matching PHP signature
                events.push({ type: 'switch', time, flag, powers, team: newTeam });
            }
            flag = Flag.none;
            team = newTeam;
        }
    }

    events.push({ type: 'end', time: duration, flag, powers, team });
    return events;
}

function decodeSplats(base64Data, mapWidth, mapHeight) {
    const reader = new LogReader(decodeBase64ToBytes(base64Data));
    const xBits = getBitSizes(mapWidth);
    const yBits = getBitSizes(mapHeight);
    const splatTimeline = [];
    let timeIndex = 0;

    while (!reader.end()) {
        let count = reader.readTally();
        if (count > 0) {
            const currentSplats = [];
            while (count--) {
                currentSplats.push({
                    x: reader.readFixed(xBits[0]) - xBits[1],
                    y: reader.readFixed(yBits[0]) - yBits[1]
                });
            }
            splatTimeline.push({ timeIndex, splats: currentSplats });
        }
        timeIndex++;
    }
    return splatTimeline;
}

// --- Core Processing Logic ---

function processSingleMatch(matchData, mapsData, options) {
    const result = {};
    if (matchData.id) result.id = matchData.id;

    // 1. Filter Game Info
    if (options.gameinfo) {
        for (const key in matchData) {
            if (!['map', 'players', 'teams', 'id'].includes(key)) {
                result[key] = matchData[key];
            }
        }
    }

    // 2. Resolve Map Dimensions (required for Splats and Map options)
    let mapWidth = 0;
    let mapHeight = 0;
    let mapTiles = null;
    const targetMapId = matchData.mapId;

    if (matchData.map && matchData.map.width && matchData.map.tiles) {
        mapWidth = matchData.map.width;
        mapTiles = matchData.map.tiles;
    } else if (mapsData && mapsData[targetMapId]) {
        mapWidth = mapsData[targetMapId].width;
        mapTiles = mapsData[targetMapId].tiles;
    }

    let decodedTiles = null;
    if (mapWidth > 0 && mapTiles) {
        decodedTiles = decodeMap(mapTiles, mapWidth);
        mapHeight = decodedTiles.length;
    }

    // 3. Filter Map Output
    if (options.map) {
        if (decodedTiles) {
            const externalMapData = (mapsData && mapsData[targetMapId]) ? mapsData[targetMapId] : {};
            result.map = {
                ...externalMapData,
                ...(matchData.map || {})
            };
            result.map.tiles = decodedTiles;
            result.map.width = mapWidth;
            result.map.height = mapHeight;
        } else {
            result.map = null;
        }
    }

    // 4. Filter Players Output
    if (options.players && matchData.players) {
        result.players = matchData.players.map(player => {
            const p = { ...player };
            if (p.events) {
                p.events = decodePlayerEvents(p.events, p.team, matchData.duration);
            }
            return p;
        });
    }

    // 5. Filter Teams & Splats Output
    if ((options.team || options.splats) && matchData.teams) {
        result.teams = matchData.teams.map(team => {
            const t = options.team ? { ...team } : {};
            if (options.splats) {
                if (team.splats && mapWidth > 0 && mapHeight > 0) {
                    t.splats = decodeSplats(team.splats, mapWidth, mapHeight);
                } else {
                    t.splats = null;
                }
            }
            return t;
        });
    }

    return result;
}


// --- Exported API ---

module.exports = {
    Team,
    Flag,
    Power,

    /**
     * Generator: Yields decoded bulk matches one at a time.
     * @param {string} bulkFilePath - Path to bulk matches JSON.
     * @param {string|null} mapFilePath - Path to bulk maps JSON. Can be null.
     * @param {object} options - { gameinfo: bool, players: bool, team: bool, map: bool, splats: bool }
     * @param {Array|string} idArray - Array of match IDs, or the string 'all'.
     */
    decodeBulkMatches: function* (bulkFilePath, mapFilePath, options, idArray = 'all') {
        const matchesData = JSON.parse(fs.readFileSync(bulkFilePath, 'utf8'));

        let mapsData = null;
        if (mapFilePath) {
            try {
                if (fs.existsSync(mapFilePath)) {
                    mapsData = JSON.parse(fs.readFileSync(mapFilePath, 'utf8'));
                } else {
                    console.warn(`[tagproDecoder] Warning: Map file not found at ${mapFilePath}. Proceeding without external map references.`);
                }
            } catch (err) {
                console.error(`[tagproDecoder] Error parsing map file at ${mapFilePath}:`, err.message);
                console.warn(`[tagproDecoder] Proceeding without external map references.`);
            }
        }

        let matchIds = Object.keys(matchesData);
        if (Array.isArray(idArray)) {
            matchIds = matchIds.filter(id => idArray.includes(id));
        }

        for (const matchId of matchIds) {
            const matchData = matchesData[matchId];
            matchData.id = matchId;
            yield processSingleMatch(matchData, mapsData, options);
        }
    },

    /**
     * Generator: Yields decoded individual match files one at a time.
     * @param {Array} filePaths - Array of strings representing file paths
     * @param {object} options - { gameinfo: bool, players: bool, team: bool, map: bool, splats: bool }
     */
    decodeMatchFiles: function* (filePaths, options) {
        for (const filePath of filePaths) {
            const fileData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            yield processSingleMatch(fileData, null, options);
        }
    }
};
