'use strict';
// One-time (idempotent) patch of "raspberrypi-index final.html" for Pi-command-center use.
//   node test/patch-app.js "<path to raspberrypi-index final.html>"
const fs = require('fs');
const file = process.argv[2];
if (!file) { console.error('usage: node patch-app.js <html file>'); process.exit(1); }
let s = fs.readFileSync(file, 'utf8');
const applied = [];
const NL = s.indexOf(String.fromCharCode(13, 10)) >= 0 ? String.fromCharCode(13, 10) : String.fromCharCode(10);
const nl = (t) => t.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)).split(String.fromCharCode(10)).join(NL);

function once(name, from, to) {
  from = nl(from); to = nl(to);
  if (s.includes('/*AMPING-PATCH:' + name + '*/')) { applied.push(name + ' (already)'); return; }
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error('patch "' + name + '": expected exactly 1 match, found ' + n);
  s = s.replace(from, () => to);
  applied.push(name);
}
function all(name, from, to, expected) {
  from = nl(from); to = nl(to);
  if (s.includes('/*AMPING-PATCH:' + name + '*/')) { applied.push(name + ' (already)'); return; }
  const n = s.split(from).length - 1;
  if (n !== expected) throw new Error('patch "' + name + '": expected ' + expected + ' matches, found ' + n);
  s = s.split(from).join(to);
  applied.push(name + ' x' + n);
}

// 1. Emergencies polled from the Pi lost severity / risk / priority / chat etc. (normalizer only copied 22 fields).
once('em-normalizer-keeps-all-fields',
  `let normalizedEms = processedEms.map(e => ({
                                    id: e.id,`,
  `let normalizedEms = processedEms.map(e => ({
                                    /*AMPING-PATCH:em-normalizer-keeps-all-fields*/ ...e,
                                    severity: e.severity || (e.sev === 'C' ? 'CRITICAL' : e.sev === 'U' ? 'URGENT' : e.sev === 'S' ? 'STANDARD' : undefined),
                                    riskRate: e.riskRate || (e.rr === 'S' ? 'SEVERE' : e.rr === 'H' ? 'HIGH' : e.rr === 'M' ? 'MODERATE' : e.rr === 'L' ? 'LOW' : undefined),
                                    isForcedPriority: e.isForcedPriority || e.fp || false,
                                    id: e.id,`);

