const express = require("express");
const router = express.Router();
const db = require("../config/db");
const crypto = require("crypto");

const HMAC_SECRET = "canteen_wallet_integrity_key";

// Helper function to generate HMAC signature for wallet balances
function generateWalletSignature(employeeId, balance) {
    const formattedBalance = parseFloat(balance).toFixed(2);
    return crypto
        .createHmac("sha256", HMAC_SECRET)
        .update(`${employeeId}:${formattedBalance}`)
        .digest("hex");
}

// GET ALL EMPLOYEE WALLETS WITH INTEGRITY VERIFICATION (ADMIN END)
router.get("/list", async (req, res) => {
    try {
        const [employees] = await db.query(`
            SELECT
                e.employee_id,
                e.username,
                e.full_name,
                e.designation,
                IFNULL(w.balance, 0.00) AS balance,
                w.signature
            FROM employee e
            LEFT JOIN wallets w ON e.employee_id = w.employee_id
            WHERE e.role != 'ADMIN'
        `);

        // Verify signatures of all active wallets
        const checkedEmployees = await Promise.all(
            employees.map(async (emp) => {
                const bal = parseFloat(emp.balance);
                const hasWallet = emp.signature !== null;

                if (hasWallet) {
                    const expectedSig = generateWalletSignature(emp.employee_id, bal);
                    if (expectedSig !== emp.signature) {
                        emp.is_tampered = true;

                        // Insert critical warning into audit log if not already logged recently
                        const details = `CRITICAL WARNING: Wallet balance for Employee ID ${emp.employee_id} (${emp.full_name}) has been tampered with! Database balance: ₹${emp.balance}`;
                        const [logs] = await db.query(
                            "SELECT log_id FROM audit_logs WHERE action_name = 'WALLET_TAMPERING_DETECTED' AND details LIKE ? AND created_at > NOW() - INTERVAL 1 HOUR",
                            [`%Employee ID ${emp.employee_id}%`]
                        );

                        if (logs.length === 0) {
                            await db.query(
                                "INSERT INTO audit_logs (action_name, details, severity) VALUES ('WALLET_TAMPERING_DETECTED', ?, 'CRITICAL')",
                                [details]
                            );
                        }
                    } else {
                        emp.is_tampered = false;
                    }
                } else {
                    emp.is_tampered = false;
                }
                return emp;
            })
        );

        res.json(checkedEmployees);
    } catch (err) {
        console.error("GET WALLETS LIST ERROR:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET EMPLOYEE WALLET BALANCE & VERIFY SIGNATURE (EMPLOYEE READ-ONLY END)
router.get("/balance/:employeeId", async (req, res) => {
    try {
        const { employeeId } = req.params;

        const [rows] = await db.query(
            "SELECT balance, signature FROM wallets WHERE employee_id = ?",
            [employeeId]
        );

        if (rows.length === 0) {
            // If no wallet exists yet, initialize it
            const initialBalance = 0.00;
            const sig = generateWalletSignature(employeeId, initialBalance);
            await db.query(
                "INSERT INTO wallets (employee_id, balance, signature) VALUES (?, ?, ?)",
                [employeeId, initialBalance, sig]
            );

            return res.json({
                balance: initialBalance,
                is_tampered: false
            });
        }

        const balance = parseFloat(rows[0].balance);
        const signature = rows[0].signature;
        const expectedSig = generateWalletSignature(employeeId, balance);

        let is_tampered = false;
        if (expectedSig !== signature) {
            is_tampered = true;
            const details = `CRITICAL WARNING: Wallet balance read for Employee ID ${employeeId} failed signature check. Balance: ₹${balance}`;
            await db.query(
                "INSERT INTO audit_logs (action_name, details, severity) VALUES ('WALLET_TAMPERING_DETECTED', ?, 'CRITICAL')",
                [details]
            );
        }

        res.json({
            balance,
            is_tampered
        });

    } catch (err) {
        console.error("GET BALANCE ERROR:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// MODIFY WALLET BALANCE (ADMIN END - SECURED BY PASSWORD)
router.post("/modify", async (req, res) => {
    try {
        const { employee_id, amount, admin_id, admin_password } = req.body;

        if (!employee_id || amount === undefined || !admin_id || !admin_password) {
            return res.status(400).json({
                success: false,
                message: "Missing required fields (employee_id, amount, admin_id, admin_password)."
            });
        }

        // 1. Verify Admin Password/PIN
        const [adminRows] = await db.query(
            "SELECT password, full_name FROM employee WHERE employee_id = ? AND role = 'ADMIN'",
            [admin_id]
        );

        if (adminRows.length === 0) {
            return res.status(403).json({
                success: false,
                message: "Authorization failed. Only administrators can modify wallets."
            });
        }

        const storedPassword = adminRows[0].password;
        if (storedPassword !== admin_password) {
            return res.status(403).json({
                success: false,
                message: "Invalid administrator password. Access denied."
            });
        }

        const changeAmt = parseFloat(amount);

        // 2. Fetch current wallet balance
        const [walletRows] = await db.query(
            "SELECT balance FROM wallets WHERE employee_id = ?",
            [employee_id]
        );

        let currentBalance = 0.00;
        let isNew = true;

        if (walletRows.length > 0) {
            currentBalance = parseFloat(walletRows[0].balance);
            isNew = false;
        }

        const newBalance = currentBalance + changeAmt;
        if (newBalance < 0) {
            return res.status(400).json({
                success: false,
                message: "Wallet balance cannot drop below zero."
            });
        }

        // 3. Generate new secure signature
        const newSig = generateWalletSignature(employee_id, newBalance);

        // 4. Update database
        if (isNew) {
            await db.query(
                "INSERT INTO wallets (employee_id, balance, signature) VALUES (?, ?, ?)",
                [employee_id, newBalance, newSig]
            );
        } else {
            await db.query(
                "UPDATE wallets SET balance = ?, signature = ? WHERE employee_id = ?",
                [newBalance, newSig, employee_id]
            );
        }

        // 5. Log activity in audit_logs
        const actionType = changeAmt >= 0 ? "WALLET_RECHARGE" : "WALLET_DEDUCTION";
        const detailsMsg = `Admin ${adminRows[0].full_name} (ID: ${admin_id}) modified Wallet for Employee ID ${employee_id}. Amount: ₹${changeAmt >= 0 ? "+" : ""}${changeAmt}. New Balance: ₹${newBalance}.`;
        
        await db.query(
            "INSERT INTO audit_logs (action_name, details, severity) VALUES (?, ?, 'INFO')",
            [actionType, detailsMsg]
        );

        // 6. Log transaction inside wallet_transactions
        await db.query(
            "INSERT INTO wallet_transactions (employee_id, type, amount, title) VALUES (?, ?, ?, ?)",
            [employee_id, changeAmt >= 0 ? "credit" : "debit", Math.abs(changeAmt), changeAmt >= 0 ? "Admin Recharge" : "Admin Deduction"]
        );

        res.json({
            success: true,
            message: `Wallet modified successfully. New balance: ₹${newBalance}`,
            newBalance
        });

    } catch (err) {
        console.error("MODIFY WALLET ERROR:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET RECENT AUDIT LOGS FOR THE ADMIN VIEW
router.get("/audit-logs", async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT
                log_id,
                action_name,
                details,
                severity,
                created_at AS rawDate,
                DATE_FORMAT(created_at, '%d-%m-%Y %h:%i %p') AS time
            FROM audit_logs
            ORDER BY log_id DESC
        `);
        res.json(rows);
    } catch (err) {
        console.error("GET AUDIT LOGS ERROR:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// RUN A MANUAL VERIFICATION SCAN FOR ALL WALLETS
router.post("/verify-all", async (req, res) => {
    try {
        const [wallets] = await db.query(`
            SELECT w.wallet_id, w.employee_id, w.balance, w.signature, e.full_name
            FROM wallets w
            JOIN employee e ON w.employee_id = e.employee_id
        `);

        let tamperedCount = 0;
        const results = [];

        for (const w of wallets) {
            const bal = parseFloat(w.balance);
            const expectedSig = generateWalletSignature(w.employee_id, bal);
            const isTampered = expectedSig !== w.signature;

            if (isTampered) {
                tamperedCount++;
                const details = `CRITICAL WARNING: Wallet balance for Employee ID ${w.employee_id} (${w.full_name}) has been tampered with! Database balance: ₹${w.balance}`;
                await db.query(
                    "INSERT INTO audit_logs (action_name, details, severity) VALUES ('WALLET_TAMPERING_DETECTED', ?, 'CRITICAL')",
                    [details]
                );
            }

            results.push({
                employee_id: w.employee_id,
                full_name: w.full_name,
                balance: bal,
                is_tampered: isTampered
            });
        }

        res.json({
            success: true,
            total_checked: wallets.length,
            tampered_count: tamperedCount,
            results
        });

    } catch (err) {
        console.error("VERIFY ALL WALLETS ERROR:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET WALLET TRANSACTIONS LIST FOR SINGLE EMPLOYEE (INCLUDING RECHARGES AND DEDUCTIONS)
router.get("/transactions/:employeeId", async (req, res) => {
    try {
        const { employeeId } = req.params;
        const [rows] = await db.query(`
            SELECT
                transaction_id AS id,
                type,
                title,
                amount,
                DATE_FORMAT(created_at, '%d %b %Y') AS date
            FROM wallet_transactions
            WHERE employee_id = ?
            ORDER BY transaction_id DESC
        `, [employeeId]);
        res.json(rows);
    } catch (err) {
        console.error("GET TRANSACTIONS ERROR:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET WALLET STATS (RECHARGE TODAY AND TREND)
router.get("/stats", async (req, res) => {
    try {
        const [todayRow] = await db.query(`
            SELECT IFNULL(SUM(amount), 0.00) AS total 
            FROM wallet_transactions 
            WHERE type = 'credit' AND DATE(created_at) = CURDATE()
        `);
        const todayRecharges = parseFloat(todayRow[0].total);

        // Fetch recharges for last 7 days grouped by day name
        const [trendRows] = await db.query(`
            SELECT 
                DATE_FORMAT(MIN(created_at), '%a') AS day, 
                IFNULL(SUM(amount), 0.00) AS amount
            FROM wallet_transactions 
            WHERE type = 'credit' 
              AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) 
            GROUP BY DATE(created_at) 
            ORDER BY DATE(created_at) ASC
        `);

        // Ensure we always return at least some trend data (fill with defaults if empty)
        const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
        const trendMap = {};
        days.forEach(d => trendMap[d] = 0);
        trendRows.forEach(row => {
            trendMap[row.day] = parseFloat(row.amount);
        });

        const trendData = days.map(d => ({
            day: d,
            amount: trendMap[d]
        }));

        res.json({
            todayRecharges,
            trendData
        });
    } catch (err) {
        console.error("GET STATS ERROR:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
