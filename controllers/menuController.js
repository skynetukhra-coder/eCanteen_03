const db = require("../config/db");

exports.getAllItems = async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT *
            FROM menu_items
            ORDER BY item_id DESC
        `);

        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.addItem = async (req, res) => {
    try {
        const {
            image_url,
            category,
            item_name,
            price,
            available_qty,
            is_active
        } = req.body;

        await db.query(
            `
            INSERT INTO menu_items
            (
                image_url,
                category,
                item_name,
                price,
                available_qty,
                is_active
            )
            VALUES (?, ?, ?, ?, ?, ?)
        `,
            [
                image_url,
                category,
                item_name,
                price,
                available_qty,
                is_active
            ]
        );

        res.json({
            success: true,
            message: "Item Added"
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.updateItem = async (req, res) => {

    try {

        const { id } = req.params;

        const {
            image_url,
            category,
            item_name,
            price,
            available_qty,
            is_active
        } = req.body;

        await db.query(
            `
            UPDATE menu_items
            SET
                image_url=?,
                category=?,
                item_name=?,
                price=?,
                available_qty=?,
                is_active=?
            WHERE item_id=?
        `,
            [
                image_url,
                category,
                item_name,
                price,
                available_qty,
                is_active,
                id
            ]
        );

        res.json({
            success: true,
            message: "Item Updated"
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.deleteItem = async (req, res) => {

    try {

        const { id } = req.params;

        await db.query(
            `
            DELETE FROM menu_items
            WHERE item_id=?
        `,
            [id]
        );

        res.json({
            success: true,
            message: "Item Deleted"
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message });
    }
};