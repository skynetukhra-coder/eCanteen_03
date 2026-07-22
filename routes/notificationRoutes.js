const express = require("express");
const router = express.Router();
const db = require("../config/db");

// PUBLISH A NOTIFICATION (Announcement or Special Menu)
router.post("/publish", async (req, res) => {
    try {
        const { type, title, message, item_name, price, image_url } = req.body;

        if (!type || !title) {
            return res.status(400).json({
                success: false,
                message: "Type and Title are required."
            });
        }

        const [result] = await db.query(
            `
            INSERT INTO notifications 
            (type, title, message, item_name, price, image_url)
            VALUES (?, ?, ?, ?, ?, ?)
            `,
            [type, title, message || null, item_name || null, price || null, image_url || null]
        );

        // Log in audit_logs
        await db.query(
            "INSERT INTO audit_logs (action_name, details, severity) VALUES ('BROADCAST_PUBLISHED', ?, 'INFO')",
            [`Admin broadcasted a new ${type}: "${title}"`]
        );

        res.json({
            success: true,
            message: "Notification published successfully",
            id: result.insertId
        });
    } catch (err) {
        console.error("PUBLISH NOTIFICATION ERROR:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// LIST ALL NOTIFICATIONS
router.get("/list", async (req, res) => {
    try {
        const [rows] = await db.query(
            "SELECT * FROM notifications ORDER BY id DESC"
        );
        res.json(rows);
    } catch (err) {
        console.error("GET NOTIFICATIONS ERROR:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// DELETE A NOTIFICATION
router.delete("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        await db.query("DELETE FROM notifications WHERE id = ?", [id]);
        res.json({ success: true, message: "Notification deleted successfully" });
    } catch (err) {
        console.error("DELETE NOTIFICATION ERROR:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
