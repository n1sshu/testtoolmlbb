// ─── State ────────────────────────────────────────────────────────────────────
let allHeroes        = [];
let lastPlayed       = {};
let currentDraftData = null;
let timerAnimTimeout = null;
let ws               = null;
let reconnectTimer   = null;
let lastRunningState = false;
let lastPhaseIndex   = -1;
let isInitialLoad    = true;
let allHeroStats     = {};

let localCountdownValue    = 60;
let localCountdownInterval = null;

// Slots whose hero-stats overlay is still mid-cycle. While a slot is in
// here, updateGameLogic's phase-change wipe must NOT strip its
// active-expand — only retractExpand() (called when the overlay finishes)
// is allowed to remove it.
const pendingExpandSlots = new Set();

function updateTimerText(val) {
    const padded = String(val).padStart(2, '0');
    if (timerElement) timerElement.textContent = padded;
    const arrowTimerEl = document.getElementById('phase-arrow-timer');
    if (arrowTimerEl) arrowTimerEl.textContent = padded;
}
// Injects the blink keyframes once so we don't need a separate CSS file.
(function ensureBlinkStyle() {
    if (document.getElementById('adjustment-blink-style')) return;
    const style = document.createElement('style');
    style.id = 'adjustment-blink-style';
    style.textContent = `
    `;
    document.head.appendChild(style);
})();

function showAdjustmentTimerText() {
    stopLocalCountdown();
    if (timerElement) {
        timerElement.textContent = 'VS';
        timerElement.classList.add('timer-adjustment-blink');
        timerElement.style.fontSize = '29px';
    }
    const arrowTimerEl = document.getElementById('phase-arrow-timer');
    if (arrowTimerEl) {
        arrowTimerEl.textContent = 'VS';
        arrowTimerEl.classList.add('timer-adjustment-blink');

        arrowTimerEl.style.fontSize = '29px';
    }
    stopTimerBar();
}

function clearAdjustmentTimerText() {
    if (timerElement) timerElement.classList.remove('timer-adjustment-blink');
    const arrowTimerEl = document.getElementById('phase-arrow-timer');
    if (arrowTimerEl) arrowTimerEl.classList.remove('timer-adjustment-blink');
}
function startLocalCountdown(startValue) {
    stopLocalCountdown();
    localCountdownValue = startValue;
    updateTimerText(localCountdownValue);
    localCountdownInterval = setInterval(() => {
        localCountdownValue = Math.max(0, localCountdownValue - 1);
        updateTimerText(localCountdownValue);
        if (localCountdownValue <= 0) stopLocalCountdown();
    }, 1000);
}

function stopLocalCountdown() {
    clearInterval(localCountdownInterval);
    localCountdownInterval = null;
}

// Tracks which slot→hero combos have already had their animation/voice/overlay
// triggered THIS session. Keyed as "slotIndex__imgSrc".
// Populated during cache restore so we don't re-animate on load,
// then cleared when phase resets to 0 (new draft).
const animatedSlots  = new Set();

// Deduplicates stat recording within a session. Cleared on new draft.
const recordedEvents  = new Set();

const DRAFT_CACHE_KEY = 'displayhero_draftdata_cache';

// FIX: centralizes "is this a brand-new / empty draft?" detection so we
// don't rely solely on current_phase === 0 to trigger a session reset.
// A dropped WS message, a refresh that lands mid-draft-2, or the server
// jumping straight past phase 0 could otherwise leave recordedEvents /
// animatedSlots stale from the previous draft, silently under-recording
// picks/bans for heroes that were already seen last draft.
function isEmptyDraft(data) {
    if (!data) return false;
    const counts = [
        data.blueside?.pick, data.redside?.pick,
        data.blueside?.ban,  data.redside?.ban,
    ];
    return counts.every(arr => !arr || arr.length === 0);
}

// FIX: single place that clears session-scoped dedup/animation state for
// a fresh draft. Called both on phaseIndex === 0 and whenever we detect
// an empty draft payload (belt-and-braces against missed phase-0 events).
function resetDraftSession() {
    recordedEvents.clear();
    animatedSlots.clear();
    window.resetDraftStats?.();
}