// 2. Truncated ids in UPDATE_SOS / TRIAGE_UPDATE / UPDATE_ACCOUNT ("mesh_178" matched EVERY mesh_ account) -> send full ids.
{
  const re = /(const compactUpdate = \{ action: "(?:UPDATE_SOS|TRIAGE_UPDATE|UPDATE_ACCOUNT)", id: String\((?:id|userId)\))\.substring\(0, 8\)/g;
  const n = (s.match(re) || []).length;
  if (s.includes('/*AMPING-PATCH:full-ids*/')) applied.push('full-ids (already)');
  else {
    if (n !== 13) throw new Error('full-ids: expected 13 sites, found ' + n);
    s = s.replace(re, '$1');
    // marker (harmless comment) placed once
    s = s.replace('window.saveAndSyncAccounts = function() {', '/*AMPING-PATCH:full-ids*/ window.saveAndSyncAccounts = function() {');
    applied.push('full-ids x' + n);
  }
}

// 3. SOS chunk ids: first 8 digits of the ms timestamp repeat for ~100 s -> use the LAST 8 (unique).
all('sos-chunk-id', `let chunkMsgId = String(cleanSos.id).substring(0, 8);`, `let chunkMsgId = String(cleanSos.id).slice(-8); /*AMPING-PATCH:sos-chunk-id*/`, 2);

// 4. Firebase bulk pushes overwrote whole account nodes (wiping idPhoto when the local copy came from the Pi) -> field-level merge.
once('bulk-push-online-safe',
  `                        let updates = {};
                        localMeshAccounts.forEach(acc => {
                            if (acc && acc.id) updates['meshaccounts/' + acc.id] = acc;
                        });
                        rtdb.ref().update(updates).catch(err => console.warn("Firebase sync error:", err));`,
  `                        /*AMPING-PATCH:bulk-push-online-safe*/
                        let updates = {};
                        localMeshAccounts.forEach(acc => {
                            if (acc && acc.id) Object.keys(acc).forEach(k => { if (k !== 'idPhoto' && k !== 'hasIdPhoto' && acc[k] !== undefined) updates['meshaccounts/' + acc.id + '/' + k] = acc[k]; });
                        });
                        rtdb.ref().update(updates).catch(err => console.warn("Firebase sync error:", err));`);
once('bulk-push-restore-safe',
  `                                let accUpdates = {};
                                localMeshAccounts.forEach(acc => {
                                    if (acc && acc.id) accUpdates['meshaccounts/' + acc.id] = acc;
                                });`,
  `                                /*AMPING-PATCH:bulk-push-restore-safe*/
                                let accUpdates = {};
                                localMeshAccounts.forEach(acc => {
                                    if (acc && acc.id) Object.keys(acc).forEach(k => { if (k !== 'idPhoto' && k !== 'hasIdPhoto' && acc[k] !== undefined) accUpdates['meshaccounts/' + acc.id + '/' + k] = acc[k]; });
                                });`);

// 5. ID photo: the Pi list omits the (huge) photo; button + viewer fetch it on demand.
once('idphoto-button',
  `                    if (u.idPhoto) {
                        idButtonHtml = `,
  `                    if (u.idPhoto || u.hasIdPhoto) { /*AMPING-PATCH:idphoto-button*/
                        idButtonHtml = `);
once('idphoto-viewer',
  `                            if (isAdmin) {
                                photoToShow = imgSrc || u.idPhoto;
                                if (photoToShow) {`,
  `                            if (isAdmin) {
                                photoToShow = imgSrc || u.idPhoto; /*AMPING-PATCH:idphoto-viewer*/
                                if (!photoToShow && u.hasIdPhoto) {
                                    // the Pi keeps ID photos apart from the account list (keeps polling fast) - fetch this one now
                                    imgElement.src = ''; imgElement.style.display = 'none';
                                    fetch('/api/account_photo?id=' + encodeURIComponent(u.id), { cache: 'no-store' })
                                        .then(r => r.ok ? r.json() : null)
                                        .then(j => { if (j && j.idPhoto) { u.idPhoto = j.idPhoto; imgElement.src = j.idPhoto; imgElement.style.display = 'block'; } })
                                        .catch(() => {});
                                }
                                if (photoToShow) {`);

// 6. Map infrastructure (command center, evac nodes, blocked roads, floods) survives a reload with no internet.
once('infra-persist-helpers',
  `                window.removeMeshInfra = async function(category, key) {`,
  `                // ---- Pi persistence for map infrastructure (Firebase alone is lost when offline) ----
                window.__infraLocalAt = 0;
                window.pushInfraToPi = function() { /*AMPING-PATCH:infra-persist-helpers*/
                    try {
                        fetch('/api/infra', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meshInfraData) }).catch(() => {});
                    } catch (e) {}
                };
                window.mutateInfra = function(mutator, writeFirebase) {
                    try { mutator(meshInfraData); } catch (e) {}
                    window.__infraLocalAt = Date.now();
                    try { renderMeshInfrastructure(); } catch (e) {}
                    try { if (writeFirebase && typeof rtdb !== 'undefined' && rtdb) writeFirebase(); } catch (e) {}
                    window.pushInfraToPi();
                };

                window.removeMeshInfra = async function(category, key) {`);
once('infra-remove',
  `                    const path = key ? \`meshInfrastructure/\${category}/\${key}\` : \`meshInfrastructure/\${category}\`;
                    rtdb.ref(path).remove().catch(() => {});`,
  `                    const path = key ? \`meshInfrastructure/\${category}/\${key}\` : \`meshInfrastructure/\${category}\`;
                    window.mutateInfra((d) => { if (key) { if (d[category]) delete d[category][key]; } else d[category] = (category === 'commandCenter') ? null : {}; }, () => rtdb.ref(path).remove().catch(() => {})); /*AMPING-PATCH:infra-remove*/`);
once('infra-place-cc',
  `rtdb.ref('meshInfrastructure/commandCenter').set({ lat: lat, lng: lng });`,
  `window.mutateInfra((d) => { d.commandCenter = { lat: lat, lng: lng }; }, () => rtdb.ref('meshInfrastructure/commandCenter').set({ lat: lat, lng: lng }).catch(() => {})); /*AMPING-PATCH:infra-place-cc*/`);
once('infra-place-evac',
  `rtdb.ref('meshInfrastructure/evacNodes/evacNode_' + Date.now()).set({ lat: lat, lng: lng });`,
  `{ const k = 'evacNode_' + Date.now(); window.mutateInfra((d) => { d.evacNodes = d.evacNodes || {}; d.evacNodes[k] = { lat: lat, lng: lng }; }, () => rtdb.ref('meshInfrastructure/evacNodes/' + k).set({ lat: lat, lng: lng }).catch(() => {})); } /*AMPING-PATCH:infra-place-evac*/`);
once('infra-place-blocked',
  `if (rStr !== null) { rtdb.ref('meshInfrastructure/blockedRoads/blocked_' + Date.now()).set({ lat: lat, lng: lng, radius: parseInt(rStr)||100, description: "Blocked Road" }); }`,
  `if (rStr !== null) { const k = 'blocked_' + Date.now(); const v = { lat: lat, lng: lng, radius: parseInt(rStr)||100, description: "Blocked Road" }; window.mutateInfra((d) => { d.blockedRoads = d.blockedRoads || {}; d.blockedRoads[k] = v; }, () => rtdb.ref('meshInfrastructure/blockedRoads/' + k).set(v).catch(() => {})); } /*AMPING-PATCH:infra-place-blocked*/`);
once('infra-place-flood',
  `if (rStr !== null) { rtdb.ref('meshInfrastructure/floodwaters/flood_' + Date.now()).set({ lat: lat, lng: lng, radius: parseInt(rStr)||200, level: "Floodwater" }); }`,
  `if (rStr !== null) { const k = 'flood_' + Date.now(); const v = { lat: lat, lng: lng, radius: parseInt(rStr)||200, level: "Floodwater" }; window.mutateInfra((d) => { d.floodwaters = d.floodwaters || {}; d.floodwaters[k] = v; }, () => rtdb.ref('meshInfrastructure/floodwaters/' + k).set(v).catch(() => {})); } /*AMPING-PATCH:infra-place-flood*/`);

// pull infra from the Pi with the other 2-second sync requests
once('infra-pull',
  `const pEm  = pull('/api/emergencies', '/emergencies.json');`,
  `const pEm  = pull('/api/emergencies', '/emergencies.json');
                        const pInfra = fetch('/api/infra' + cb, { cache: 'no-store', signal: controller.signal }).catch(() => null); /*AMPING-PATCH:infra-pull*/`);
once('infra-apply',
  `                        clearTimeout(timeoutId);
                    } catch (err) {
                        // Silently fail if API isn't responding yet`,
  `                        try { /*AMPING-PATCH:infra-apply*/
                            const iRes = await pInfra;
                            if (iRes && iRes.ok && Date.now() - (window.__infraLocalAt || 0) > 6000) {
                                const piInfra = await iRes.json();
                                const hasPi = piInfra && (piInfra.commandCenter || Object.keys(piInfra.evacNodes || {}).length || Object.keys(piInfra.blockedRoads || {}).length || Object.keys(piInfra.floodwaters || {}).length);
                                const norm = (v) => ({ commandCenter: (v && v.commandCenter) || null, evacNodes: (v && v.evacNodes) || {}, blockedRoads: (v && v.blockedRoads) || {}, floodwaters: (v && v.floodwaters) || {} });
                                if (hasPi) {
                                    const next = norm(piInfra);
                                    if (JSON.stringify(next) !== JSON.stringify(norm(meshInfraData))) { meshInfraData = next; if (typeof renderMeshInfrastructure === 'function') renderMeshInfrastructure(); }
                                } else {
                                    const cur = norm(meshInfraData);
                                    if (cur.commandCenter || Object.keys(cur.evacNodes).length || Object.keys(cur.blockedRoads).length || Object.keys(cur.floodwaters).length) window.pushInfraToPi();
                                }
                            }
                        } catch (e) {}

                        clearTimeout(timeoutId);
                    } catch (err) {
                        // Silently fail if API isn't responding yet`);

// 7. "Awaiting Approval" screen promises to update by itself: with the Pi as the only server (no Firebase listener) nothing did that.
once('session-follows-pi',
  `                                localMeshAccounts = Array.from(userMap.values());
                                localStorage.setItem('meshLocalAccounts', JSON.stringify(localMeshAccounts));

                                if (typeof updatePendingBadges === 'function') updatePendingBadges();
                                if (document.getElementById('tab-admin')`,
  `                                localMeshAccounts = Array.from(userMap.values());
                                localStorage.setItem('meshLocalAccounts', JSON.stringify(localMeshAccounts));

                                /*AMPING-PATCH:session-follows-pi*/
                                // keep the logged-in user's own status / role in step with the Pi (e.g. approved by an admin while offline)
                                try {
                                    if (currentUser && currentUser.id) {
                                        const me = localMeshAccounts.find(u => u.id === currentUser.id);
                                        const keepSuper = currentUser.role === 'superadmin' && me && me.role !== 'superadmin';
                                        if (me && !keepSuper && (me.status !== currentUser.status || me.role !== currentUser.role || (me.barangay && me.barangay !== currentUser.barangay))) {
                                            currentUser = Object.assign({}, currentUser, { status: me.status, role: me.role, barangay: me.barangay || currentUser.barangay });
                                            localStorage.setItem('meshSession', JSON.stringify(currentUser));
                                            if (typeof enforceAuthState === 'function') enforceAuthState();
                                        }
                                    }
                                } catch (e) {}

                                if (typeof updatePendingBadges === 'function') updatePendingBadges();
                                if (document.getElementById('tab-admin')`);

// 7b. renderRadarMap() re-fitted the map to the SOS markers on every data refresh - that yanked the view away during navigation.
once('nav-no-refit',
  `if (hasValidMarkers && searchQuery === "" && mapTabCheck && mapTabCheck.clientHeight > 0) {`,
  `if (hasValidMarkers && searchQuery === "" && mapTabCheck && mapTabCheck.clientHeight > 0 && !(window.AMP_MAP && window.AMP_MAP.navActive)) { /*AMPING-PATCH:nav-no-refit*/`);

// 8. Offline vector map + turn-by-turn navigation (replaces the blurry picture overlay and the straight "tactical" line)
once('basemap-main',
  `                    L.imageOverlay('butuan_map.webp', calibratedBounds, {
                        opacity: 0.6, alt: 'Offline Butuan Map', errorOverlayUrl: ''
                    }).addTo(googleMap);`,
  `                    /*AMPING-PATCH:basemap-main*/
                    if (window.AMPING_addBaseMap) { window.AMPING_addBaseMap(googleMap, calibratedBounds); }
                    else L.imageOverlay('butuan_map.webp', calibratedBounds, {
                        opacity: 0.6, alt: 'Offline Butuan Map', errorOverlayUrl: ''
                    }).addTo(googleMap);`);
once('basemap-picker',
  `                            L.imageOverlay('butuan_map.webp', [[southEdge, westEdge], [northEdge, eastEdge]], { opacity: 0.6, alt: 'Offline Butuan Map' }).addTo(pickerMap);`,
  `                            /*AMPING-PATCH:basemap-picker*/
                            if (window.AMPING_addBaseMap) window.AMPING_addBaseMap(pickerMap, [[southEdge, westEdge], [northEdge, eastEdge]], true);
                            else L.imageOverlay('butuan_map.webp', [[southEdge, westEdge], [northEdge, eastEdge]], { opacity: 0.6, alt: 'Offline Butuan Map' }).addTo(pickerMap);`);
{
  const src = fs.readFileSync(require('path').join(__dirname, 'client', 'offline-map.js'), 'utf8');
  const block = '<script id="amping-offline-map">' + NL + src.replace(/\r?\n/g, NL) + NL + '</script>' + NL;
  const re = /<script id="amping-offline-map">[\s\S]*?<\/script>\r?\n?/;
  if (re.test(s)) { s = s.replace(re, () => block); applied.push('offline-map-script (refreshed)'); }
  else {
    const anchor = '<script id="mesh-mobile-app-shell">';
    if (s.split(anchor).length !== 2) throw new Error('offline-map-script: anchor not found exactly once');
    s = s.replace(anchor, () => block + anchor);
    applied.push('offline-map-script');
  }
}

// 9. GPS gate: the app is unusable until the phone shares an accurate position
{
  const src = fs.readFileSync(require('path').join(__dirname, 'client', 'gps-gate.js'), 'utf8');
  const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
  const block = '<script id="amping-gps-gate">' + NL + src.split(CR + LF).join(LF).split(LF).join(NL) + NL + '</' + 'script>' + NL;
  const openTag = '<script id="amping-gps-gate">', a0 = s.indexOf(openTag), a1 = a0 < 0 ? -1 : s.indexOf('</' + 'script>', a0);
  const re = { test: () => a0 >= 0 && a1 > a0 };
  // it goes at the very top of the page (right after <head>): the position engine in it must start before the rest
  // of the ~900 KB page has loaded, so a position is ready the moment the app shows (AMP_CFG, which the Pi / the
  // node build put right after <head>, still comes first)
  if (re.test()) { let end = a1 + 9; if (s[end] === CR) end++; if (s[end] === LF) end++; s = s.slice(0, a0) + s.slice(end); }
  const headM = /<head>[^\n]*\n/i.exec(s);
  if (!headM) throw new Error('gps-gate: <head> not found');
  s = s.slice(0, headM.index + headM[0].length) + block + s.slice(headM.index + headM[0].length);
  applied.push(re.test() ? 'gps-gate (refreshed, top)' : 'gps-gate (top)');
}

// 9a. Reliable sending (2026-10-28): SOS, chat and action pieces stay in an outbox until the node / Pi answers 200.
//     At the top of the page, so every later fetch() of the app goes through it.
{
  const src = fs.readFileSync(require('path').join(__dirname, 'client', 'reliable-send.js'), 'utf8');
  const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
  const openTag = '<script id="amping-reliable-send">';
  const block = openTag + NL + src.split(CR + LF).join(LF).split(LF).join(NL) + NL + '</' + 'script>' + NL;
  const a0 = s.indexOf(openTag), a1 = a0 < 0 ? -1 : s.indexOf('</' + 'script>', a0);
  const had = a0 >= 0 && a1 > a0;
  if (had) { let end = a1 + 9; if (s[end] === CR) end++; if (s[end] === LF) end++; s = s.slice(0, a0) + s.slice(end); }
  const headM = /<head>[^\n]*\n/i.exec(s);
  if (!headM) throw new Error('reliable-send: <head> not found');
  s = s.slice(0, headM.index + headM[0].length) + block + s.slice(headM.index + headM[0].length);
  applied.push(had ? 'reliable-send (refreshed, top)' : 'reliable-send (top)');
}

// 9b. SOS packets cut the requester's account id to 15 characters ("mesh_178841337...") - the Pi could not tie the
//     request to the account (live position, "my requests"). Send the whole id (the Pi also repairs old ones).
all('sos-full-uid',
  `uid: (emergency.userId || "anon").substring(0, 15),`,
  `uid: (emergency.userId || "anon").substring(0, 32), /*AMPING-PATCH:sos-full-uid*/`, 2);

// 9c. On the Heltec node (192.168.4.1) the app sent its login requests to http:// - blocked from the https page
//     (mixed content). The page's own origin is always right.
once('node-base-url',
  `if (loc.hostname === '192.168.4.1' || loc.hostname.includes('captive') || loc.hostname.includes('gstatic')) return 'http://192.168.4.1';`,
  `if (loc.hostname.includes('captive') || loc.hostname.includes('gstatic')) return 'http://192.168.4.1'; /*AMPING-PATCH:node-base-url*/`);

// 9d. Request ids came back as numbers (made by the app) AND as text (from the Pi / the node), so the same request
//     was listed twice and could ring the siren again. Numeric text ids become numbers; the merge compares as text.
once('em-id-number',
  `                                    isForcedPriority: e.isForcedPriority || e.fp || false,
                                    id: e.id,`,
  `                                    isForcedPriority: e.isForcedPriority || e.fp || false,
                                    id: (typeof e.id === 'string' && /^[0-9]{1,15}$/.test(e.id)) ? Number(e.id) : e.id, /*AMPING-PATCH:em-id-number*/`);
once('em-id-merge-has', `if (emMap.has(e.id)) {`, `if (emMap.has(String(e.id))) { /*AMPING-PATCH:em-id-merge-has*/`);
once('em-id-merge-get', `let existing = emMap.get(e.id);`, `let existing = emMap.get(String(e.id)); /*AMPING-PATCH:em-id-merge-get*/`);
once('em-id-merge-set', `emMap.set(e.id, e);`, `emMap.set(String(e.id), e); /*AMPING-PATCH:em-id-merge-set*/`);
once('em-id-new-pending', `let old = activeEmergencies.find(x => x.id === e.id);`, `let old = activeEmergencies.find(x => String(x.id) === String(e.id)); /*AMPING-PATCH:em-id-new-pending*/`);

// 9e. stopSiren() called navigator.vibrate(0) on every refresh - before the first tap Chrome blocks and logs it
//     each time (dozens of console errors). Only stop a vibration that can exist.
once('quiet-vibrate',
  `                    if ("vibrate" in navigator) {
                        navigator.vibrate(0);`,
  `                    if ("vibrate" in navigator && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) { /*AMPING-PATCH:quiet-vibrate*/
                        navigator.vibrate(0);`);
once('quiet-vibrate-on',
  `                    if ("vibrate" in navigator && !sys.vib) {
                        navigator.vibrate([1000, 500, 1000, 500]);
                        sys.vib = setInterval(() => {
                            navigator.vibrate([1000, 500, 1000, 500]);
                        }, 3000);`,
  `                    if ("vibrate" in navigator && !sys.vib) { /*AMPING-PATCH:quiet-vibrate-on*/
                        const canBuzz = () => !navigator.userActivation || navigator.userActivation.hasBeenActive;
                        if (canBuzz()) navigator.vibrate([1000, 500, 1000, 500]);
                        sys.vib = setInterval(() => {
                            if (canBuzz()) navigator.vibrate([1000, 500, 1000, 500]);
                        }, 3000);`);

// 9f. The settings arrive with every 2-second sync, and "no Red Alert" silenced the siren each time - so a
//     responder's SOS siren was cut off within 2 s of starting. Only a Red Alert that really ended stops it.
once('sos-siren-survives-sync',
  `                        window.currentRedAlertId = "";
                        localStorage.removeItem('meshDismissedAlert');`,
  `                        const redAlertWasOn = !!window.currentRedAlertId; /*AMPING-PATCH:sos-siren-survives-sync*/
                        window.currentRedAlertId = "";
                        localStorage.removeItem('meshDismissedAlert');`);
once('sos-siren-survives-sync-stop',
  `                        stopSiren();
                        if (typeof renderResponderDashboards === 'function') renderResponderDashboards();
                    }

                    enforceBroadcastMode();`,
  `                        if (redAlertWasOn) stopSiren(); /*AMPING-PATCH:sos-siren-survives-sync-stop*/
                        if (typeof renderResponderDashboards === 'function') renderResponderDashboards();
                    }

                    enforceBroadcastMode();`);

// 9c. A request's pin stands on the person's live position while it is fresh (it was left where the SOS was sent,
// beside the person's own blue dot) - see LIVE.pinPos in tools/client/live-units.js
once('pin-follows-live',
  `                        const marker = L.marker([em.lat, em.lon], { icon: customIcon, zIndexOffset: 9999 }).addTo(googleMap);`,
  `                        const pinLL = (window.AMP_LIVE && typeof window.AMP_LIVE.pinPos === 'function' && window.AMP_LIVE.pinPos(em)) || [em.lat, em.lon]; /*AMPING-PATCH:pin-follows-live*/
                        const marker = L.marker(pinLL, { icon: customIcon, zIndexOffset: 9999 }).addTo(googleMap);`);

// 9g. CHAT. (1) ids cut to 12 characters ("mesh_1780123") matched many accounts: private messages landed in other
//     people's chats - full ids now, and the cut conversation id is no longer sent. (2) every emergency-chat
//     message of the same day had the SAME id (first 8 digits of the clock) and replaced the one before.
//     (3) private messages carried no send time. (4) a sent message stays on screen until the Pi / node has it.
//     (5) "Received in" comes from the network clock - see tools/client/chat-fix.js
once('chat-id-private',
  `const msgId = "p_" + Date.now().toString(36) + Math.random().toString(36).substr(2, 3);`,
  `const msgId = window.ampMsgId(); /*AMPING-PATCH:chat-id-private*/`);
once('chat-private-keep',
  `                    allMessages.push(newMsg);
                    window.listenToPrivateConversation();

                    // 1. Await Pi Confirmation`,
  `                    allMessages.push(newMsg);
                    window.ampSent(newMsg); /*AMPING-PATCH:chat-private-keep*/
                    window.listenToPrivateConversation();

                    // 1. Await Pi Confirmation`);
once('chat-private-packet',
  `                            cv: String(newMsg.convId || "").substring(0, 12),
                            sid: String(newMsg.senderId || "").substring(0, 12),
                            rid: String(newMsg.receiverId || "").substring(0, 12),
                            n: String(newMsg.senderName || "U").substring(0, 12),
                            c: "p",
                            x: finalTx,
                            tm: newMsg.time
                        };`,
  `                            sid: String(newMsg.senderId || "").substring(0, 32), /*AMPING-PATCH:chat-private-packet*/
                            rid: String(newMsg.receiverId || "").substring(0, 32),
                            n: String(newMsg.senderName || "U").substring(0, 12),
                            c: "p",
                            x: finalTx,
                            tm: newMsg.time,
                            ts: newMsg.timestamp,
                            ...window.ampO()
                        };`);
once('chat-id-community',
  `const msgId = "c_" + Date.now().toString(36) + Math.random().toString(36).substr(2, 3);`,
  `const msgId = window.ampMsgId(); /*AMPING-PATCH:chat-id-community*/`);
once('chat-community-echo',
  `                    const btn = document.getElementById('btnCommunityChatSend');`,
  `                    allMessages.push(newMsg); /*AMPING-PATCH:chat-community-echo*/
                    window.ampSent(newMsg);
                    if (typeof window.renderCommunityChat === 'function') window.renderCommunityChat();

                    const btn = document.getElementById('btnCommunityChatSend');`);
once('chat-community-packet',
  `                            ts: newMsg.timestamp // 🚀 THE FIX: Inject the exact millisecond into the radio wave!`,
  `                            ts: newMsg.timestamp, /*AMPING-PATCH:chat-community-packet*/
                            ...window.ampO()`);
once('chat-id-emergency',
  `const msgId = "emmsg_" + Date.now();`,
  `const msgId = window.ampMsgId(); /*AMPING-PATCH:chat-id-emergency*/`);
once('chat-emergency-packet',
  `                            u: String(newMsg.userId || "").substring(0, 6),
                            n: String(newMsg.sender || "U").substring(0, 8),
                            r: String(newMsg.role || "user").substring(0, 8),
                            c: 'emc',
                            x: newMsg.text,
                            tm: newMsg.time,
                            ts: newMsg.timestamp`,
  `                            u: String(newMsg.userId || "").substring(0, 32), /*AMPING-PATCH:chat-emergency-packet*/
                            n: String(newMsg.sender || "U").substring(0, 12),
                            r: String(newMsg.role || "user").substring(0, 8),
                            c: 'emc',
                            x: newMsg.text,
                            tm: newMsg.time,
                            ts: newMsg.timestamp,
                            ...window.ampO()`);
once('chat-stable-time',
  `timestamp: m.ts || m.timestamp || Date.now()`,
  `timestamp: window.ampSeen(m) /*AMPING-PATCH:chat-stable-time*/`);
once('chat-keep-pending',
  `let newMerged = Array.from(uniqueMsgsMap.values());`,
  `let newMerged = window.ampKeepPending(Array.from(uniqueMsgsMap.values())); /*AMPING-PATCH:chat-keep-pending*/`);
if (s.includes('/*AMPING-PATCH:chat-rx-label*/')) applied.push('chat-rx-label (already)');
else {
  all('chat-rx-label-sites', ' &bull; 📥 Rcvd in ${window.formatLatency(lat)}`;', '${window.ampRxLabel(lat)}`; /*AMPING-PATCH:chat-rx-label*/', 3);
}

// 9h. A private message from someone whose account is not in this phone's list (a node only knows the accounts
//     it has heard about) raised the badge but could not be opened: no card in Recent, "User not found".
if (s.includes('/*AMPING-PATCH:chat-unknown-sender*/')) applied.push('chat-unknown-sender (already)');
else all('chat-unknown-sender-list',
  'localMeshAccounts.find(x => x.id === userId || x.id.startsWith(userId) || userId.startsWith(x.id));',
  'localMeshAccounts.find(x => x.id === userId || x.id.startsWith(userId) || userId.startsWith(x.id)) || window.ampChatContact(userId); /*AMPING-PATCH:chat-unknown-sender*/', 2);
once('chat-unknown-sender-open',
  'const targetUser = allAccounts.find(u => u && u.id === targetUserId);',
  'const targetUser = allAccounts.find(u => u && u.id === targetUserId) || window.ampChatContact(targetUserId); /*AMPING-PATCH:chat-unknown-sender-open*/');

// 9i. Request chat (resident <-> responders): the other side's message only showed up after you sent one
//     yourself - the open chat box was never redrawn when new messages arrived.
once('chat-emergency-live',
  `                                if (isChanged) {
                                    allMessages = newMerged;
`,
  `                                if (isChanged) {
                                    allMessages = newMerged;
                                    if (typeof window.ampEmcRefresh === 'function') window.ampEmcRefresh(); /*AMPING-PATCH:chat-emergency-live*/
`);

// 9j. MAP. The blue dot's marker, its GPS watch and the last position were stored on window.* while the code
//     checks the page's own variables of the same names (declared with "let" - a different thing): they stayed
//     empty, so EVERY GPS fix drew one more blue dot and every map visit started one more GPS watch.
//     The request pin was placed once and never moved again - it now stands on the blue dot (see trackPin).
once('map-one-gps-watch',
  `window.generalMapWatchId = navigator.geolocation.watchPosition((pos) => {`,
  `generalMapWatchId = window.generalMapWatchId = navigator.geolocation.watchPosition((pos) => { /*AMPING-PATCH:map-one-gps-watch*/`);
once('map-last-pos',
  `window.lastKnownUserPos = latLng;`,
  `lastKnownUserPos = window.lastKnownUserPos = latLng; /*AMPING-PATCH:map-last-pos*/
                        if (window.AMP_LIVE && typeof window.AMP_LIVE.onMyDot === 'function') window.AMP_LIVE.onMyDot(pos);`);
once('map-one-blue-dot',
  `window.userLocationMarker = L.marker(latLng, { icon: blueDot, zIndexOffset: 9997 }).addTo(googleMap);`,
  `userLocationMarker = window.userLocationMarker = L.marker(latLng, { icon: blueDot, zIndexOffset: 9997 }).addTo(googleMap); /*AMPING-PATCH:map-one-blue-dot*/`);
once('map-dot-hidden-in-nav',
  `if (typeof activeWatchId === 'undefined' || !activeWatchId) {`,
  `if (!activeWatchId && !window.activeWatchId) { /*AMPING-PATCH:map-dot-hidden-in-nav*/`);
once('pin-tracked',
  `const marker = L.marker(pinLL, { icon: customIcon, zIndexOffset: 9999 }).addTo(googleMap);`,
  `const marker = L.marker(pinLL, { icon: customIcon, zIndexOffset: 9999 }).addTo(googleMap);
                        if (window.AMP_LIVE && typeof window.AMP_LIVE.trackPin === 'function') window.AMP_LIVE.trackPin(em, marker); /*AMPING-PATCH:pin-tracked*/`);

// 9k. The request pin was drawn 48 px above (and 16 px left of) the place it marks: Leaflet already hangs the
//     icon by its tip (iconAnchor [16, 48]) and the drawing was shifted by the same amount a second time.
//     48 px on the screen is 15 m zoomed right in - and hundreds of metres zoomed out.
once('pin-tip-on-the-spot',
  `viewBox="0 0 24 36" width="32" height="48" style="transform: translate(-16px, -48px);">`,
  `viewBox="0 0 24 36" width="32" height="48" data-amp="pin-tip-on-the-spot"><!-- /*AMPING-PATCH:pin-tip-on-the-spot*/ -->`);

// 9l. NO AI. The Guide tab asked an offline AI engine (which was never installed) and then fell back to its own
//     built-in guides - with an "AI" name, a token counter and "model" wording on top. The user asked for the AI
//     to be removed: the tab is now simply the built-in Safety Guide. Nothing is sent anywhere.
if (s.includes('/*AMPING-PATCH:no-ai*/')) applied.push('no-ai (already)');
else {
  const swap = (from, to, min) => {
    from = nl(from); to = nl(to);
    const n = s.split(from).length - 1;
    if (n < (min || 1)) throw new Error('patch "no-ai": not found: ' + from.slice(0, 60));
    s = s.split(from).join(to);
  };
  // the engine is never contacted: straight to the built-in guides
  swap(`// 3. TRY TO CONNECT TO TRUE OFFLINE GENERATIVE AI (OLLAMA)`, `throw new Error('built-in guide only'); /*AMPING-PATCH:no-ai*/`);
  swap(`<div style="margin-bottom: 8px; font-size: 11px; color: #f59e0b; font-weight: 600;">⚡ Generative Engine Offline. Using Built-in Encyclopedia:</div>`, ``);
  // token counter and "model" wording
  { const re = /(<!-- DYNAMIC TOKEN COUNTER -->\s*<div style=")/; if (!re.test(s)) throw new Error('patch "no-ai": token counter not found'); s = s.replace(re, (m, a) => a + 'display:none !important;'); }
  swap(`<div style="margin-bottom: 4px;"><strong>Token Optimizer:</strong> Capped at 150 limit.</div>`, ``);
  swap(`<strong>Context Locked:</strong>`, `<strong>Topic:</strong>`);
  swap(`>Model Initialized</strong>`, `>Guide ready</strong>`);
  swap(`>Offline Models</h2>`, `>Safety Guide</h2>`);
  swap(`>Zero-latency local processing</div>`, `>Built-in guides · works with no internet</div>`);
  swap(`<div style="font-size: 26px; line-height: 1;">🤖</div>`, `<div style="font-size: 26px; line-height: 1;">📘</div>`);
  swap(`🤖 Mesh AI</strong>`, `📘 Safety Guide</strong>`);
  swap(`>Generating...</span>`, `>Looking it up...</span>`);
  swap(`>Processing local offline context...</div>`, `>Finding the guide...</div>`);
  swap(`AI output may contain inaccuracies. Prioritize LGU instructions.`, `General guidance only. Always follow LGU instructions.`);
  // names of the tab
  swap(`aiGuide: "AI Guide"`, `aiGuide: "Guide"`);
  swap(`aiGuide: "AI nga Giya"`, `aiGuide: "Giya"`);
  swap(`aiGuide: "AI na Gabay"`, `aiGuide: "Gabay"`);
  swap(`style="color: #4338ca;">AI Guide</div>`, `style="color: #4338ca;">Guide</div>`);
  swap(`Send feedback (AI Help)`, `Safety guide`);
  swap(`setFeed: "Pagpadala og feedback (AI)"`, `setFeed: "Giya sa kaluwasan"`);
  swap(`setFeed: "Magpadala ng feedback (AI)"`, `setFeed: "Gabay sa kaligtasan"`);
  // the guide's own introduction, and the agreement text
  swap(`I am your private Offline AI Assistant. I am programmed to`, `This is the built-in offline safety guide. It is set up to`);
  swap(`Ako ang inyong pampribadong Offline AI Assistant.`, `Ito ang built-in na offline na gabay sa kaligtasan.`);
  swap(`Ako ang inyong pribadong Offline AI Assistant.`, `Kini ang built-in nga offline nga giya sa kaluwasan.`);
  swap(`The system utilizes an offline Artificial Intelligence (AI) guide. All conversations with the AI remain locally processed on your device or the local network. No private queries are sent to third-party AI companies.`,
       `The app includes a built-in offline safety guide. It does not use Artificial Intelligence. What you type into the guide stays on your device and is not sent to anyone.`);
  { const re = /3\. AI (&amp;|&) Automated Processing:/; if (!re.test(s)) throw new Error('patch "no-ai": agreement heading not found'); s = s.replace(re, '3. Built-in Safety Guide:'); }
  applied.push('no-ai');
}

// 9m. The Guide tab's icon was a robot face - an open book now that it is a plain safety guide.
once('no-ai-icon',
  `    ai:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1.4"/><circle cx="9" cy="14" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="14" r="1.2" fill="currentColor" stroke="none"/><path d="M2 13v2M22 13v2"/></svg>',`,
  `    ai:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.5C10.4 5.2 8 4.6 4.5 4.6c-.8 0-1.5.7-1.5 1.5v11.3c0 .8.7 1.5 1.5 1.5 3.5 0 5.9.6 7.5 1.9 1.6-1.3 4-1.9 7.5-1.9.8 0 1.5-.7 1.5-1.5V6.1c0-.8-.7-1.5-1.5-1.5-3.5 0-5.9.6-7.5 1.9z"/><path d="M12 6.5v14.3"/></svg>', /*AMPING-PATCH:no-ai-icon*/`);

// 9n. (the token counter's own style said display:flex further on - it needs !important to stay hidden)
{ const re = /(<!-- DYNAMIC TOKEN COUNTER -->\s*<div style=")display:none;/; if (re.test(s)) { s = s.replace(re, (m, a) => a + 'display:none !important;'); applied.push('no-ai-counter'); } }

// 9o. The last "model" words on the Guide screen, and the answer's badge (it kept saying it was still working).
once('no-ai-back', `⬅️ Back to Models`, `⬅️ Back to topics<!-- /*AMPING-PATCH:no-ai-back*/ -->`);
once('no-ai-topic-label',
  `Model: <span id="aiContextLabel" style="color: #0284c7;">Loading...</span>`,
  `Topic: <span id="aiContextLabel" style="color: #0284c7;">Loading...</span><!-- /*AMPING-PATCH:no-ai-topic-label*/ -->`);
once('no-ai-topic-name', `contextSpan.innerText = titleText + " Mode";`, `contextSpan.innerText = titleText; /*AMPING-PATCH:no-ai-topic-name*/`);
once('no-ai-badge', `>Looking it up...</span>`, `>Built-in guide</span><!-- /*AMPING-PATCH:no-ai-badge*/ -->`);

// 9p. EXACT LOCATION. The SOS waited up to 15 s for a brand-new GPS reading (maximumAge 0) and then took whatever
//     came, exact or not. Now it uses the position engine (gps-gate.js: AMP_LOC) that has been running since the app
//     opened: a reading of 25 m or better is used at once, otherwise it waits up to 5 s for one, then takes the
//     best it has. A position worse than 50 m (or none) opens "Pin my exact location" (tools/client/sos-pin.js).
once('sos-best-position',
  `                        navigator.geolocation.getCurrentPosition(
                            (pos) => executeSOSDispatch(pos.coords.latitude, pos.coords.longitude, null),
                            () => executeSOSDispatch(fallbackLat, fallbackLon, fallbackTag),
                            // 🔥 FIX: 15 second timeout to allow satellites to connect, and maximumAge 0 prevents using old inaccurate data!
                            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
                        );`,
  `                        window.AMP_LOC.get({ want: 25, wait: 5000 }).then((b) => { /*AMPING-PATCH:sos-best-position*/
                            window.__ampSosAcc = b ? b.acc : null;
                            if (b) executeSOSDispatch(b.lat, b.lng, null);
                            else executeSOSDispatch(fallbackLat, fallbackLon, fallbackTag);
                        });`);
once('sos-pin-prompt',
  `const executeSOSDispatch = (lat, lon, locationSourceTag) => {`,
  `const executeSOSDispatch = (lat, lon, locationSourceTag) => {
                        setTimeout(() => { if (window.ampAfterSos) window.ampAfterSos(locationSourceTag ? null : window.__ampSosAcc); }, 1200); /*AMPING-PATCH:sos-pin-prompt*/`);
once('sos-honest-accuracy',
  'feedbackMsg += `\\n\\nRescuers have received your exact satellite GPS coordinates.`;',
  'feedbackMsg += (window.__ampSosAcc != null && window.__ampSosAcc > 50) ? `\\n\\nYour GPS position is only accurate to about ${Math.round(window.__ampSosAcc)} m - please pin your exact location on the map next.` : `\\n\\nRescuers have received your GPS position${window.__ampSosAcc != null ? " (accurate to about " + Math.max(1, Math.round(window.__ampSosAcc)) + " m)" : ""}.`; /*AMPING-PATCH:sos-honest-accuracy*/');
// a pin moved by hand arrives as the action MOVE_SOS among the messages (Heltec node) - apply it, never show it as chat
once('sos-move-chunk',
  `else if (obj.action === "DIR_SYNC" && obj.users) {`,
  `else if (obj.action === "MOVE_SOS") { if (window.ampMoveSos) window.ampMoveSos(obj); } /*AMPING-PATCH:sos-move-chunk*/
                                                else if (obj.action === "DIR_SYNC" && obj.users) {`);
once('sos-move-plain',
  `} else if (m.ty || m.type) {`,
  `} else if (m.action === "MOVE_SOS") { if (window.ampMoveSos) window.ampMoveSos(m); /*AMPING-PATCH:sos-move-plain*/
                                        } else if (m.ty || m.type) {`);

// 9q. Never wait: the SOS goes out at once with the best position the phone already has (it has been watching the
//     GPS since the app opened); only with no position at all does it wait up to 3 s. If the GPS gets more exact in
//     the next 30 s, the request follows by itself (sos-pin.js: ampRefineSos).
once('sos-fast-position',
  `                        window.AMP_LOC.get({ want: 25, wait: 5000 }).then((b) => { /*AMPING-PATCH:sos-best-position*/
                            window.__ampSosAcc = b ? b.acc : null;
                            if (b) executeSOSDispatch(b.lat, b.lng, null);`,
  `                        window.AMP_LOC.get({ want: 25, wait: window.AMP_LOC.best(60000) ? 0 : 3000 }).then((b) => { /*AMPING-PATCH:sos-best-position*/ /*AMPING-PATCH:sos-fast-position*/
                            window.__ampSosAcc = b ? b.acc : null;
                            if (b) { executeSOSDispatch(b.lat, b.lng, null); if (window.ampRefineSos) window.ampRefineSos(b); }`);

// 9r. The request list was only redrawn when a status (or the count) changed - a request whose pin was moved kept
//     its old place on every responder's map. A new position (or pinned-by-hand flag) now counts as a change too.
once('em-moved-is-change',
  `if (!old || old.status !== newEms[i].status) {`,
  `if (!old || old.status !== newEms[i].status || +old.lat !== +newEms[i].lat || +old.lon !== +newEms[i].lon || !!(old.mp || old.manualPin) !== !!(newEms[i].mp || newEms[i].manualPin)) { /*AMPING-PATCH:em-moved-is-change*/`);

// 9s. The 2-second sync stopped completely while the app was not on screen - so nothing new (chat, SOS) could be
//     noticed until it was opened again. In the background it now keeps going every 5 s (notify.js turns what
//     arrives into phone notifications - the same in the AMPING Mesh app and in browsers).
once('sync-in-background',
  `                        if (!document.hidden) window.syncPiDatabase();`,
  `                        if (!document.hidden) window.syncPiDatabase();
                        else if (Date.now() - (window.__ampBgSyncAt || 0) > 5000) { window.__ampBgSyncAt = Date.now(); window.syncPiDatabase(); } /*AMPING-PATCH:sync-in-background*/`);

// 10. Live positions: responders' units on everyone's map, requesters' live position for responders
function injectScript(name, tagId, fileName) {
  const src = fs.readFileSync(require('path').join(__dirname, 'client', fileName), 'utf8');
  const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
  const openTag = '<script id="' + tagId + '">';
  const block = openTag + NL + src.split(CR + LF).join(LF).split(LF).join(NL) + NL + '</' + 'script>' + NL;
  const a0 = s.indexOf(openTag), a1 = a0 < 0 ? -1 : s.indexOf('</' + 'script>', a0);
  if (a0 >= 0 && a1 > a0) { let end = a1 + 9; if (s[end] === CR) end++; if (s[end] === LF) end++; s = s.slice(0, a0) + block + s.slice(end); applied.push(name + ' (refreshed)'); }
  else {
    const anchor = '<script id="mesh-mobile-app-shell">';
    if (s.split(anchor).length !== 2) throw new Error(name + ': anchor not found exactly once');
    s = s.replace(anchor, () => block + anchor); applied.push(name);
  }
}
injectScript('live-units', 'amping-live-units', 'live-units.js');
// 11. Chat: network clock, exact "received in", sent messages stay on screen (used by the 9g patches)
injectScript('chat-fix', 'amping-chat-fix', 'chat-fix.js');
// 12. Pin my exact location (requesters) - used by the 9p patches
injectScript('sos-pin', 'amping-sos-pin', 'sos-pin.js');
// 13. Notifications - the same in the app and in browsers
injectScript('notify', 'amping-notify', 'notify.js');
// 14. Is the radio link to the command center up? (node: everyone, Pi: staff)
injectScript('link-status', 'amping-link-status', 'link-status.js');

// 15. Chat packets cut the sender's name to 12 and the role to 8 letters ("Ambulance Te", "AMBULANC", "evacuati") - on the
//     same node and across the radio. 20 / 12 keeps every role whole and costs a few bytes.
all('chat-name-role-whole', `n: String(newMsg.sender || "U").substring(0, 12),`, `n: String(newMsg.sender || "U").substring(0, 20), /*AMPING-PATCH:chat-name-role-whole*/`, 2);
all('chat-role-whole', `r: String(newMsg.role || "user").substring(0, 8),`, `r: String(newMsg.role || "user").substring(0, 12), /*AMPING-PATCH:chat-role-whole*/`, 2);
// 16. Speed. Every SOS / chat / action went to the Pi or node in 90-character pieces 800 ms apart (a precaution for the
//     first ESP32 page): a 3-piece SOS waited 1.6 s on the phone. Both servers take the pieces at once.
all('chunk-gap-fast', `}, i * 800);`, `}, i * 25); /*AMPING-PATCH:chunk-gap-fast*/`, 13);
// 17. Exact "SOS reached this phone in ..." - the request carries the sender's distance to the network clock ("o",
//     like chat), so the time no longer depends on two phones' clocks (before: raw clocks, and a random 120-160 ms
//     whenever the result came out negative). See tools/client/chat-fix.js ampSosRxLabel.
all('sos-net-clock', `tm: emergency.time,`, `tm: emergency.time, ...(window.ampO ? window.ampO() : {}), /*AMPING-PATCH:sos-net-clock*/`, 2);
once('sos-rx-mark-obj', `window.markMessageReceived("sos_" + (obj.id || obj.i), obj.id || obj.i);`, `window.markMessageReceived("sos_" + (obj.id || obj.i), obj.id || obj.i, obj.o); /*AMPING-PATCH:sos-rx-mark-obj*/`);
once('sos-rx-mark', `window.markMessageReceived("sos_" + (e.id || e.i), e.id || e.i);`, `window.markMessageReceived("sos_" + (e.id || e.i), e.id || e.i, e.o); /*AMPING-PATCH:sos-rx-mark*/`);
once('sos-rx-label', "latencyHtml = `<div style=\"font-size: 9px; color: #10b981; margin-top: 4px; font-weight: 800;\">⚡ Rcvd in ${window.formatLatency(lat)}</div>`;",
  "latencyHtml = window.ampSosRxLabel ? window.ampSosRxLabel(lat, em) : ''; /*AMPING-PATCH:sos-rx-label*/");
// 18. Instant updates on the command center: the Pi wakes the app the moment something changes (instant-sync.js)
injectScript('instant-sync', 'amping-instant-sync', 'instant-sync.js');
once('chat-private-name-whole',`n: String(newMsg.senderName || "U").substring(0, 12),`, `n: String(newMsg.senderName || "U").substring(0, 20), /*AMPING-PATCH:chat-private-name-whole*/`);
// 20. LoRa login on a field node (2026-10-28 student test): every phone gets its own query id (q) from the node and
//     asks for ITS answer; the wait is 2.5 minutes with a countdown (a far node behind an EAP110 repeater needs more
//     than the old 16 s). Older node firmware sends no q: then it polls like before.
// the field node has no contact with the command center: say so at once instead of counting down 150 s for nothing
once('lora-login-nolink', `        if (loraReq.ok) {
            let loraQ = ''`, `        try { const nlj = JSON.parse(loraReq.text || '{}'); if (nlj.noLink) { const ag = Number(nlj.linkS) >= 0 ? Math.round(Number(nlj.linkS) / 60) : -1; diagnosticLog += "-> This field node has NO radio contact with the command center" + (ag >= 0 ? " (last heard " + (ag < 1 ? "under a minute" : ag + " min") + " ago)" : " (never heard since it started)") + ". Your account is not stored on this node" + (Number(nlj.accounts) > 0 ? " yet" : "") + ", so only the command center could let you in. Tell the admin to check the command center (Heltec 1 plugged in, antennas up), then try again.\\n"; } } catch (e) {} /*AMPING-PATCH:lora-login-nolink*/
        if (loraReq.ok) {
            let loraQ = ''`);
once('lora-login-q', `        if (loraReq.ok) {
            btn.innerText = "⏳ Waiting for Pi (up to 16s)...";`, `        if (loraReq.ok) {
            let loraQ = ''; let loraWait = 150; try { const lj = JSON.parse(loraReq.text || '{}'); loraQ = lj.q || ''; if (lj.waitS) loraWait = Math.max(30, Math.min(300, Number(lj.waitS) || 150)); } catch (e) {} /*AMPING-PATCH:lora-login-q*/
            btn.innerText = "⏳ Asking the command center by radio...";`);
once('lora-login-wait', `            while(attempts < 32 && !successData) {
                await new Promise(r => setTimeout(r, 500));
                attempts++;

                const pollRes = await xhrRequest('GET', BASE_URL + '/api/lora_result' + cb, null, 3000);`, `            const loraT0 = Date.now(); /*AMPING-PATCH:lora-login-wait*/
            while((Date.now() - loraT0) < loraWait * 1000 && !successData) {
                await new Promise(r => setTimeout(r, attempts < 4 ? 1000 : 2000));   // the field node keeps only 3 secure connections: do not hammer it
                attempts++;
                btn.innerText = "⏳ Waiting for the command center... " + Math.max(0, Math.round(loraWait - (Date.now() - loraT0) / 1000)) + " s";

                const pollRes = await xhrRequest('GET', BASE_URL + '/api/lora_result' + cb + (loraQ ? '&q=' + encodeURIComponent(loraQ) : ''), null, 3000);`);
// a field node that has the account in its account book (firmware 2026-10-28b) answers in the same reply: no waiting
once('lora-login-local', `            const loraT0 = Date.now(); /*AMPING-PATCH:lora-login-wait*/`, `            try { const lj2 = JSON.parse(loraReq.text || '{}'); if (lj2.status === 'APPROVED' && lj2.user) successData = { status: 'APPROVED', user: lj2.user }; } catch (e) {} /*AMPING-PATCH:lora-login-local*/
            const loraT0 = Date.now(); /*AMPING-PATCH:lora-login-wait*/`);
once('lora-login-timeout-text', `diagnosticLog += "-> Node LoRa Timeout (Command Center Pi didn't reply over LoRa in 16s).\\n";`, `diagnosticLog += "-> No answer from the command center by radio in " + loraWait + " s. The field node may be out of radio range, or the command center is off. Try again in a minute.\\n"; /*AMPING-PATCH:lora-login-timeout-text*/`);
// 19. Opened FROM THE PI (window.AMP_CFG.piCloud, set by amping-server.js): the app does not talk to Firebase itself - the
//     Pi is its one way to the cloud (tech2forms only lets the Pi in, 2026-10-27). The copy on the website has no
//     AMP_CFG and keeps its own Firebase connection.
once('pi-is-the-cloud', `try { if (typeof firebase.initializeApp === 'function') firebase.initializeApp(firebaseConfig); } catch(e) {}`,
  `try { if (typeof firebase.initializeApp === 'function') firebase.initializeApp(firebaseConfig); } catch(e) {}
                try { if (window.AMP_CFG && window.AMP_CFG.piCloud && firebase.database) firebase.database().goOffline(); } catch(e) {} /*AMPING-PATCH:pi-is-the-cloud*/`);

fs.writeFileSync(file, s);
console.log('patched: ' + applied.join(', '));
