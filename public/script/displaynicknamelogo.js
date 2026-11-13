// public/script/displaynicknamelogo.js

// 1. Inisialisasi WebSocket ke Server
const socket = new WebSocket(`ws://${window.location.host}`);

// 2. Fungsi untuk mengambil data dari Server (matchdatateam.json)
async function fetchDataAndUpdate() {
    try {
        const response = await fetch('/api/matchdata');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        updateUI(data);
    } catch (error) {
        console.error("Gagal mengambil data match:", error);
    }
}

// 3. Fungsi Mapping Data JSON ke HTML
function updateUI(data) {
    if (!data || !data.teamdata) return;

    const blue = data.teamdata.blueteam;
    const red = data.teamdata.redteam;

    // --- TIM BIRU ---
    // Pastikan ID ini ada di HTML (misal: teamnameblue diberi id="name-box-1")
    setText('name-box-1', blue.teamname);
    setText('nickblue', blue.teamname);
    setText('name-box-2', blue.score);
    updateTeamScore(blue.score, 'blue');
    setImage('displayImage1', blue.logo, "Logo Biru");

    if (blue.playerlist) {
        blue.playerlist.forEach((player, index) => {
            const htmlId = 3 + index; 
            setText(`name-box-${htmlId}`, player.name);
            setMugshot(`name-image-box-${htmlId}`, player.name);
        });
    }

    // --- TIM MERAH ---
    setText('name-box-8', red.teamname);
    setText('nickred', red.teamname);
    setText('name-box-9', red.score);
    updateTeamScore(red.score, 'red');
    setImage('displayImage2', red.logo, "Logo Merah");

    if (red.playerlist) {
        red.playerlist.forEach((player, index) => {
            const htmlId = 10 + index; 
            setText(`name-box-${htmlId}`, player.name);
            setMugshot(`name-image-box-${htmlId}`, player.name);
        });
    }

    // --- PLAYER ROTATOR (Blue = left, Red = right) ---
    setupPlayerRotator('blue', blue.playerlist);
    setupPlayerRotator('red', red.playerlist);
}

function updateTeamScore(number, team) {
    for (let i = 1; i <= 3; i++) {
        const line = document.getElementById(`${team}-s${i}`);
        
        if (line) {
            if (i <= Number(number)) {
                // Bright/Highlight color for the active line
                line.style.background = "rgb(226, 201, 126)"; 
            } else {
                // Dim/Transparent color for the inactive lines
                line.style.background = "rgba(255, 255, 255, 0.1)";
            }
        }
    }
}

// --- FUNGSI BANTUAN (HELPER) ---

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) {
        // Update teks hanya jika ada perubahan untuk efisiensi
        if (el.textContent !== text) {
            el.textContent = text || "";
            // Panggil resize
            autoResizeText(el);
        } else {
            // Jika teks sama, tetap panggil resize (untuk handle perubahan layout/window resize)
            autoResizeText(el);
        }
    }
}

// BARU: Fungsi Resize yang Lebih Kuat & Akurat
function autoResizeText(element) {
    // Validasi elemen
    if (!element || element.clientWidth === 0) return;

    // 1. Reset styling agar kita bisa mengukur ukuran "asli" berdasarkan CSS
    element.style.fontSize = ""; 
    element.style.whiteSpace = "nowrap"; // Wajib satu baris
    element.style.overflow = "hidden";   // Sembunyikan overflow saat perhitungan
    
    // 2. Ambil ukuran saat ini dari CSS (misal dari clamp/cqi)
    const style = window.getComputedStyle(element);
    let currentSize = parseFloat(style.fontSize);
    
    // Setting batas
    const minSize = 8; // Pixel
    
    // Padding horizontal (kiri + kanan) penting agar teks tidak menempel ke pinggir
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const availableWidth = element.clientWidth - padding;

    // 3. Loop Pengecilan
    // Selama lebar konten teks (scrollWidth) lebih besar dari lebar wadah (clientWidth)
    while ((element.scrollWidth > element.clientWidth) && currentSize > minSize) {
        currentSize -= 1; // Turunkan 1px setiap iterasi (bisa 0.5 jika ingin lebih presisi)
        element.style.fontSize = `${currentSize}px`;
    }

    // 4. Double Check (Safety)
    // Terkadang browser butuh 1 cycle render lagi, jika masih overflow, kurangi sedikit lagi
    if (element.scrollWidth > element.clientWidth) {
         currentSize -= 1;
         element.style.fontSize = `${currentSize}px`;
    }
}

