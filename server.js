const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const bcryptjs = require('bcryptjs');
const jwt = require('jsonwebtoken');
const AWS = require('aws-sdk');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Middleware
app.use(cors());
app.use(bodyParser.json());

// ===== API ROUTES MUST COME FIRST =====
// (Before static file serving, so /api/* routes are handled correctly)

// Database setup
const dbPath = path.join(__dirname, 'debt_tracker.db');
const db = new Database(dbPath);

// Initialize database tables
function initializeDatabase() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS debtors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uuid TEXT UNIQUE NOT NULL,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS debts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uuid TEXT UNIQUE NOT NULL,
            debtor_id INTEGER NOT NULL,
            description TEXT NOT NULL,
            amount REAL NOT NULL,
            paid REAL DEFAULT 0,
            remaining REAL NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (debtor_id) REFERENCES debtors(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uuid TEXT UNIQUE NOT NULL,
            debt_id INTEGER NOT NULL,
            amount REAL NOT NULL,
            date TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (debt_id) REFERENCES debts(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS backups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            backup_date DATETIME DEFAULT CURRENT_TIMESTAMP,
            backup_location TEXT NOT NULL,
            backup_size INTEGER,
            status TEXT DEFAULT 'completed',
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);

    // Create default user if not exists
    try {
        const existingUser = db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
        if (!existingUser) {
            const hashedPassword = bcryptjs.hashSync('admin123', 10);
            db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('admin', hashedPassword);
            console.log('✓ Default user created: admin / admin123');
        }
    } catch (err) {
        console.error('Error creating default user:', err.message);
    }
}

initializeDatabase();

// ===== AUTHENTICATION MIDDLEWARE =====

function verifyToken(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ===== AUTH ENDPOINTS =====

// Register
app.post('/api/auth/register', (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const hashedPassword = bcryptjs.hashSync(password, 10);
        const result = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hashedPassword);

        const token = jwt.sign({ userId: result.lastInsertRowid }, JWT_SECRET, { expiresIn: '30d' });

        res.json({ 
            success: true, 
            token,
            user: { id: result.lastInsertRowid, username }
        });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            res.status(400).json({ error: 'Username already exists' });
        } else {
            res.status(500).json({ error: err.message });
        }
    }
});

