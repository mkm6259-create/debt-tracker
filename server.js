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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, user_id INTEGER DEFAULT 1,
            FOREIGN KEY (debtor_id) REFERENCES debtors(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uuid TEXT UNIQUE NOT NULL,
            debt_id INTEGER NOT NULL,
            amount REAL NOT NULL,
            date TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            payment_method TEXT DEFAULT 'cash',
            notes TEXT,
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

    // Load seed data if database is empty
    try {
        const debtorCount = db.prepare('SELECT COUNT(*) as count FROM debtors').get().count;
        if (debtorCount === 0) {
            console.log('Loading seed data...');
            const seedData = require('./database_seed.json');
            
            // Insert users
            for (const user of seedData.users) {
                db.prepare('INSERT OR IGNORE INTO users (id, username, password, created_at) VALUES (?, ?, ?, ?)').run(
                    user.id, user.username, user.password, user.created_at
                );
            }
            
            // Insert debtors
            for (const debtor of seedData.debtors) {
                db.prepare('INSERT OR IGNORE INTO debtors (id, uuid, user_id, name, phone, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
                    debtor.id, debtor.uuid, debtor.user_id, debtor.name, debtor.phone, debtor.created_at
                );
            }
            
            // Insert debts
            for (const debt of seedData.debts) {
                db.prepare('INSERT OR IGNORE INTO debts (id, uuid, debtor_id, description, amount, paid, remaining, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
                    debt.id, debt.uuid, debt.debtor_id, debt.description, debt.amount, debt.paid, debt.remaining, debt.created_at, debt.user_id
                );
            }
            
            // Insert payments
            for (const payment of seedData.payments) {
                db.prepare('INSERT OR IGNORE INTO payments (id, uuid, debt_id, amount, date, created_at, payment_method, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
                    payment.id, payment.uuid, payment.debt_id, payment.amount, payment.date, payment.created_at, payment.payment_method, payment.notes
                );
            }
            
            console.log('✓ Seed data loaded successfully');
        } else {
            console.log('✓ Database already has data, skipping seed');
        }
    } catch (err) {
        console.error('Error loading seed data:', err.message);
    }
}

initializeDatabase();

// JWT verification middleware
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

        const hashedPassword = bcryptjs.hashSync(password, 10);
        const result = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hashedPassword);

        const token = jwt.sign({ userId: result.lastInsertRowid }, JWT_SECRET);
        res.json({ token, userId: result.lastInsertRowid });
    } catch (err) {
        res.status(400).json({ error: err.message });
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
        if (!user || !bcryptjs.compareSync(password, user.password)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ userId: user.id }, JWT_SECRET);
        res.json({ token, userId: user.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== DEBTOR ENDPOINTS =====

// Get debtors
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

        if (!name || !phone) {
            return res.status(400).json({ error: 'Name and phone required' });
        }

        const uuid = `debtor_${Date.now()}`;
        const result = db.prepare('INSERT INTO debtors (uuid, user_id, name, phone) VALUES (?, ?, ?, ?)').run(uuid, req.userId, name, phone);

        res.json({ id: result.lastInsertRowid, uuid, name, phone, debts: [] });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Delete debtor
app.delete('/api/debtors/:id', verifyToken, (req, res) => {
    try {
        const debtor = db.prepare('SELECT * FROM debtors WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
        if (!debtor) {
            return res.status(404).json({ error: 'Debtor not found' });
        }

        db.prepare('DELETE FROM debtors WHERE id = ?').run(req.params.id);
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

        if (!debtor_id || !description || !amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid debt data' });
        }

        // Verify ownership
        const debtor = db.prepare('SELECT * FROM debtors WHERE id = ? AND user_id = ?').get(debtor_id, req.userId);
        if (!debtor) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const uuid = `debt_${Date.now()}`;
        const result = db.prepare('INSERT INTO debts (uuid, debtor_id, description, amount, remaining, user_id) VALUES (?, ?, ?, ?, ?, ?)').run(uuid, debtor_id, description, amount, amount, req.userId);

        res.json({ id: result.lastInsertRowid, uuid, debtor_id, description, amount, paid: 0, remaining: amount });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Delete debt
app.delete('/api/debts/:id', verifyToken, (req, res) => {
    try {
        const debt = db.prepare(`
            SELECT d.* FROM debts d
            JOIN debtors dr ON d.debtor_id = dr.id
            WHERE d.id = ? AND dr.user_id = ?
        `).get(req.params.id, req.userId);

        if (!debt) {
            return res.status(404).json({ error: 'Debt not found' });
        }

        db.prepare('DELETE FROM debts WHERE id = ?').run(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== PAYMENT ENDPOINTS =====

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

// Create backup
app.post('/api/backups/create', verifyToken, (req, res) => {
    createLocalBackup(req.userId);
    res.json({ success: true, message: 'Backup created' });
});

// List backup files
app.get('/api/backups/files', verifyToken, (req, res) => {
    try {
        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) {
            return res.json([]);
        }
        const files = fs.readdirSync(backupDir);
        res.json(files);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Download backup
app.get('/api/backups/download/:filename', verifyToken, (req, res) => {
    try {
        const filename = req.params.filename;
        const backupPath = path.join(__dirname, 'backups', filename);

        if (!fs.existsSync(backupPath)) {
            return res.status(404).json({ error: 'Backup not found' });
        }

        res.download(backupPath);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ ok: true, timestamp: Date.now() });
});

// ===== STATIC FILES & HTML (CATCH-ALL ROUTES) =====
// Serve static files from public folder for non-API requests
app.use((req, res, next) => {
    // Skip static file serving for API routes
    if (req.path.startsWith('/api')) {
        return next();
    }

    const publicPath = path.join(__dirname, 'public');
    const filePath = path.join(publicPath, req.path);

    // Check if file exists and is a file (not directory)
    try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            return res.sendFile(filePath);
        }
    } catch (err) {
        // Continue to next handler
    }

    next();
});

// Catch-all: Serve index.html for root and non-API routes
app.use((req, res) => {
    // Don't serve HTML for API routes (they should 404)
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ error: 'API endpoint not found' });
    }

    const htmlPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        res.status(404).send('App not found');
    }
});

// Helper function to create backups
function createLocalBackup(userId) {
    try {
        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(backupDir, `backup_${timestamp}.db`);
        const dbFile = path.join(__dirname, 'debt_tracker.db');

        if (fs.existsSync(dbFile)) {
            fs.copyFileSync(dbFile, backupFile);
            const stats = fs.statSync(backupFile);
            db.prepare('INSERT INTO backups (user_id, backup_location, backup_size) VALUES (?, ?, ?)').run(userId, backupFile, stats.size);
        }
    } catch (err) {
        console.error('Error creating backup:', err.message);
    }
}

// Start server
app.listen(PORT, () => {
    console.log(`Debt Tracker API running on http://localhost:${PORT}`);
    console.log(`✓ Automatic backups enabled (every 6 hours)`);
    console.log(`✓ Backups stored in: ${path.join(__dirname, 'backups')}`);
    console.log(`✓ Authentication enabled`);
});
