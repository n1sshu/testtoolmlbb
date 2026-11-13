/**
 * claudeStats.js — Groq-powered /draft stats for postdraft.html
 *
 * Setup:
 *   1. Get a free API key at https://console.groq.com
 *   2. Paste your key below
 *   3. Run: npm install groq-sdk
 *   4. Make sure server.js still has: require('./claudeStats')(app, cache);
 */

'use strict';

// ── PASTE YOUR GROQ KEY HERE ──────────────────────────────────────────────────
const GROQ_API_KEY = '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';
// ─────────────────────────────────────────────────────────────────────────────

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'openai/gpt-oss-120b'; // llama-3.3-70b-versatile was decommissioned by Groq on 2026-08-16

module.exports = function mountDraftStats(app, serverCache) {

    // ── Internal result cache ─────────────────────────────────────────────────
    let resultCache = {
        picksKey  : null,
        data      : null,
        fetchedAt : 0,
        pending   : null,
        pendingKey: null,
    };

    // ── node-fetch fallback for Node < 18 ────────────────────────────────────
    let _fetch;
    try {
        _fetch = globalThis.fetch ?? require('node-fetch');
    } catch(e) {
        console.error('[draftStats] FATAL: No fetch available. Run: npm install node-fetch');
        _fetch = null;
    }

    if (!_fetch) {
        app.get('/draft', (req, res) => res.status(500).json({ error: 'node-fetch not installed' }));
        return;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function heroName(imgPath) {
        if (!imgPath) return null;
        return imgPath
            .split('/').pop()
            .replace(/\.[^/.]+$/, '')
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .trim() || null;
    }

    function buildPicksKey(draftdata) {
        const bp = (draftdata?.blueside?.pick || []).map(p => p.hero || '').join(',');
        const rp = (draftdata?.redside?.pick  || []).map(p => p.hero || '').join(',');
        return `${bp}|${rp}`;
    }

    function getDraftdata() {
        return serverCache?.matchdraft?.draftdata ?? null;
    }

    // ── Groq prompt ───────────────────────────────────────────────────────────

    function buildPrompt(blueHeroes, redHeroes) {
        const fmt = arr => arr.length ? arr.join(', ') : '(none selected yet)';
        const blueCount = blueHeroes.length;
        const redCount = redHeroes.length;
    
       return `You are an elite Honor of Kings (HoK) draft analyst with deep expertise in KPL, World Champion Cup, and regional tournament meta. You have comprehensive knowledge of every hero's kit, synergies, counters, and statistical win rates across all patches up to the current competitive season.

Your task: Perform a rigorous, tournament-grade draft analysis of the two team compositions below and return ONLY a raw JSON object.

Do NOT include markdown, code fences, preamble, or any explanation — ONLY the JSON.

═══════════════════════════════════════════
DRAFT INFORMATION
═══════════════════════════════════════════

Blue team picks (${blueCount}/5) : ${fmt(blueHeroes)}

Red  team picks (${redCount}/5) : ${fmt(redHeroes)}

═══════════════════════════════════════════
ANALYSIS FRAMEWORK — apply ALL of the following before scoring
═══════════════════════════════════════════

1. ROLE COVERAGE
   Identify the implied roles for each side:

   * Clash Lane
   * Jungler
   * Mid Lane
   * Farm Lane
   * Roamer

   Penalise compositions missing critical roles or stacking duplicate roles heavily.

2. META ALIGNMENT
   Score how well each composition aligns with the current competitive HoK meta:

   * Strong Tyrant/Overlord control
   * Strong early jungle pressure
   * Reliable burst or sustained DPS
   * Effective CC chains
   * Strong lane priority
   * Good mobility and rotation potential
   * Reliable siege and tower pressure
   * Strong team-fight execution

   Penalise compositions that are excessively slow, immobile, weak in lane, lack objective control, or depend too heavily on a single win condition.

3. HERO SYNERGIES — PER TEAM
   Identify and weight ALL meaningful synergies:

   * Combo potential
   * Engage + follow-up
   * AoE CC chains
   * Burst setup
   * Buff/shield/healing combinations
   * Poke + engage combinations
   * Lane pressure + jungle invasion
   * Frontline + backline protection
   * Mobility + dive combinations
   * Objective control + zoning
   * Split-push + team-fight combinations

   Consider both individual hero interactions and the overall five-hero composition.

4. COUNTER RELATIONSHIPS — BLUE VS RED
   Enumerate direct counter relationships hero-by-hero:

   * Which Blue heroes directly counter specific Red heroes?
   * Which Red heroes directly counter specific Blue heroes?
   * Consider lane counters, team-fight counters, mobility counters, CC counters, burst counters, sustain counters, and macro counters.
   * Consider whether a counter remains effective throughout the game.

   Aggregate the overall advantage into counterIndex.

   counterIndex must represent the MACRO draft counter advantage rather than simply counting individual favourable matchups.

5. POWER SPIKES
   Assess when each composition peaks:

   * Early (0–8 min): lane pressure, jungle invasions, early Tyrant fights, rotations
   * Mid (8–15 min): team fights, Tyrant/Overlord contests, tower pressure
   * Late (15+ min): scaling, siege, split push, high-ground pressure, prolonged team fights

   Weight earlyMidPotential toward 0–15 minute performance.

   Weight lateGamePotential toward 15+ minute performance.

6. TEAM FIGHT PROFILE
   Evaluate:

   * AoE CC quantity and reliability
   * CC chaining potential
   * Engage reliability
   * Peel capability
   * Burst damage
   * Sustained DPS
   * Frontline durability
   * Backline protection
   * Mobility and repositioning
   * Healing, shielding, and defensive tools

   Use these factors to determine:

   * controlAbility
   * damagePotential
   * survivability

7. OBJECTIVE & MAP PRESSURE
   Evaluate:

   * Tyrant control
   * Overlord control
   * Jungle invade potential
   * Wave-clear speed
   * Tower-taking ability
   * Siege potential
   * Rotation speed
   * Vision and bush-control potential
   * Objective zoning
   * Objective stealing potential
   * Split-push pressure
   * Tower-diving safety

   Factor the overall result into pushAbility.

8. COORDINATION REQUIREMENT
   Evaluate how difficult the composition is to execute at a competitive level.

   High-combo compositions requiring:

   * precise engages
   * multi-hero ultimate chains
   * coordinated dives
   * strict positioning
   * timing-dependent abilities

   should require higher coordination.

   Simpler compositions with:

   * independent damage dealers
   * forgiving positioning
   * reliable initiation
   * solo-carry potential

   should require less coordination.

   Scale teamCoordination by the number of picks currently present.

   If fewer than 5 picks:
   teamCoordination = full-roster coordination score × (number of picks / 5)

9. DRAFT COMPLETENESS
   If a team has fewer than 5 heroes:

   * Reduce teamCoordination proportionally.
   * Reduce lineUpRating confidence by 1.0 for every missing hero.
   * Do NOT assume missing heroes or invent a fifth pick.
   * Evaluate the composition using only the heroes explicitly provided.

═══════════════════════════════════════════
OUTPUT SCHEMA — return exactly this shape
═══════════════════════════════════════════

{
"blueTeam": {
"counterIndex": <float, -5.0 to +5.0>,
"lineUpRating": <float, 1.0 to 10.0>,
"stats": {
"earlyMidPotential": <float, 1.0 to 5.0>,
"lateGamePotential": <float, 1.0 to 5.0>,
"damagePotential": <float, 1.0 to 5.0>,
"survivability": <float, 1.0 to 5.0>,
"controlAbility": <float, 1.0 to 5.0>,
"pushAbility": <float, 1.0 to 5.0>,
"teamCoordination": <float, 1.0 to 5.0>
}
},

"redTeam": {
"counterIndex": <float, -5.0 to +5.0>,
"lineUpRating": <float, 1.0 to 10.0>,
"stats": {
"earlyMidPotential": <float, 1.0 to 5.0>,
"lateGamePotential": <float, 1.0 to 5.0>,
"damagePotential": <float, 1.0 to 5.0>,
"survivability": <float, 1.0 to 5.0>,
"controlAbility": <float, 1.0 to 5.0>,
"pushAbility": <float, 1.0 to 5.0>,
"teamCoordination": <float, 1.0 to 5.0>
}
}
}

═══════════════════════════════════════════
STRICT RULES — violating any rule invalidates the output
═══════════════════════════════════════════

R1. blueTeam.counterIndex + redTeam.counterIndex MUST equal exactly 0.0.

R2. All floats must have exactly one decimal place.
Example: 3.7, NOT 3 or 3.75.

R3. Scores must be relative.
One team's meaningful advantage should generally correspond to the other's disadvantage. Avoid identical scores on mirrored stats unless the compositions are genuinely equal in that category.

R4. Never exceed range bounds:

counterIndex: -5.0 to +5.0
stats: 1.0 to 5.0
lineUpRating: 1.0 to 10.0

R5. Incomplete rosters (< 5 picks):

* Reduce teamCoordination proportionally.
* Reduce lineUpRating confidence by 1.0 for each missing hero.
* Do not invent missing heroes.

R6. Do not award strong ratings simply because individual heroes are powerful. Judge the complete composition, including role coverage, synergy, counters, scaling, objectives, and execution requirements.

R7. Distinguish between individual hero strength and actual draft value. A strong hero can still receive a lower rating if the composition does not support its win condition.

R8. counterIndex must measure the overall strategic draft advantage, including lane matchups, team-fight interactions, objective control, scaling, and macro pressure.

R9. Use only heroes explicitly present in the provided draft. Never assume unlisted heroes.

R10. Return ONLY the raw JSON. No other characters before or after the JSON object.`;

    }

    // ── Groq API call (OpenAI-compatible) ─────────────────────────────────────

    async function askGroq(blueHeroes, redHeroes) {
        console.log('[draftStats] Sending request to Groq...');

        let response;
        try {
            response = await _fetch(GROQ_API_URL, {
                method : 'POST',
                headers: {
                    'Content-Type' : 'application/json',
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                },
                body: JSON.stringify({
                    model          : GROQ_MODEL,
                    temperature    : 0.2,
                    max_tokens     : 2048,
                    reasoning_effort: 'low',
                    messages       : [
                        {
                            role   : 'system',
                            content: 'You are an expert Mobile Legends: Bang Bang analyst. You respond ONLY with raw JSON, no markdown, no explanation.',
                        },
                        {
                            role   : 'user',
                            content: buildPrompt(blueHeroes, redHeroes),
                        },
                    ],
                }),
            });
        } catch (networkErr) {
            throw new Error(`Network error reaching Groq: ${networkErr.message}`);
        }

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Groq HTTP ${response.status}: ${errText}`);
        }

        const apiData = await response.json();
        console.log('[draftStats] Groq raw response:', JSON.stringify(apiData).slice(0, 300));

        let rawText = apiData?.choices?.[0]?.message?.content ?? '';

        // gpt-oss models can burn the whole token budget on hidden reasoning
        // and leave content empty. As a last resort, try to salvage JSON
        // out of the reasoning field before giving up.
        if (!rawText) {
            const reasoningText = apiData?.choices?.[0]?.message?.reasoning ?? '';
            const jsonMatch = reasoningText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                console.warn('[draftStats] content was empty — salvaged JSON from reasoning field.');
                rawText = jsonMatch[0];
            }
        }

        if (!rawText) {
            const reason = apiData?.choices?.[0]?.finish_reason ?? 'unknown';
            throw new Error(`Groq returned empty text. finish_reason=${reason}`);
        }

        console.log('[draftStats] Groq text output:', rawText.slice(0, 300));

        // Strip any accidental markdown fences
        const cleaned = rawText.replace(/```(?:json)?|```/gi, '').trim();

        let parsed;
        try {
            parsed = JSON.parse(cleaned);
        } catch(e) {
            throw new Error(`JSON parse failed. Raw text was: ${cleaned.slice(0, 200)}`);
        }

        return parsed;
    }

    // ── Neutral fallback ──────────────────────────────────────────────────────

    const NEUTRAL = {
        blueTeam: {
            counterIndex: 0, lineUpRating: 5,
            stats: { earlyMidPotential:2.5, lateGamePotential:2.5, damagePotential:2.5,
                     survivability:2.5, controlAbility:2.5, pushAbility:2.5, teamCoordination:2.5 }
        },
        redTeam: {
            counterIndex: 0, lineUpRating: 5,
            stats: { earlyMidPotential:2.5, lateGamePotential:2.5, damagePotential:2.5,
                     survivability:2.5, controlAbility:2.5, pushAbility:2.5, teamCoordination:2.5 }
        }
    };

    // ── /draft route ──────────────────────────────────────────────────────────

    app.get('/draft', async (req, res) => {
        try {
            const force     = req.query.force === '1';
            const draftdata = getDraftdata();

            const blueHeroes = (draftdata?.blueside?.pick || [])
                .map(p => heroName(p.hero)).filter(Boolean);
            const redHeroes  = (draftdata?.redside?.pick  || [])
                .map(p => heroName(p.hero)).filter(Boolean);

            const picksKey = buildPicksKey(draftdata);
            const now      = Date.now();

            const picksChanged = picksKey !== resultCache.picksKey;
            const expired      = (now - resultCache.fetchedAt) >= 30_000;

            console.log(`[draftStats] picksKey="${picksKey}" changed=${picksChanged} expired=${expired} force=${force}`);
            console.log(`[draftStats] Blue: [${blueHeroes.join(', ')}] | Red: [${redHeroes.join(', ')}]`);

            // 1. Cache hit
            if (!force && !picksChanged && !expired && resultCache.data) {
                console.log('[draftStats] Cache hit.');
                return res.json(resultCache.data);
            }

            // 2. Picks changed mid-flight — discard old pending
            if (picksChanged && resultCache.pending) {
                console.log('[draftStats] Picks changed — discarding in-flight request.');
                resultCache.pending    = null;
                resultCache.pendingKey = null;
            }

            // 3. Same picks already in-flight — wait
            if (resultCache.pending && resultCache.pendingKey === picksKey) {
                console.log('[draftStats] Waiting for in-flight request…');
                const result = await resultCache.pending;
                return res.json(result);
            }

            // 4. Fire new Groq request
            resultCache.picksKey   = picksKey;
            resultCache.pendingKey = picksKey;
            resultCache.pending    = askGroq(blueHeroes, redHeroes)
                .then(result => {
                    resultCache.data       = result;
                    resultCache.fetchedAt  = Date.now();
                    resultCache.pending    = null;
                    resultCache.pendingKey = null;
                    console.log('[draftStats] Groq response cached successfully.');
                    return result;
                })
                .catch(err => {
                    resultCache.pending    = null;
                    resultCache.pendingKey = null;
                    throw err;
                });

            const result = await resultCache.pending;
            res.json(result);

        } catch (err) {
            console.error('[draftStats] ERROR:', err.message);

            if (resultCache.data) {
                console.warn('[draftStats] Serving stale cache after error.');
                return res.json(resultCache.data);
            }

            console.warn('[draftStats] Returning NEUTRAL fallback.');
            res.status(500).json(NEUTRAL);
        }
    });

    console.log(`[draftStats] /draft route mounted — powered by Groq (${GROQ_MODEL})`);
};