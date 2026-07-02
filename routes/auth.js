const express = require("express");
const router = express.Router();

const db = require("../config/db");

router.post("/login", (req, res) => {
    const { username, password } = req.body;

    const sql = "SELECT * FROM employee WHERE username = ?";

    db.query(sql, [username], async (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({
                success: false,
                message: "Server Error",
            });
        }

        if (result.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Invalid Username or Password",
            });
        }

        const user = result[0];

        try {
            if (password !== user.password) {
                return res.status(401).json({
                    success: false,
                    message: "Invalid Username or Password",
                });
            }
            return res.status(200).json({
                success: true,
                user: {
                    employee_id: user.employee_id,
                    username: user.username,
                    role: user.role,
                    full_name: user.full_name,
                    profile_image: user.profile_image
                },
            });
        } catch (error) {
            console.error(error);

            return res.status(500).json({
                success: false,
                message: "Password Verification Failed",
            });
        }
    });
});

module.exports = router;