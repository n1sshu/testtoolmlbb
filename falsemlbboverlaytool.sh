#!/bin/bash

# False Overlay Tool Launcher for Linux

echo ""
echo "===================================================================="
echo "      INITIALIZING NODE.JS SERVER / MELAKUKAN INISIALISASI SERVER"
echo "===================================================================="
echo ""

# 1. Finding active IPv4 address from primary interface (Ethernet/WiFi)
echo "[STEP 1] Finding active IPv4 address (Ethernet/WiFi)..."
echo "[LANGKAH 1] Mencari alamat IPv4 dari koneksi utama..."

# Get the primary IP address (exclude localhost and virtual interfaces)
IP_ADDRESS=$(hostname -I | awk '{print $1}')

# Alternative method if above doesn't work: use ip command
if [ -z "$IP_ADDRESS" ]; then
    IP_ADDRESS=$(ip route get 1.1.1.1 | awk '{print $7;exit}')
fi

# Check if IP was successfully obtained
if [ -z "$IP_ADDRESS" ]; then
    echo ""
    echo "[FAILED] No active Ethernet or WiFi connection found."
    echo "[GAGAL] Tidak ditemukan koneksi Ethernet atau WiFi yang aktif ke Router."
    echo ""
    echo "Troubleshooting:"
    echo "1. Make sure internet/wifi is connected."
    echo "2. Make sure airplane mode is not enabled."
    read -p "Press Enter to exit... " dummy
    exit 1
fi

echo "[SUCCESS] Main Adapter IP found: $IP_ADDRESS / [BERHASIL] IP Utama ditemukan: $IP_ADDRESS"
echo ""

# 2. Save IP address to public/serverip.txt
echo "[STEP 2] Saving IP address to public/serverip.txt... / [LANGKAH 2] Menyimpan alamat IP ke file..."
echo "$IP_ADDRESS" > public/serverip.txt
echo "[SUCCESS] File has been updated. / [BERHASIL] File telah diperbarui."
echo ""

# Add a brief pause to give server time to prepare before opening browser
echo "Pausing for 2 seconds before opening browser... / Memberi jeda 2 detik..."
sleep 2

# 4. Open URL in default browser (PORT 3000)
echo "[STEP 4] Opening URL in the default browser... / [LANGKAH 4] Membuka URL di browser..."
if command -v xdg-open &> /dev/null; then
    xdg-open "http://$IP_ADDRESS:3000/hub.html" &
elif command -v gnome-open &> /dev/null; then
    gnome-open "http://$IP_ADDRESS:3000/hub.html" &
elif command -v open &> /dev/null; then
    open "http://$IP_ADDRESS:3000/hub.html" &
fi
echo ""
echo "Initialization complete. Starting server..."
echo "Inisialisasi selesai. Menjalankan server..."
sleep 2

# Clear screen
clear

echo "========================================="
echo "===========FALSE OVERLAY TOOL============="
echo "========================================="
echo ""
echo "Please Read the readme | Tolong baca readme"
echo ""
echo "========================================="
echo "Server is running on Port 3000..."
echo "Local Access: http://localhost:3000"
echo "LAN Access  : http://$IP_ADDRESS:3000"
echo ""
echo "Do not close this window!"
echo "Server sedang berjalan... Jangan tutup jendela ini!"
echo "========================================="
echo ""

# 3. Run Node.js server
node server.js

# Check if Node.js had an error
if [ $? -ne 0 ]; then
    echo ""
    echo "========================================="
    echo "[ERROR] Server failed to start."
    echo "[GALAT] Server gagal dijalankan."
    echo ""
    echo "Check if Node.js is installed or Port 3000 is in use."
    echo "========================================="
    echo ""
    read -p "Press Enter to exit... " dummy
fi
