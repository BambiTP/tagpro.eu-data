const decoder = require('./decoder.js');
const zomball = require('./zomball.js');
const options = {
    gameinfo: true,
    map: true,
    players: true,
    team: true,
    splats: true
};
//decodeBulkMatches( bulkMatchFile, bulkMapFile, options, array of id's or all )
//decodeMatchFiles(arrayOfMatchFiles, options)

//see tagpro.eu/?science to see what data is available or ask bambi

// Bulk files from tagpro.eu
for (const match of decoder.decodeBulkMatches('./bulkmatches.json', './bulkmaps.json', options, 'all')) {
    console.log(match.teams[1].name)
}
// Individual match files
for (const match of decoder.decodeMatchFiles(['./match1.json','./match2.json'], options)) {
    console.log(match.players[0].name)
}

// Specific bulk matches by id decodeBulkMatches( bulkMatchFile, bulkMapFile, options, array of id's or all )
for(const match of decoder.decodeBulkMatches('./bulkmatches.json', './bulkmaps.json', options, ['1', '2'])){
    console.log(match.map.name)
}
//zomball.js example
for (const match of decoder.decodeMatchFiles(['./zomballTest.json'], options)) {
    let zomballMatch = zomball.processZomballMatch(match)
    console.dir(zomballMatch, { depth: null })
}
//helpful timeline function pass match.player into it
//converts match.player[n].events into a timeline

function toTimeline(player) {
    const { events } = player;

    const toMMSScc = frames => {
        const m = Math.floor(frames / 3600);
        const s = Math.floor(frames % 3600 / 60);
        const cc = Math.round(frames % 60 / 0.6).toString().padStart(2, '0');
        return `${m}:${s.toString().padStart(2, '0')}.${cc}`;
    };

    const teamName = t => t === 1 ? 'red' : 'blue';
    const powerName = b => ({ 1: 'juke juice', 2: 'speed', 4: 'grip', 8: 'bomb' }[b] ?? `power ${b}`);

    const timeline = [];
    let prevTeam = player.team;
    let preventing = false, buttoning = false, blocking = false;

    if (prevTeam) timeline.push(`0:00.00 - starts in team ${teamName(prevTeam)}`);

    for (const e of events) {
        const time = toMMSScc(e.time);

        if (e.team !== prevTeam) {
            if (prevTeam === 0)    timeline.push(`${time} - joins team ${teamName(e.team)}`);
            else if (e.team === 0) timeline.push(`${time} - quits team ${teamName(prevTeam)}`);
            else                   timeline.push(`${time} - switches to team ${teamName(e.team)}`);
            prevTeam = e.team;
        }

        if (e.grab) timeline.push(`${time} - grabs flag ${e.newFlag}`);
        for (let i = 0; i < e.captures; i++) timeline.push(`${time} - captures flag ${e.newFlag}`);
        for (let i = 0; i < e.returns; i++)  timeline.push(`${time} - returns`);
        for (let i = 0; i < e.tags; i++)     timeline.push(`${time} - tags`);

        if (e.dropPop) {
            if (e.newFlag > 0) timeline.push(`${time} - drops flag ${e.newFlag}`);
            else               timeline.push(`${time} - pops`);
        }

        for (const bit of [1, 2, 4, 8]) {
            if (e.powersUp & bit)   timeline.push(`${time} - powers up ${powerName(bit)}`);
            if (e.powersDown & bit) timeline.push(`${time} - powers down ${powerName(bit)}`);
        }

        if (e.togglePrevent) { preventing = !preventing; timeline.push(`${time} - ${preventing ? 'starts' : 'stops'} preventing`); }
        if (e.toggleButton)  { buttoning = !buttoning;   timeline.push(`${time} - ${buttoning  ? 'starts' : 'stops'} buttoning`); }
        if (e.toggleBlock)   { blocking = !blocking;     timeline.push(`${time} - ${blocking   ? 'starts' : 'stops'} blocking`); }
    }

    if (prevTeam && events.length) {
        timeline.push(`${toMMSScc(events[events.length - 1].time)} - ends in team ${teamName(prevTeam)}`);
    }

    return timeline;
}

