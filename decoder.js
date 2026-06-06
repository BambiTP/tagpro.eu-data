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
        let free = 8 - (this.pos & 7) & 7;
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
    if (!(grid & 0xFF000000)) { result -= 8; grid <<= 8; }
    if (!(grid & 0xF0000000)) { result -= 4; grid <<= 4; }
    if (!(grid & 0xC0000000)) { result -= 2; grid <<= 2; }
    if (!(grid & 0x80000000)) result--;
    return [result, Math.floor(((1 << result) - size) / 2) + 20];
}

// --- Internal Decoders ---

function decodeMap(base64Data, width) {
    const reader = new LogReader(decodeBase64ToBytes(base64Data));
    const grid = [];
    let x = 0, y = 0, currentRow = [];

    while (!reader.end() || x !== 0) {
        let tile = reader.readFixed(6);
        if (tile) {
            if (tile < 6) tile += 9;
            else if (tile < 13) tile = (tile - 4) * 10;
            else if (tile < 17) tile += 77;
            else if (tile < 20) tile = (tile - 7) * 10;
            else if (tile < 22) tile += 110;
            else if (tile < 32) tile = (tile - 8) * 10;
            else if (tile < 34) tile += 208;
            else if (tile < 36) tile += 216;
            else tile = (tile - 10) * 10;
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
    let time = 0, flag = 0, powers = 0;
    let team = startingTeam;

    while (!reader.end()) {
        let newTeam = team;
        if (reader.readBool()) { 
            if (team) newTeam = reader.readBool() ? 0 : 3 - team;
            else newTeam = 1 + reader.readBool();
        }

        let dropPop = reader.readBool();
        let returns = reader.readTally();
        let tags = reader.readTally();
        let grab = !flag && reader.readBool();
        let captures = reader.readTally();
        let keep = !dropPop && newTeam && (newTeam === team || !team) && (!captures || (!flag && !grab) || reader.readBool());
        let newFlag = grab ? (keep ? 1 + reader.readFixed(2) : 5) : flag;
        let powerups = reader.readTally();
        
        let powersDown = 0, powersUp = 0;
        for (let i = 1; i < 16; i <<= 1) {
            if (powers & i) { if (reader.readBool()) powersDown |= i; }
            else if (powerups && reader.readBool()) { powersUp |= i; powerups--; }
        }

        let togglePrevent = reader.readBool();
        let toggleButton = reader.readBool();
        let toggleBlock = reader.readBool();
        
        time += 1 + reader.readFooter();

        events.push({ time, team: newTeam, dropPop, returns, tags, grab, captures, newFlag, powersDown, powersUp, togglePrevent, toggleButton, toggleBlock });

        team = newTeam;
        flag = newFlag;
        if (dropPop) flag = 0;
    }
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
            let currentSplats = [];
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