// ─── Hero Data Loading ─────────────────────────────────────────────────────────
async function loadHeroes() {
    try {
        const [heroRes, statsRes] = await Promise.all([
            fetch('/database/herolist.json'),
            fetch('/api/herostats'),
        ]);
        allHeroes = await heroRes.json();
        // FIX: Seed allHeroStats from the server JSON on load,
        // so pick/ban counts are always accurate from the file.
        const statsData = await statsRes.json();
        statsData.heroes.forEach(h => { allHeroStats[h.img] = h; });
    } catch (e) {
        console.error('Error loading hero data', e);
    }
}

// FIX: recordHeroStat now deduplicates only within the current session
// (in-memory Set), NOT via localStorage. This means:
//   - Reloading the page resets the dedup set → fresh session, records correctly.
//   - A clearall on the server wipes server data; next draft records fresh.
//   - No stale localStorage keys silently blocking legitimate records.
async function recordHeroStat(imgSrc, type) {
    const key = `${imgSrc}__${type}`;
    if (recordedEvents.has(key)) return;
    recordedEvents.add(key);

    try {
        const res = await fetch('/api/herostats/record', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ img: imgSrc, type }),
        });
        if (!res.ok) {
            // If the request failed, remove from set so it can be retried
            recordedEvents.delete(key);
            console.error('Failed to record hero stat, will retry:', imgSrc, type);
        }
    } catch (e) {
        recordedEvents.delete(key);
        console.error('Failed to record hero stat:', e);
    }
}

function getOrCreateHeroStats(imgSrc) {
    if (!allHeroStats[imgSrc]) {
        const fileName = imgSrc.split('/').pop().replace(/\.[^/.]+$/, '');
        const heroName = fileName.charAt(0).toUpperCase() + fileName.slice(1).replace(/[-_]/g, ' ');
        allHeroStats[imgSrc] = { img: imgSrc, name: heroName, picks: 0, bans: 0 };
    }
    return allHeroStats[imgSrc];
}

function getLiveCounts(imgSrc, draftData) {
    const allPicks = [...(draftData.blueside?.pick ?? []), ...(draftData.redside?.pick ?? [])];
    const allBans  = [...(draftData.blueside?.ban  ?? []), ...(draftData.redside?.ban  ?? [])];
    return {
        picks: allPicks.filter(p => p.hero === imgSrc).length,
        bans:  allBans.filter (b => b.hero === imgSrc).length,
    };
}

function getVoiceByImg(imgSrc) {
    const hero = allHeroes.find(h => h.img === imgSrc);
    return hero?.voice ?? null;
}

function getTypeByImg(imgSrc) {
    // Ensure the imgSrc has a leading slash to match the JSON format
    const formattedPath = imgSrc.startsWith('/') ? imgSrc : '/' + imgSrc;

    const hero = allHeroes.find(h => h.img === formattedPath);

    // Return the 'type' property from your JSON
    return hero ? hero.type : null;
}

// ─── Score & Phase Arrow ───────────────────────────────────────────────────────
function updateScoreLines(blueWins, redWins) {
    for (let i = 1; i <= 3; i++) {
        document.getElementById(`blue-s${i}`)?.setAttribute('class', 'score-line' + (i <= blueWins ? ' won-blue' : ''));
        document.getElementById(`red-s${i}`) ?.setAttribute('class', 'score-line' + (i <= redWins  ? ' won-red'  : ''));
    }
}

function updatePhaseArrow(isBlueTeamTurn) {
    const phaseIndex = parseInt(currentDraftData?.current_phase ?? 0);

    // Center-panel arrow (matchup-row)
    const arrow = document.getElementById('phase-arrow-center');
    if (arrow) {
        arrow.classList.toggle('both',  phaseIndex >= 17);
        arrow.classList.toggle('right', phaseIndex <  17 && isBlueTeamTurn);
    }

    // Ban-center arrow — mirrors the same turn/adjustment state
    const arrowBan = document.getElementById('phase-arrow-ban');
    if (arrowBan) {
        arrowBan.classList.toggle('both',  phaseIndex >= 17);
        arrowBan.classList.toggle('right', phaseIndex <  17 && isBlueTeamTurn);
    }
}

