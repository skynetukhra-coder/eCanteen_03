const express = require("express");
const router = express.Router();
const db = require("../config/db");
const crypto = require("crypto");

const HMAC_SECRET = "canteen_wallet_integrity_key";

function generateWalletSignature(employeeId, balance) {
    const formattedBalance = parseFloat(balance).toFixed(2);
    return crypto
        .createHmac("sha256", HMAC_SECRET)
        .update(`${employeeId}:${formattedBalance}`)
        .digest("hex");
}


const Razorpay = require("razorpay");

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_51t91lKz9382jD",
    key_secret: process.env.RAZORPAY_KEY_SECRET || "rXz51T91lKz9382jD1234567"
});

// CREATE RAZORPAY ORDER
router.post("/razorpay-order", async (req, res) => {
    try {
        const { amount } = req.body;
        if (!amount || isNaN(amount)) {
            return res.status(400).json({ success: false, message: "Invalid amount." });
        }
        const options = {
            amount: Math.round(parseFloat(amount) * 100), // Razorpay expects amount in paise
            currency: "INR",
            receipt: `rcpt_${Date.now()}`
        };

        const rzpOrder = await razorpay.orders.create(options);
        res.json({
            success: true,
            order_id: rzpOrder.id,
            amount: rzpOrder.amount,
            currency: rzpOrder.currency
        });
    } catch (error) {
        console.error("Razorpay order creation error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// VERIFY ONLINE PAYMENT SIGNATURE
router.post("/verify-online", async (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            order_payload
        } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !order_payload) {
            return res.status(400).json({ success: false, message: "Missing required verification data." });
        }

        const sign = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSign = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "rXz51T91lKz9382jD1234567")
            .update(sign)
            .digest("hex");

        if (razorpay_signature !== expectedSign) {
            return res.status(400).json({ success: false, message: "Payment verification failed. Signature mismatch." });
        }

        // Fetch last payment ID to format next database ID (e.g., PAY0026)
        const [lastPayment] = await db.query(`
            SELECT payment_id
            FROM payments
            ORDER BY payment_id DESC
            LIMIT 1
        `);

        let paymentId = "PAY0001";
        if (lastPayment.length > 0) {
            const lastNo = parseInt(lastPayment[0].payment_id.replace("PAY", ""));
            paymentId = `PAY${String(lastNo + 1).padStart(4, "0")}`;
        }

        // Avoid duplicate order insertions (if request was sent twice)
        const [existingOrder] = await db.query(
            "SELECT order_id FROM orders WHERE coupon_code = ?",
            [order_payload.coupon_code]
        );

        let orderId;
        if (existingOrder.length > 0) {
            orderId = existingOrder[0].order_id;
        } else {
            // 1. Insert order
            const [orderResult] = await db.query(
                `INSERT INTO orders 
                (employee_id, category, total_amount, payment_mode, payment_status, order_status, coupon_code, qr_code_path) 
                VALUES (?, ?, ?, ?, 'SUCCESS', 'COUPON_GENERATED', ?, ?)`,
                [
                    order_payload.employee_id,
                    order_payload.category,
                    order_payload.total_amount,
                    order_payload.payment_mode,
                    order_payload.coupon_code,
                    `/qr/${order_payload.coupon_code}.png`
                ]
            );
            orderId = orderResult.insertId;

            // 2. Insert items
            for (const item of order_payload.items) {
                await db.query(
                    `INSERT INTO order_items 
                    (order_id, item_id, item_name, quantity, unit_price, total_price) 
                    VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        orderId,
                        item.item_id,
                        item.item_name,
                        item.quantity,
                        item.price,
                        Number(item.price) * parseInt(item.quantity)
                    ]
                );
            }
        }

        // 3. Insert payment record
        const [existingPayment] = await db.query(
            "SELECT payment_id FROM payments WHERE order_id = ?",
            [orderId]
        );

        if (existingPayment.length === 0) {
            await db.query(
                `INSERT INTO payments 
                (payment_id, order_id, employee_id, amount, payment_method, payment_status, remarks) 
                VALUES (?, ?, ?, ?, ?, 'SUCCESS', ?)`,
                [
                    paymentId,
                    orderId,
                    order_payload.employee_id,
                    order_payload.total_amount,
                    order_payload.payment_mode,
                    `Razorpay ID: ${razorpay_payment_id}`
                ]
            );

            // Log inside audit logs
            await db.query(
                "INSERT INTO audit_logs (action_name, details, severity) VALUES ('MEAL_PURCHASE_ONLINE', ?, 'INFO')",
                [`Employee ID ${order_payload.employee_id} paid ₹${order_payload.total_amount} via Online (${order_payload.payment_mode}) for Order ID ${orderId}.`]
            );
        }

        res.json({
            success: true,
            order_id: orderId,
            payment_id: paymentId
        });

    } catch (err) {
        console.error("Verification DB Error:", err);
        res.status(500).json({ success: false, message: "Internal server error during database operations." });
    }
});

// CREATE PAYMENT
router.post("/create", async (req, res) => {

    console.log("PAYMENT REQUEST:", req.body);

    try {

        const {
            order_id,
            employee_id,
            amount,
            payment_method
        } = req.body;

        let empId = employee_id;

        // Redirect admin checkouts to dedicated guest 'admin_user'
        const [empRows] = await db.query(
            "SELECT role FROM employee WHERE employee_id = ?",
            [employee_id]
        );
        if (empRows.length > 0 && empRows[0].role === 'ADMIN') {
            const [adminGuestRows] = await db.query(
                "SELECT employee_id FROM employee WHERE username = 'admin_user'"
            );
            if (adminGuestRows.length > 0) {
                empId = adminGuestRows[0].employee_id;
            }
        }

        const [lastPayment] =
            await db.query(`
                SELECT payment_id
                FROM payments
                ORDER BY payment_id DESC
                LIMIT 1
            `);

        let paymentId = "PAY0001";

        if (lastPayment.length > 0) {

            const lastNo =
                parseInt(
                    lastPayment[0]
                        .payment_id
                        .replace("PAY", "")
                );

            paymentId =
                `PAY${String(lastNo + 1)
                    .padStart(4, "0")}`;
        }

        if (payment_method === "Wallet") {
            const [walletRows] = await db.query(
                "SELECT balance, signature FROM wallets WHERE employee_id = ?",
                [empId]
            );
            if (walletRows.length === 0) {
                return res.status(400).json({ success: false, message: "Wallet not initialized." });
            }
            const currentBalance = parseFloat(walletRows[0].balance);
            const signature = walletRows[0].signature;
            const expectedSig = generateWalletSignature(empId, currentBalance);

            if (expectedSig !== signature) {
                const details = `CRITICAL ALERT: Tampering detected for Wallet of Employee ID ${empId}. Attempted meal purchase of ₹${amount} was aborted.`;
                await db.query(
                    "INSERT INTO audit_logs (action_name, details, severity) VALUES ('WALLET_TAMPERING_DETECTED', ?, 'CRITICAL')",
                    [details]
                );
                return res.status(400).json({ success: false, message: "Wallet integrity check failed. Canteen order aborted." });
            }

            const deductAmt = parseFloat(amount);
            if (currentBalance < deductAmt) {
                return res.status(400).json({ success: false, message: "Insufficient wallet balance." });
            }

            const newBalance = currentBalance - deductAmt;
            const newSig = generateWalletSignature(empId, newBalance);

            await db.query(
                "UPDATE wallets SET balance = ?, signature = ? WHERE employee_id = ?",
                [newBalance, newSig, empId]
            );

            // Log deduction in audit logs
            await db.query(
                "INSERT INTO audit_logs (action_name, details, severity) VALUES ('MEAL_PURCHASE_DEDUCTION', ?, 'INFO')",
                [`Employee ID ${empId} spent ₹${deductAmt} from Wallet for Canteen Order ID ${order_id}.`]
            );

            // Log inside wallet_transactions
            await db.query(
                "INSERT INTO wallet_transactions (employee_id, type, amount, title) VALUES (?, 'debit', ?, 'Meal Coupon (Wallet)')",
                [empId, deductAmt]
            );
        }

        await db.query(
            `
            INSERT INTO payments
            (
                payment_id,
                order_id,
                employee_id,
                amount,
                payment_method,
                payment_status
            )
            VALUES
            (?, ?, ?, ?, ?, 'SUCCESS')
            `,
            [
                paymentId,
                order_id,
                empId,
                amount,
                payment_method
            ]
        );

        res.json({
            success: true,
            payment_id: paymentId
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false
        });

    }
});


// ADMIN PAYMENT HISTORY
router.get("/", async (req, res) => {

    try {

        const [rows] = await db.query(`
            SELECT
                p.payment_id,

                CONCAT(
                    'ORD',
                    p.order_id
                ) AS order_id,

                e.full_name AS employee_name,

                p.amount,

                p.payment_method,

                p.payment_status,

                p.payment_date AS rawDate,

                DATE_FORMAT(
                    p.payment_date,
                    '%d-%m-%Y %h:%i %p'
                ) AS payment_date

            FROM payments p

            JOIN employee e
            ON p.employee_id =
               e.employee_id

            ORDER BY
                p.payment_date DESC
        `);

        res.json(rows);

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false
        });

    }

});


// EMPLOYEE PAYMENT HISTORY
router.get(
    "/employee/:employeeId",
    async (req, res) => {

        try {

            const [rows] =
                await db.query(
                    `
            SELECT

                payment_id,

                CONCAT(
                    'ORD',
                    order_id
                ) AS order_id,

                amount,

                payment_method,

                payment_status,

                payment_date

            FROM payments

            WHERE employee_id = ?

            ORDER BY
                payment_date DESC
            `,
                    [
                        req.params.employeeId
                    ]
                );

            res.json(rows);

        } catch (err) {

            res.status(500).json(err);

        }

    });

module.exports = router;