// Login
app.post('/api/auth/login', (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

        if (!user) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const isPasswordValid = bcryptjs.compareSync(password, user.password);

        if (!isPasswordValid) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });

        res.json({ 
            success: true, 
            token,
            user: { id: user.id, username: user.username }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== BACKUP FUNCTIONALITY =====

function createLocalBackup(userId) {
    try {
        const backupDir = path.join(__dirname, 'backups');
        
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFileName = `debt_tracker_backup_${timestamp}.db`;
        const backupPath = path.join(backupDir, backupFileName);

        fs.copyFileSync(dbPath, backupPath);

        const debtors = db.prepare('SELECT * FROM debtors WHERE user_id = ?').all(userId);
        const debts = db.prepare(`
            SELECT d.* FROM debts d
            JOIN debtors dr ON d.debtor_id = dr.id
            WHERE dr.user_id = ?
        `).all(userId);
        const payments = db.prepare(`
            SELECT p.* FROM payments p
            JOIN debts d ON p.debt_id = d.id
            JOIN debtors dr ON d.debtor_id = dr.id
            WHERE dr.user_id = ?
        `).all(userId);

        const jsonBackup = {
            timestamp: new Date().toISOString(),
            debtors,
            debts,
            payments
        };

        const jsonBackupPath = path.join(backupDir, `debt_tracker_backup_${timestamp}.json`);
        fs.writeFileSync(jsonBackupPath, JSON.stringify(jsonBackup, null, 2));

        db.prepare(`
            INSERT INTO backups (user_id, backup_date, backup_location, backup_size, status)
            VALUES (?, ?, ?, ?, ?)
        `).run(userId, new Date().toISOString(), backupPath, fs.statSync(backupPath).size, 'completed');

        console.log(`✓ Backup created: ${backupFileName}`);
        return { success: true, backupPath, jsonBackupPath };
    } catch (err) {
        console.error('Backup error:', err.message);
        return { success: false, error: err.message };
    }
}

// Automatic backup every 6 hours
setInterval(() => {
    console.log('Running scheduled backup...');
    const users = db.prepare('SELECT id FROM users').all();
    users.forEach(user => createLocalBackup(user.id));
}, 6 * 60 * 60 * 1000);

// ===== DEBTOR ENDPOINTS =====

// Get all debtors for logged-in user
app.get('/api/debtors', verifyToken, (req, res) => {
    try {
        const debtors = db.prepare(`
            SELECT d.*, 
                   COALESCE(SUM(CASE WHEN db.remaining > 0 THEN db.remaining ELSE 0 END), 0) as total_remaining
            FROM debtors d
            LEFT JOIN debts db ON d.id = db.debtor_id
            WHERE d.user_id = ?
            GROUP BY d.id
            ORDER BY d.created_at DESC
        `).all(req.userId);

        const debtorsWithDebts = debtors.map(debtor => {
            const debts = db.prepare(`
                SELECT d.id, d.uuid, d.description, d.amount, d.paid, d.remaining
                FROM debts d
                WHERE d.debtor_id = ?
            `).all(debtor.id);

            const debtsWithPayments = debts.map(debt => {
                const payments = db.prepare(`
                    SELECT amount, date, payment_method, notes FROM payments WHERE debt_id = ?
                `).all(debt.id);
                return { ...debt, payments };
            });

            return { ...debtor, debts: debtsWithPayments };
        });

        res.json(debtorsWithDebts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add debtor
app.post('/api/debtors', verifyToken, (req, res) => {
    try {
        const { name, phone } = req.body;
        const uuid = `debtor_${Date.now()}`;

        if (!name || !phone) {
            return res.status(400).json({ error: 'Name and phone required' });
        }

        const result = db.prepare(
            'INSERT INTO debtors (uuid, user_id, name, phone) VALUES (?, ?, ?, ?)'
        ).run(uuid, req.userId, name, phone);

        createLocalBackup(req.userId);

        res.json({ id: result.lastInsertRowid, uuid, name, phone, debts: [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete debtor
app.delete('/api/debtors/:id', verifyToken, (req, res) => {
    try {
        // Verify ownership
        const debtor = db.prepare('SELECT user_id FROM debtors WHERE id = ?').get(req.params.id);
        if (!debtor || debtor.user_id !== req.userId) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        db.prepare('DELETE FROM debtors WHERE id = ?').run(req.params.id);
        createLocalBackup(req.userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== DEBT ENDPOINTS =====

// Add debt
app.post('/api/debts', verifyToken, (req, res) => {
    try {
        const { debtor_id, description, amount } = req.body;
        const uuid = `debt_${Date.now()}`;

        if (!debtor_id || !description || !amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid debt data' });
        }

        // Verify ownership
        const debtor = db.prepare('SELECT user_id FROM debtors WHERE id = ?').get(debtor_id);
        if (!debtor || debtor.user_id !== req.userId) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const result = db.prepare(
            'INSERT INTO debts (uuid, debtor_id, description, amount, remaining) VALUES (?, ?, ?, ?, ?)'
        ).run(uuid, debtor_id, description, amount, amount);

        createLocalBackup(req.userId);

        res.json({ 
            id: result.lastInsertRowid, 
            uuid, 
            debtor_id, 
            description, 
            amount, 
            paid: 0, 
            remaining: amount,
            payments: []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete debt
app.delete('/api/debts/:id', verifyToken, (req, res) => {
    try {
        // Verify ownership
        const debt = db.prepare(`
            SELECT d.id FROM debts d
            JOIN debtors dr ON d.debtor_id = dr.id
            WHERE d.id = ? AND dr.user_id = ?
        `).get(req.params.id, req.userId);

        if (!debt) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        db.prepare('DELETE FROM debts WHERE id = ?').run(req.params.id);
        createLocalBackup(req.userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== PAYMENT ENDPOINTS =====

// Add payment
app.post('/api/payments', verifyToken, (req, res) => {
    try {
        const { debt_id, amount, payment_method = 'cash', notes = '' } = req.body;
        const uuid = `payment_${Date.now()}`;
        const date = new Date().toLocaleDateString();

        if (!debt_id || !amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid payment data' });
        }

        // Verify ownership
        const debt = db.prepare(`
            SELECT d.* FROM debts d
            JOIN debtors dr ON d.debtor_id = dr.id
            WHERE d.id = ? AND dr.user_id = ?
        `).get(debt_id, req.userId);

        if (!debt) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (amount > debt.remaining) {
            return res.status(400).json({ error: 'Payment exceeds remaining balance' });
        }

        const paymentResult = db.prepare(
            'INSERT INTO payments (uuid, debt_id, amount, date, payment_method, notes) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(uuid, debt_id, amount, date, payment_method, notes);

        const newRemaining = debt.remaining - amount;
        const newPaid = debt.paid + amount;

        db.prepare(
            'UPDATE debts SET paid = ?, remaining = ? WHERE id = ?'
        ).run(newPaid, newRemaining, debt_id);

        createLocalBackup(req.userId);

        res.json({ 
            id: paymentResult.lastInsertRowid,
            uuid,
            debt_id,
            amount,
            date
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== STATIC FILES & HTML (LAST) =====
// Serve HTML directly from root
app.get('/', (req, res) => {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        res.status(404).send('App not found');
    }
});

// Serve static files (MUST be after all API routes)
const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath));
}

// ===== BACKUP ENDPOINTS =====

// Get backup history
app.get('/api/backups', verifyToken, (req, res) => {
    try {
        const backups = db.prepare(`
            SELECT * FROM backups WHERE user_id = ? ORDER BY backup_date DESC LIMIT 10
        `).all(req.userId);
        res.json(backups);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Manual backup trigger
app.post('/api/backups/create', verifyToken, (req, res) => {
    try {
        const result = createLocalBackup(req.userId);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get backup files list
app.get('/api/backups/files', verifyToken, (req, res) => {
    try {
        const backupDir = path.join(__dirname, 'backups');
        
        if (!fs.existsSync(backupDir)) {
            return res.json([]);
        }

        const files = fs.readdirSync(backupDir)
            .filter(f => f.endsWith('.json') || f.endsWith('.db'))
            .map(f => ({
                name: f,
                size: fs.statSync(path.join(backupDir, f)).size,
                date: fs.statSync(path.join(backupDir, f)).mtime
            }))
            .sort((a, b) => b.date - a.date);

        res.json(files);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Download backup file
app.get('/api/backups/download/:filename', verifyToken, (req, res) => {
    try {
        const filename = req.params.filename;
        const backupDir = path.join(__dirname, 'backups');
        const filePath = path.join(backupDir, filename);

        if (!filePath.startsWith(backupDir)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        res.download(filePath);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', backupEnabled: true });
});

// Start server
app.listen(PORT, () => {
    console.log(`Debt Tracker API running on http://localhost:${PORT}`);
    console.log(`✓ Automatic backups enabled (every 6 hours)`);
    console.log(`✓ Backups stored in: ${path.join(__dirname, 'backups')}`);
    console.log(`✓ Authentication enabled`);
});
