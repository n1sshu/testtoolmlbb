// overlayControl.js
// ─────────────────────────────────────────────────────────────────
// Drop this file in the root of your project next to server.js.
// Then add ONE line near the bottom of server.js, just before
// server.listen(...):
//
//   require('./overlayControl')(app, wss);
//
// That's it. The control panel at /postdraft-control.html will now
// be able to trigger animations on the overlay at /postdraft.html.
// ─────────────────────────────────────────────────────────────────

module.exports = function(app, wss) {

    var ALLOWED_TYPES = [
        'postdraft_animate',
        'postdraft_reset',
        'postdraft_stats_only',
        'set_speed'
    ];

    app.post('/api/overlay-control', function(req, res) {
        var type  = req.body.type;
        var speed = req.body.speed;

        if (!type || ALLOWED_TYPES.indexOf(type) === -1) {
            return res.status(400).json({ error: 'Unknown type: ' + type });
        }

        var payload = JSON.stringify({ type: type, speed: speed });
        var sent = 0;

        wss.clients.forEach(function(client) {
            // WebSocket.OPEN === 1
            if (client.readyState === 1) {
                client.send(payload);
                sent++;
            }
        });

        console.log('[overlay-control] "' + type + '" sent to ' + sent + ' client(s)');
        res.json({ success: true, type: type, clients: sent });
    });

};