// ─── Stat Overlay (3-phase cycling: name → picks → bans) ──────────────────────
const PHASE_DURATION = 2200;
const FADE_MS        = 500;

const _sopPhase   = {};
const _sopRunning = {};
const _sopTimers  = {};

function injectStatOverlays() {
    for (let i = 1; i <= 20; i++) {
        const box = document.getElementById(`image-box-${i}`);
        if (!box || document.getElementById(`stats-overlay-${i}`)) continue;

        const wrapper = Object.assign(document.createElement('div'), {
            className: 'hero-stats-overlay',
            id:        `stats-overlay-${i}`,
            innerHTML: `
                <div class="sop-panel" id="sop-name-panel-${i}">
                    <div class="sop-hero-name" id="overlay-wr-${i}"></div>
                    <div class="sop-hero-type" id="overlay-type-${i}"></div>
                </div>
                <div class="sop-panel" id="sop-pick-panel-${i}">
                    <div class="sop-stat-label-debut" id="overlay-debut-${i}">DEBUT<br>PICK</div>
                    <div class="sop-number sop-green" id="overlay-pick-${i}">0</div>
                    <div class="sop-stat-label" id="overlay-pick-label-${i}">TIMES<br>PICKED</div>
                </div>
                <div class="sop-panel" id="sop-ban-panel-${i}">
                    <div class="sop-number sop-red" id="overlay-ban-${i}">0</div>
                    <div class="sop-stat-label">TIMES<br>BANNED</div>
                </div>`,
        });
        box.parentElement.appendChild(wrapper);
    }
}

function _sopShowPanel(i, phase) {
    [`sop-name-panel-${i}`, `sop-pick-panel-${i}`, `sop-ban-panel-${i}`].forEach((id, idx) => {
        const el = document.getElementById(id);
        if (el) el.style.display = idx === phase ? 'flex' : 'none';
    });
    for (let d = 0; d < 3; d++) {
        document.getElementById(`sop-dot-${i}-${d}`)?.classList.toggle('sop-dot-on', d === phase);
    }
    _sopPhase[i] = phase;
}

function _sopStartCycle(i) {
    _sopStopCycle(i);
    _sopRunning[i] = true;
    _sopShowPanel(i, 0);
    const tick = () => {
        if (!_sopRunning[i]) return;
        _sopShowPanel(i, ((_sopPhase[i] ?? 0) + 1) % 3);
        _sopTimers[`cycle_${i}`] = setTimeout(tick, PHASE_DURATION);
    };
    _sopTimers[`cycle_${i}`] = setTimeout(tick, PHASE_DURATION);
}

function _sopStopCycle(i) {
    _sopRunning[i] = false;
    clearTimeout(_sopTimers[`cycle_${i}`]);
    _sopTimers[`cycle_${i}`] = null;
    [`sop-name-panel-${i}`, `sop-pick-panel-${i}`, `sop-ban-panel-${i}`].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    for (let d = 0; d < 3; d++) {
        document.getElementById(`sop-dot-${i}-${d}`)?.classList.remove('sop-dot-on');
    }
}

function _sopFillData(i, heroName, heroType, picks, bans, isDebut = false) {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set(`overlay-wr-${i}`,   heroName);
    set(`overlay-type-${i}`, heroType ?? '');
    set(`overlay-pick-${i}`, picks);
    set(`overlay-ban-${i}`,  bans);

    // In the pick panel: show debut badge and hide number+label, or vice versa
    const debutEl = document.getElementById(`overlay-debut-${i}`);
    const pickNum = document.getElementById(`overlay-pick-${i}`);
    const pickLbl = document.getElementById(`overlay-pick-label-${i}`);
    if (debutEl) debutEl.style.display = isDebut ? 'inline-block' : 'none';
    if (pickNum) pickNum.style.display = isDebut ? 'none'         : 'block';
    if (pickLbl) pickLbl.style.display = isDebut ? 'none'         : 'block';
}

