const db = require("./config/db");

async function insertAdminUser() {
    try {
        const [rows] = await db.query(
            "SELECT employee_id FROM employee WHERE username = 'admin_user'"
        );

        if (rows.length === 0) {
            await db.query(`
                INSERT INTO employee (username, password, full_name, role, email, mobile, designation)
                VALUES ('admin_user', '12345', 'Admin Canteen Guest', 'EMPLOYEE', 'admin_canteen@cag.gov.in', '0000000000', 'Guest Counter')
            `);
            console.log("✅ admin_user inserted successfully.");
        } else {
            console.log("✅ admin_user already exists. ID:", rows[0].employee_id);
        }
    } catch (err) {
        console.error("❌ Error inserting admin_user:", err);
    } finally {
        process.exit();
    }
}

insertAdminUser();
