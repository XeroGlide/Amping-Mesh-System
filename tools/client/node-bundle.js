/* AMPING node map bundle reader (browser + Node). Unpacks the "AMPNMAP1" bundle built by tools/build-node-map.js
   into { meta, tile(g,z,x,y) -> tile JSON | null, service: MapService (routing / search) }.
   Needs AmpMapService (map-service.js) loaded first in the browser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../../map-service.js'));
  else root.AmpNodeBundle = factory(root.AmpMapService);
}(typeof self !== 'undefined' ? self : this, function (MS) {
  'use strict';
  function parse(ab) {
    var u8 = new Uint8Array(ab);
    var magic = String.fromCharCode.apply(null, u8.subarray(0, 8));
    if (magic !== 'AMPNMAP1') throw new Error('not an AMPING node map (bad header)');
    var dv = new DataView(ab), hl = dv.getUint32(8, true);
    var td = new TextDecoder();
    var head = JSON.parse(td.decode(u8.subarray(16, 16 + hl)));
    var base = 16 + hl + ((8 - ((16 + hl) % 8)) % 8);
    var sec = head.sec;
    var part = function (name) { var s = sec[name]; return u8.subarray(base + s[0], base + s[0] + s[1]); };
    var tilesBase = base + sec.tiles[0];
    var gs = sec.graph, graphAb = ab.slice(base + gs[0], base + gs[0] + gs[1]);
    var service = MS.MapService.fromParts({
      meta: head.meta, graphBin: graphAb,
      graphMeta: JSON.parse(td.decode(part('gmeta'))), search: JSON.parse(td.decode(part('search')))
    });
    var cache = new Map();
    function tile(g, z, x, y) {
      var key = g + '/' + z + '/' + x + '/' + y;
      if (cache.has(key)) return cache.get(key);
      var e = head.tiles[key], v = null;
      if (e) { try { v = JSON.parse(td.decode(u8.subarray(tilesBase + e[0], tilesBase + e[0] + e[1]))); } catch (err) { v = null; } }
      cache.set(key, v); if (cache.size > 600) cache.delete(cache.keys().next().value);
      return v;
    }
    return { meta: head.meta, tile: tile, service: service, tileCount: Object.keys(head.tiles).length };
  }
  return { parse: parse };
}));
