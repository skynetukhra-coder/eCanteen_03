const express = require("express");
const router = express.Router();
const db = require("../config/db");
const verifyToken = require("../middleware/verifyToken");

// GET EMPLOYEE PROFILE
router.get("/profile", verifyToken, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT employee_id, username, full_name, role, email, mobile, designation, profile_image 
             FROM employee 
             WHERE username = ?`,
            [req.user.username]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                message: "Employee profile not found"
            });
        }

        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({
            message: error.message
        });
    }
});

// GET ALL EMPLOYEES (ADMIN END)
router.get("/list", async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT employee_id, username, full_name, role, email, mobile, designation, profile_image, created_at
            FROM employee
            ORDER BY employee_id DESC
        `);
        res.json(rows);
    } catch (error) {
        console.error("GET EMPLOYEES ERROR:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// UPDATE EMPLOYEE PROFILE
router.put("/profile/update", async (req, res) => {
    try {
        const { employee_id, full_name, email, google_email, mobile, designation } = req.body;
        if (!employee_id) {
            return res.status(400).json({ success: false, message: "Employee ID is required." });
        }

        await db.query(
            `UPDATE employee 
             SET full_name = ?, email = ?, google_email = ?, mobile = ?, designation = ?
             WHERE employee_id = ?`,
            [full_name, email || null, google_email || null, mobile || null, designation || null, employee_id]
        );

        res.json({
            success: true,
            message: "Profile updated successfully."
        });
    } catch (error) {
        console.error("UPDATE PROFILE ERROR:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;