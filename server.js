const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

// Initialize
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const db = new Database('devices.db');

app.use(express.json());

// ================================
// DB SCHEMA
// ================================
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    registered_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS device_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
    data TEXT,
    FOREIGN KEY (device_id) REFERENCES devices(id)
  );

  CREATE INDEX IF NOT EXISTS idx_device_data_device ON device_data(device_id);
`);

// ================================
// PURGE OLD DEVICE DATA (TTL)
// ================================
function purgeOldDeviceData() {
    const stmt = db.prepare(`
    DELETE FROM device_data
    WHERE id NOT IN (
      SELECT MAX(id) FROM device_data GROUP BY device_id
    );
  `);
    stmt.run();
    console.log('🧹 Old device data purged.');
}

// Run purge once on startup and then every 24 hours
purgeOldDeviceData();
setInterval(purgeOldDeviceData, 24 * 60 * 60 * 1000);

// ================================
// 1. POST /device-data
// ================================
app.post('/device-data', (req, res) => {
    const { device_id, data } = req.body;

    if (!device_id || !data) {
        return res.status(400).json({ error: 'device_id and data are required' });
    }

    // Register device if not exists
    const deviceStmt = db.prepare('INSERT OR IGNORE INTO devices (id) VALUES (?)');
    deviceStmt.run(device_id);

    // Store data
    const insertStmt = db.prepare('INSERT INTO device_data (device_id, data) VALUES (?, ?)');
    insertStmt.run(device_id, JSON.stringify(data));

    // Emit update to sockets
    io.emit('device-update', { device_id, data });

    return res.json({ success: true });
});

// ================================
// 2. SOCKET.IO
// ================================
io.on('connection', (socket) => {
    console.log('🔌 Client connected');

    socket.on('disconnect', () => {
        console.log('❌ Client disconnected');
    });
});


// ================================
// 3. GET /devices
// ================================
app.get('/devices', (req, res) => {
    const rows = db.prepare('SELECT id, registered_at FROM devices ORDER BY registered_at DESC').all();
    res.json(rows);
});

// ================================
// 4. POST /register-device
// ================================
app.post('/register-device', (req, res) => {
    const { device_id } = req.body;

    if (!device_id) {
        return res.status(400).json({ error: 'device_id is required' });
    }

    // Try insert (no error if already exists)
    const stmt = db.prepare('INSERT OR IGNORE INTO devices (id) VALUES (?)');
    const result = stmt.run(device_id);

    if (result.changes > 0) {
        return res.json({ registered: true, message: 'Device registered successfully.' });
    } else {
        return res.json({ registered: false, message: 'Device already registered.' });
    }
});

// ================================
// 6. GET /device-data
// ================================
// Get latest data per device
app.get('/device-data', (req, res) => {
    const stmt = db.prepare(`
        SELECT dd.device_id, dd.timestamp, dd.data
        FROM device_data dd
        INNER JOIN (
            SELECT device_id, MAX(id) AS max_id
            FROM device_data
            GROUP BY device_id
        ) latest ON dd.id = latest.max_id
        ORDER BY dd.timestamp DESC
    `);

    const rows = stmt.all();
    const formatted = rows.map(row => ({
        device_id: row.device_id,
        timestamp: row.timestamp,
        data: JSON.parse(row.data)
    }));

    res.json(formatted);
});

// ================================
// Start Server
// ================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server listening on http://localhost:${PORT}`);
});