// FIX: 'retract' timer added so the pending retractExpand() call for a
// slot's overlay cycle is tracked and can be cleanly cancelled/replaced
// if that slot's overlay is re-triggered before the old cycle finishes.
function _clearSopTimers(i) {
    ['show', 'hide', 'retract'].forEach(k => {
        clearTimeout(_sopTimers[`${k}_${i}`]);
        _sopTimers[`${k}_${i}`] = null;
    });
}

function _sopShowOverlay(i, heroName, heroType, picks, bans, isDebut = false) {
    _clearSopTimers(i);
    _sopStopCycle(i);
    _sopFillData(i, heroName, heroType, picks, bans, isDebut);

    // Hold this slot's active-expand open until the overlay finishes its
    // full cycle — updateGameLogic's phase-change wipe will skip it while
    // it's in this set.
    pendingExpandSlots.add(i);

    const overlay = document.getElementById(`stats-overlay-${i}`);
    if (!overlay) return;

    _sopTimers[`show_${i}`] = setTimeout(() => {
        overlay.classList.add('visible');
        _sopStartCycle(i);
        _sopTimers[`hide_${i}`] = setTimeout(() => {
            overlay.classList.remove('visible');
            _sopStopCycle(i);
            _sopTimers[`retract_${i}`] = setTimeout(() => retractExpand(i), FADE_MS);
        }, 6500);
    }, 2000);
}

function _sopHideOverlay(i) {
    _clearSopTimers(i);
    _sopStopCycle(i);
    document.getElementById(`stats-overlay-${i}`)?.classList.remove('visible');
    // Forced hide (e.g. slot cleared) also releases the expand hold immediately.
    retractExpand(i);
}