function setImage(id, base64Data, altText) {
    const img = document.getElementById(id);
    const defaultLogo = "Assets/Other/nologo.png"; 

    if (img) {
        if (base64Data && base64Data.trim() !== "") {
            img.src = base64Data;
        } else {
            img.src = defaultLogo;
        }

        img.onerror = function() {
            this.onerror = null; 
            this.src = defaultLogo;
        };

        img.style.display = "block"; 
        img.alt = altText;
    }
}

function setMugshot(containerId, playerName) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Cek agar tidak redraw jika gambar player sama (opsional, untuk performa)
    // Tapi karena mugshot sering berubah pose, kita redraw saja:
    container.innerHTML = '';
    const img = document.createElement('img');
    
    if (playerName && playerName.trim() !== "") {
        img.src = `Assets/player/${encodeURIComponent(playerName)}.png`;
    } else {
        img.src = "Assets/player/noplayer.png";
    }

    img.onerror = function() {
        this.onerror = null; 
        this.src = "Assets/player/noplayer.png";
    };

    container.appendChild(img);
}

// ─── PLAYER ROTATOR (Blue = left side, Red = right side) ──────────────────────
// Cycles through each team's players, fading photo + name + lane icon in/out.

const ROTATE_INTERVAL = 9000; // ms between player switches
const FADE_DURATION    = 750;  // ms — keep in sync with the CSS transition duration

const rotatorState = {
    blue: { players: [], index: 0, timer: null },
    red:  { players: [], index: 0, timer: null },
};

function setupPlayerRotator(team, players) {
    const state = rotatorState[team];
    const validPlayers = (players || []).filter(p => p && p.name && p.name.trim() !== "");

    // Skip resetting the rotation if the list hasn't actually changed
    const unchanged = JSON.stringify(validPlayers) === JSON.stringify(state.players);
    state.players = validPlayers;

    if (validPlayers.length === 0) {
        clearInterval(state.timer);
        state.timer = null;
        renderRotatorSlot(team, null);
        return;
    }

    if (!unchanged) {
        state.index = Math.min(state.index, validPlayers.length - 1);
        renderRotatorSlot(team, state.players[state.index]);
    }

    if (!state.timer) {
        state.timer = setInterval(() => rotateNext(team), ROTATE_INTERVAL);
    }
}

function rotateNext(team) {
    const state = rotatorState[team];
    if (!state.players.length) return;
    state.index = (state.index + 1) % state.players.length;
    renderRotatorSlot(team, state.players[state.index]);
}

function renderRotatorSlot(team, player) {
    const wrap  = document.getElementById(`rotator-${team}`);
    const photo = document.getElementById(`rotator-${team}-photo`);
    const name  = document.getElementById(`rotator-${team}-name`);
    const lane  = document.getElementById(`rotator-${team}-lane`);
    if (!wrap || !photo || !name || !lane) return;

    wrap.classList.add('rotator-fade-out'); // fade out current slot

    setTimeout(() => {
        if (!player) {
            wrap.style.visibility = 'hidden';
            wrap.classList.remove('rotator-fade-out');
            return;
        }

        wrap.style.visibility = 'visible';
     // NEW (Matches setMugshot folder path and capitalization)
photo.src = `Assets/player/${encodeURIComponent(player.name)}.png`;
        photo.onerror = function () {
            this.onerror = null;
            this.src = "images/noplayer.png";
        };
        name.textContent = player.name;

        if (player.lane && player.lane !== "none" && player.lane.trim() !== "") {
            lane.src = `Assets/lane/${player.lane.toLowerCase()}.png`;
            lane.style.display = 'block';
            lane.onerror = function () { this.style.display = 'none'; };
        } else {
            lane.style.display = 'none';
        }

        wrap.classList.remove('rotator-fade-out'); // fade back in
    }, FADE_DURATION);
}

// --- LOGIKA KONEKSI REALTIME ---

socket.onopen = () => {
    console.log("Terhubung ke Server Overlay via WebSocket");
    fetchDataAndUpdate(); 
};

socket.onmessage = (event) => {
    try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'matchdata_update') {
            fetchDataAndUpdate();
        }
    } catch (e) {
        console.error("Error parsing WebSocket message:", e);
    }
};

socket.onclose = () => {
    console.log("Terputus dari server.");
    setTimeout(() => {
        window.location.reload(); 
    }, 3000);
};
