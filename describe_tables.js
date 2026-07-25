const mysql = require("mysql2/promise");

async function main() {
    const connection = await mysql.createConnection({
        host: "localhost",
        user: "root",
        password: "1234",
        database: "canteen"
    });
    
    try {
        const [rows] = await connection.query("DESCRIBE menu_items");
        console.log("menu_items schema:", rows);
    } catch (e) {
        console.log("Error:", e.message);
    }

    await connection.end();
}

main().catch(console.error);