// ─── WebSocket ─────────────────────────────────────────────────────────────────
function connectWebSocket() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${window.location.host}`);

    ws.onopen = () => {
        console.log('Connected to Server');
        fetchDraftData();
        clearInterval(reconnectTimer);
        reconnectTimer = null;
    };

    ws.onmessage = ({ data }) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'draftdata_update') {
                msg.data ? processData(msg.data) : fetchDraftData();

             } else if (msg.type === 'update' && msg.data?.draftdata) {
    const { timer, timer_running } = msg.data.draftdata;
    syncTimerTick(timer, timer_running, false, parseInt(currentDraftData?.current_phase ?? -1));

            } else if (msg.type === 'herostats_update' && msg.data) {
                // FIX: Server broadcast sends the full heroStatsCache object
                // (keyed by img path). Update local allHeroStats from it.
                // This handles BOTH normal updates AND resets correctly.
                Object.values(msg.data).forEach(h => { allHeroStats[h.img] = h; });
                refreshVisibleOverlays();

            } else if (msg.type === 'herostats_cleared') {
                // FIX: recordedEvents/animatedSlots are in-memory Sets now
                // (see comment on their declarations above) — they are no
                // longer mirrored into localStorage, so the old
                // "recorded_*" localStorage cleanup here was dead code
                // that touched keys nothing writes anymore. Removed.
                recordedEvents.clear();
                animatedSlots.clear();
                allHeroStats = {};
                refreshVisibleOverlays();
            }
        } catch (e) {
            console.error('WS parse error', e);
        }
    };

    ws.onclose = () => {
        if (!reconnectTimer) reconnectTimer = setInterval(connectWebSocket, 3000);
    };

    ws.onerror = err => { console.error('Socket error:', err); ws.close(); };
}

async function fetchDraftData() {
    try {
        const res  = await fetch('/api/matchdraft');
        const data = await res.json();
        if (data?.draftdata) processData(data.draftdata);
    } catch (e) {
        console.error('Error fetching draft data:', e);
    }
}

function processData(newDraftData) {
    currentDraftData = newDraftData;
    try { localStorage.setItem(DRAFT_CACHE_KEY, JSON.stringify(newDraftData)); } catch (e) {}
    updateDisplay(newDraftData);
    updateGameLogic(newDraftData);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
loadHeroes().then(() => {
    injectStatOverlays();

    try {
        const cached = localStorage.getItem(DRAFT_CACHE_KEY);
        if (cached) {
            const lastDraft = JSON.parse(cached);
            currentDraftData = lastDraft;
            updateDisplay(lastDraft);
            updateGameLogic(lastDraft);

            // Mark every slot that was populated from cache as already-animated.
            // This prevents voice/overlay firing again on the first WS sync,
            // while still allowing genuinely NEW picks/bans to animate.
            const map = [];
            (lastDraft.blueside?.pick ?? []).forEach((p, idx) => { map[1  + idx] = p.hero; });
            (lastDraft.redside?.pick  ?? []).forEach((p, idx) => { map[6  + idx] = p.hero; });
            (lastDraft.blueside?.ban  ?? []).forEach((p, idx) => { map[11 + idx] = p.hero; });
            (lastDraft.redside?.ban   ?? []).forEach((p, idx) => { map[16 + idx] = p.hero; });
            for (let i = 1; i <= 20; i++) {
                if (map[i]) animatedSlots.add(`${i}__${map[i]}`);
            }
        }
    } catch (e) {
        console.warn('Could not restore draft cache:', e);
    }

    isInitialLoad = false;
    connectWebSocket();

    // Back-fill stat text for slots already rendered from cache.
    // Uses allHeroStats which was seeded from /api/herostats on load,
    // so these numbers come directly from herostats.json.
    setTimeout(() => {
        for (let i = 1; i <= 20; i++) {
            const imgEl = document.getElementById(`image-display-${i}`);
            if (!imgEl?.src || imgEl.style.opacity === '0') continue;
            let imgSrc;
            try { imgSrc = new URL(imgEl.src).pathname.slice(1); } catch { continue; }
            if (!imgSrc || !currentDraftData) continue;
            const base = getOrCreateHeroStats(imgSrc);
            const live = getLiveCounts(imgSrc, currentDraftData);
            _sopFillData(i, base.name, getTypeByImg(imgSrc), base.picks + live.picks, base.bans + live.bans);
        }
    }, 500);
});

const pickSfx = new Audio('/assets/draft/pick.ogg');
const banSfx  = new Audio('/assets/draft/ban.ogg');

function playSfx(type) {
    const audio = type === 'pick' ? pickSfx : banSfx;
    audio.pause();
    audio.currentTime = 0;
    audio.play()?.catch(() => {});
}

// ─── Display Update ────────────────────────────────────────────────────────────
function playVoice(voiceSrc) {
    if (!voiceSrc) return;
    const audio     = document.getElementById('hero-voice');
    const phaseIdx  = parseInt(currentDraftData?.current_phase ?? 0);
    audio.volume    = phaseIdx >= phases.length - 1 ? 0 : 1;
    audio.pause();
    audio.currentTime = 0;
    audio.src = voiceSrc;
    audio.play()?.catch(() => {});
}

// FIX: releases the pendingExpandSlots hold for this slot (regardless of
// whether the DOM lookup below succeeds), then removes active-expand from
// the matching heropick box and playername.
function retractExpand(slotIndex) {
    pendingExpandSlots.delete(slotIndex);

    const isBlue   = slotIndex <= 5;
    const num      = isBlue ? slotIndex : slotIndex - 5;
    const boxId    = isBlue ? `pick-left-${num}` : `pick-right-${num}`;
    const phaseBox = document.getElementById(boxId);
    if (!phaseBox) return;

    (phaseBox.closest('.heropick') ?? phaseBox.parentElement)?.classList.remove('active-expand');

    const selector = isBlue ? '.lowerside:first-child .nickholder' : '.lowerside:last-child .nickholder';
    document.querySelector(selector)?.querySelectorAll('.playername')[num - 1]?.classList.remove('active-expand');
}

function refreshVisibleOverlays() {
    for (let i = 1; i <= 20; i++) {
        const overlay = document.getElementById(`stats-overlay-${i}`);
        const imgEl   = document.getElementById(`image-display-${i}`);
        if (!overlay?.classList.contains('visible')) continue;
        let imgSrc;
        try { imgSrc = new URL(imgEl.src).pathname.slice(1); } catch { continue; }
        if (!imgSrc || !allHeroStats[imgSrc]) continue;
        const h    = allHeroStats[imgSrc];
        const live = currentDraftData ? getLiveCounts(imgSrc, currentDraftData) : { picks: 0, bans: 0 };
        _sopFillData(i, h.name, getTypeByImg(imgSrc), h.picks + live.picks, h.bans + live.bans);
    }
}

function updateDisplay(newData) {
    if (!newData) return;

    // Build slot → imgSrc map:
    // Slots 1-5   = blue picks
    // Slots 6-10  = red picks
    // Slots 11-15 = blue bans
    // Slots 16-20 = red bans
    const map = [];
    (newData.blueside.pick ?? []).forEach((p, i) => { map[1  + i] = p.hero; });
    (newData.redside.pick  ?? []).forEach((p, i) => { map[6  + i] = p.hero; });
    (newData.blueside.ban  ?? []).forEach((p, i) => { map[11 + i] = p.hero; });
    (newData.redside.ban   ?? []).forEach((p, i) => { map[16 + i] = p.hero; });

    for (let i = 1; i <= 20; i++) {
        const imgSrc = map[i];
        const imgEl  = document.getElementById(`image-display-${i}`);
        const boxEl  = document.getElementById(`image-box-${i}`);
        if (!imgEl || !boxEl) continue;

        if (imgSrc) {
            // Normalize imgEl.src (absolute URL) to a relative path for comparison.
            let currentPath = '';
            try { currentPath = new URL(imgEl.src).pathname.slice(1); } catch {}

            if (currentPath !== imgSrc) {
                imgEl.src = imgSrc;
            }

            // isNew = this slot+hero has NOT been animated yet this session.
            const animKey = `${i}__${imgSrc}`;
            const isNew   = !animatedSlots.has(animKey);

            if (isNew) {
                animatedSlots.add(animKey);

                // Play hero voice line
                const voice = getVoiceByImg(imgSrc);
                if (voice && lastPlayed[i] !== imgSrc) playVoice(voice);
                lastPlayed[i] = imgSrc;

                // Record pick/ban stat to server (→ updates herostats.json immediately)
                if (!isInitialLoad) {
                    const statType = i <= 10 ? 'pick' : 'ban';
                    recordHeroStat(imgSrc, statType);
                    playSfx(statType);
                }

                // Show name + stats overlay for pick slots (1-10)
                if (i <= 10) {
                    const base     = getOrCreateHeroStats(imgSrc);
                    const live     = getLiveCounts(imgSrc, newData);
                    const heroType = getTypeByImg(imgSrc);
                    // Debut = never picked before in any prior draft (base.picks === 0)
                    // AND this is their very first pick in the current draft (live.picks <= 1).
                    // We check <= 1 rather than === 0 because recordHeroStat may have already
                    // incremented the live count by the time this runs.
                    const isDebut  = base.picks === 0 && live.picks <= 1;
                    _sopShowOverlay(i, base.name, heroType, base.picks + live.picks, base.bans + live.bans, isDebut);
                }
            }

            imgEl.style.opacity = '1';
            boxEl.classList.add('show');
        } else {
            imgEl.src = '';
            imgEl.style.opacity = '0';
            boxEl.classList.remove('show');
            lastPlayed[i] = null;
            _sopHideOverlay(i);
        }
    }

    // Refresh counts on any already-visible overlays after every data update.
    for (let i = 1; i <= 20; i++) {
        const overlay = document.getElementById(`stats-overlay-${i}`);
        const imgEl   = document.getElementById(`image-display-${i}`);
        if (!overlay?.classList.contains('visible')) continue;
        let imgSrc;
        try { imgSrc = new URL(imgEl.src).pathname.slice(1); } catch { continue; }
        if (!imgSrc) continue;
        const base = getOrCreateHeroStats(imgSrc);
        const live = getLiveCounts(imgSrc, newData);
        const set  = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set(`overlay-pick-${i}`, base.picks + live.picks);
        set(`overlay-ban-${i}`,  base.bans  + live.bans);
    }
}

// ─── Phase & Timer ─────────────────────────────────────────────────────────────
const phaseElement = document.getElementById('phase');
const arrowElement = document.getElementById('arrow');
const timerElement = document.getElementById('timer');
const timerBar     = document.getElementById('timer-bar');

const phases = [
    { type: 'BANNING',    direction: '/Assets/Other/LeftBanning.gif'  },
    { type: 'BANNING',    direction: '/Assets/Other/RightBanning.gif' },
    { type: 'BANNING',    direction: '/Assets/Other/LeftBanning.gif'  },
    { type: 'BANNING',    direction: '/Assets/Other/RightBanning.gif' },
    { type: 'BANNING',    direction: '/Assets/Other/LeftBanning.gif'  },
    { type: 'BANNING',    direction: '/Assets/Other/RightBanning.gif' },
    { type: 'PICKING',    direction: '/Assets/Other/LeftPicking.gif'  },
    { type: 'PICKING',    direction: '/Assets/Other/RightPicking.gif' },
    { type: 'PICKING',    direction: '/Assets/Other/LeftPicking.gif'  },
    { type: 'PICKING',    direction: '/Assets/Other/RightPicking.gif' },
    { type: 'BANNING',    direction: '/Assets/Other/RightBanning.gif' },
    { type: 'BANNING',    direction: '/Assets/Other/LeftBanning.gif'  },
    { type: 'BANNING',    direction: '/Assets/Other/RightBanning.gif' },
    { type: 'BANNING',    direction: '/Assets/Other/LeftBanning.gif'  },
    { type: 'PICKING',    direction: '/Assets/Other/RightPicking.gif' },
    { type: 'PICKING',    direction: '/Assets/Other/LeftPicking.gif'  },
    { type: 'PICKING',    direction: '/Assets/Other/RightPicking.gif' },
    { type: 'ADJUSTMENT', direction: '/Assets/Other/Adjustment.gif'   },
];

const ADJUSTMENT_PHASE   = 18;
const phasesActiveBoxes  = [
    ['ban-left-1'], ['ban-right-1'], ['ban-left-2'], ['ban-right-2'],
    ['ban-left-3'], ['ban-right-3'], ['pick-left-1'], ['pick-right-1', 'pick-right-2'],
    ['pick-left-2', 'pick-left-3'], ['pick-right-3'], ['ban-right-4'], ['ban-left-4'],
    ['ban-right-5'], ['ban-left-5'], ['pick-right-4'], ['pick-left-4', 'pick-left-5'],
    ['pick-right-5'], [],
];

function updateGameLogic(data) {
    if (!data) return;

    const phaseIndex   = parseInt(data.current_phase) || 0;
    const phaseChanged = phaseIndex !== lastPhaseIndex;
    lastPhaseIndex     = phaseIndex;

    // FIX: reset session dedup state on phase 0 as before, AND whenever
    // the incoming payload looks like a brand-new/empty draft regardless
    // of phaseIndex. This guards against a missed phase-0 transition
    // (dropped WS message, refresh landing mid-later-phase, server
    // restarting a draft without resetting the phase counter first)
    // leaving stale entries in recordedEvents/animatedSlots from the
    // previous draft, which would silently under-record repeat heroes.
    if (phaseChanged) {
        if (phaseIndex === ADJUSTMENT_PHASE) {
            window.triggerDraftStats?.();
        } else if (phaseIndex === 0) {
            resetDraftSession();
        }
    }
    if (isEmptyDraft(data) && (recordedEvents.size > 0 || animatedSlots.size > 0)) {
        resetDraftSession();
    }

    syncTimerTick(data.timer, data.timer_running, phaseChanged, phaseIndex);

    if (phaseElement && arrowElement) {
        const phase = phases[phaseIndex];
        if (phase) {
            phaseElement.textContent = phase.type;
            if (!arrowElement.src.endsWith(phase.direction)) arrowElement.src = phase.direction;
        } else {
            phaseElement.textContent = 'ADJUSTMENT';
            arrowElement.src = '';
        }
    } else if (phaseElement) {
        // arrowElement doesn't exist in the DOM (no #arrow element) — still
        // update the phase text so the ban-center label stays correct.
        const phase = phases[phaseIndex];
        phaseElement.textContent = phase ? phase.type : 'ADJUSTMENT';
    }

    updatePhaseArrow(phases[phaseIndex]?.direction.includes('Right') ?? false);

    document.querySelectorAll('.box').forEach(el => el.classList.remove('active-ban', 'active-pick'));

    // FIX: build the set of DOM elements to PRESERVE — anything tied to a
    // slot whose stat overlay is still showing (pendingExpandSlots) — before
    // wiping active-expand. Previously this wipe ran unconditionally on
    // every phase change, which killed the highlight the instant the draft
    // moved to its next phase, well before that pick's 9s stat-overlay
    // cycle (2s delay + 6.5s visible + 0.5s fade) had finished.
    const preserveHeropicks   = new Set();
    const preservePlayernames = new Set();
    pendingExpandSlots.forEach(slot => {
        const isBlue = slot <= 5;
        const num    = isBlue ? slot : slot - 5;
        const boxId  = isBlue ? `pick-left-${num}` : `pick-right-${num}`;
        const phaseBox = document.getElementById(boxId);
        if (phaseBox) {
            const hp = phaseBox.closest('.heropick') ?? phaseBox.parentElement;
            if (hp) preserveHeropicks.add(hp);
        }
        const selector = isBlue ? '.lowerside:first-child .nickholder' : '.lowerside:last-child .nickholder';
        const pn = document.querySelector(selector)?.querySelectorAll('.playername')[num - 1];
        if (pn) preservePlayernames.add(pn);
    });

    document.querySelectorAll('.heropick.active-expand').forEach(el => {
        if (!preserveHeropicks.has(el)) el.classList.remove('active-expand');
    });

    document.querySelectorAll('.playername.active-expand').forEach(el => {
        if (preservePlayernames.has(el)) return;
        el.classList.remove('active-expand');
        el.style.borderBottom = '';
    });

    const isBanPhase = phaseIndex < 6 || (phaseIndex >= 10 && phaseIndex <= 13);
    (phasesActiveBoxes[phaseIndex] ?? []).forEach(boxId => {
        const phaseBox = document.getElementById(boxId);
        if (!phaseBox) return;
        phaseBox.classList.add(isBanPhase ? 'active-ban' : 'active-pick');
        if (isBanPhase) return;

        (phaseBox.closest('.heropick') ?? phaseBox.parentElement)?.classList.add('active-expand');

        const match = boxId.match(/pick-(left|right)-(\d)/);
        if (!match) return;
        const [, side, numStr] = match;
        const selector = side === 'left' ? '.lowerside:first-child .nickholder' : '.lowerside:last-child .nickholder';
        document.querySelector(selector)?.querySelectorAll('.playername')[parseInt(numStr) - 1]?.classList.add('active-expand');
    });
}

// ─── Timer ─────────────────────────────────────────────────────────────────────
function syncTimerTick(timerValue, isRunning, phaseChanged = false, phaseIndex = -1) {
    if (currentDraftData) {
        currentDraftData.timer         = timerValue;
        currentDraftData.timer_running = isRunning;
    }

    if (phaseIndex === ADJUSTMENT_PHASE) {
        showAdjustmentTimerText();
        lastRunningState = false;
        return;
    }
    clearAdjustmentTimerText();

    const timerNum = parseInt(timerValue) || 60;

    // Drive the text countdown locally, resynced to the server's value
    if (isRunning) {
        startLocalCountdown(timerNum);
    } else {
        stopLocalCountdown();
        updateTimerText(timerNum);
    }

    if (isRunning && (!lastRunningState || phaseChanged)) animateTimerBar(timerNum);
    else if (!isRunning && lastRunningState)              stopTimerBar();

    lastRunningState = isRunning;
}
function animateTimerBar(duration) {
    if (!timerBar) return;
    clearTimeout(timerAnimTimeout);
    timerBar.style.transition = 'none';
    timerBar.style.width      = '100%';
    timerAnimTimeout = setTimeout(() => {
        void timerBar.offsetWidth; // force reflow
        timerBar.style.transition = `width ${duration}s linear`;
        timerBar.style.width      = '0%';
    }, 50);
}

function stopTimerBar() {
    if (!timerBar) return;
    clearTimeout(timerAnimTimeout);
    timerBar.style.transition = 'width 0.5s ease';
    timerBar.style.width      = '100%';
}