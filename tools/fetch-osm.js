'use strict';
// Step 1 of the offline-map build: download OpenStreetMap data for the service area from the Overpass API.
// Needs internet (run on your PC or on the Pi once). Results are cached in tools/cache/ so re-runs are instant.
//   node tools/fetch-osm.js            (default area = Butuan City + surroundings)
//   node tools/fetch-osm.js S,W,N,E    (custom bounding box)
const fs = require('fs'), path = require('path'), https = require('https');

const BBOX = (process.argv[2] || '8.62,125.15,9.10,125.80').split(',').map(Number);   // S,W,N,E
const CACHE = path.join(__dirname, 'cache');
fs.mkdirSync(CACHE, { recursive: true });
const SERVERS = ['overpass-api.de', 'overpass.kumi.systems', 'overpass.private.coffee'];
const UA = 'AMPING-offline-map-builder/1.0 (emergency mesh network, Butuan City)';

function post(host, query) {
  return new Promise((resolve, reject) => {
    const body = 'data=' + encodeURIComponent(query);
    const req = https.request({ host, path: '/api/interpreter', method: 'POST', headers: { 'User-Agent': UA, 'Accept': '*/*', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' ' + txt.slice(0, 120).replace(/\s+/g, ' ')));
        try { const j = JSON.parse(txt); if (j.remark && /error|timed out|out of memory/i.test(j.remark)) return reject(new Error('remark: ' + j.remark)); resolve(j); } catch (e) { reject(new Error('bad JSON: ' + txt.slice(0, 120))); }
      });
    });
    req.setTimeout(400000, () => req.destroy(new Error('timeout')));
    req.on('error', reject); req.write(body); req.end();
  });
}

async function run(name, query, optional) {
  const file = path.join(CACHE, name + '.json');
  if (fs.existsSync(file) && fs.statSync(file).size > 20) { console.log('cached  ' + name); return; }
  for (let attempt = 0; attempt < (optional ? 3 : 8); attempt++) {
    const host = SERVERS[attempt % SERVERS.length];
    try {
      const t0 = Date.now();
      const j = await post(host, query);
      fs.writeFileSync(file, JSON.stringify(j.elements));
      console.log('fetched ' + name + '  ' + j.elements.length + ' elements  (' + Math.round((Date.now() - t0) / 1000) + 's via ' + host + ')');
      await new Promise(r => setTimeout(r, 1500));
      return;
    } catch (e) { console.log('  retry ' + name + ' (' + host + '): ' + e.message); await new Promise(r => setTimeout(r, 6000 + attempt * 5000)); }
  }
  if (optional) { console.log('  SKIPPED optional layer ' + name + ' (servers busy) - run this script again later to add it'); return; }
  throw new Error('could not fetch ' + name);
}

(async () => {
  const [S, W, N, E] = BBOX;
  fs.writeFileSync(path.join(CACHE, 'bbox.json'), JSON.stringify(BBOX));
  const NX = 3, NY = 3, cells = [];
  for (let i = 0; i < NY; i++) for (let j = 0; j < NX; j++) {
    const s = S + (N - S) * i / NY, n = S + (N - S) * (i + 1) / NY, w = W + (E - W) * j / NX, e = W + (E - W) * (j + 1) / NX;
    cells.push([s, w, n, e].map(v => v.toFixed(5)).join(','));
  }
  console.log('Area S,W,N,E = ' + BBOX.join(', ') + '  in ' + cells.length + ' cells');
  const list = cells.map((b, i) => [b, i + 1]);
  for (const [b, k] of list) {
    await run('roads_' + k, `[out:json][timeout:300];way["highway"](${b});out body;>;out skel qt;`);
    await run('buildings_' + k, `[out:json][timeout:300];way["building"](${b});out geom;`);
    await run('water_' + k, `[out:json][timeout:300];(way["natural"~"^(water|coastline|wetland)$"](${b});way["waterway"~"^(river|stream|canal|drain|ditch)$"](${b});way["landuse"="reservoir"](${b});way["water"](${b}););out geom;`);
    await run('poi_' + k, `[out:json][timeout:300];(nwr["amenity"~"^(hospital|clinic|doctors|pharmacy|police|fire_station|school|college|university|kindergarten|townhall|community_centre|shelter|place_of_worship|marketplace|fuel|bank|courthouse)$"](${b});nwr["healthcare"](${b});nwr["emergency"](${b});nwr["place"~"^(city|town|village|hamlet|suburb|neighbourhood|locality|island)$"](${b});nwr["man_made"~"^(lighthouse|water_tower)$"](${b});nwr["aeroway"~"^(aerodrome|helipad)$"](${b});nwr["highway"="bus_station"](${b});nwr["tourism"~"^(hotel|museum|attraction)$"](${b}););out center tags;`);
  }
  await run('restrictions', `[out:json][timeout:300];relation["type"="restriction"](${BBOX.join(',')});out body;`, true);
  for (const [b, k] of list) {
    await run('waterrel_' + k, `[out:json][timeout:300];(relation["natural"="water"](${b});relation["waterway"="riverbank"](${b}););out geom;`, true);
    await run('land_' + k, `[out:json][timeout:300];(way["landuse"~"^(forest|farmland|residential|industrial|commercial|retail|cemetery|farmyard|orchard|meadow|grass|military)$"](${b});way["natural"~"^(wood|scrub|grassland|beach|sand)$"](${b});way["leisure"~"^(park|pitch|stadium|golf_course|sports_centre)$"](${b}););out geom;`, true);
  }
  await run('admin', `[out:json][timeout:300];relation["boundary"="administrative"]["admin_level"~"^(6|8|9|10)$"](${BBOX.join(',')});out geom;`, true);
  console.log('done - now run:  node tools/build-offline-map.js');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
