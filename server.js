require("dotenv").config();

const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");
const { buildXlsx, excelDate, STYLE } = require("./xlsx-writer");

const app = express();
const PORT = process.env.PORT || 3000;

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
});

app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

async function ensureMaintenanceTable() {
    // نقرأ نوع عمود cranes.id الفعلي عشان crane_id يطابقه (INT أو INT UNSIGNED أو غيره)
    const [cols] = await pool.query(
        `SELECT COLUMN_TYPE AS column_type
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cranes' AND COLUMN_NAME = 'id'`
    );
    const idType = cols.length ? String(cols[0].column_type || cols[0].COLUMN_TYPE) : "INT UNSIGNED";

    await pool.query(`
        CREATE TABLE IF NOT EXISTS crane_maintenance_records (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            crane_id ${idType} NOT NULL,
            maintenance_date DATE NOT NULL,
            problem_cause VARCHAR(500) NOT NULL,
            repaired_by VARCHAR(255) NOT NULL,
            spare_part_used VARCHAR(500) NULL,
            cost_egp DECIMAL(12,2) NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_crane_maintenance_crane_id (crane_id),
            CONSTRAINT fk_crane_maintenance_crane
                FOREIGN KEY (crane_id) REFERENCES cranes(id)
                ON DELETE CASCADE
        )
    `);

    // أعمدة الفاتورة (PDF) - تتضاف لو مش موجودة
    const invoiceCols = [
        ["invoice_name", "VARCHAR(255) NULL"],
        ["invoice_data", "LONGBLOB NULL"]
    ];
    for (const [column, definition] of invoiceCols) {
        try {
            await pool.query(`ALTER TABLE crane_maintenance_records ADD COLUMN ${column} ${definition}`);
        } catch (error) {
            if (error.errno !== 1060 && error.code !== "ER_DUP_FIELDNAME") {
                console.error(`Schema update for ${column} failed:`, error.message);
            }
        }
    }
}

async function ensureFinanceTable() {
    const [cols] = await pool.query(
        `SELECT COLUMN_TYPE AS column_type
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cranes' AND COLUMN_NAME = 'id'`
    );
    const idType = cols.length ? String(cols[0].column_type || cols[0].COLUMN_TYPE) : "INT UNSIGNED";

    await pool.query(`
        CREATE TABLE IF NOT EXISTS crane_finance_transactions (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            crane_id ${idType} NOT NULL,
            type ENUM('revenue','expense') NOT NULL,
            transaction_date DATE NOT NULL,
            amount DECIMAL(14,2) NOT NULL,
            details VARCHAR(500) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_crane_finance_crane_date (crane_id, transaction_date),
            CONSTRAINT fk_crane_finance_crane
                FOREIGN KEY (crane_id) REFERENCES cranes(id)
                ON DELETE CASCADE
        )
    `);
}

async function ensureCertificatesTable() {
    const [cols] = await pool.query(
        `SELECT COLUMN_TYPE AS column_type
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cranes' AND COLUMN_NAME = 'id'`
    );
    const idType = cols.length ? String(cols[0].column_type || cols[0].COLUMN_TYPE) : "INT UNSIGNED";

    await pool.query(`
        CREATE TABLE IF NOT EXISTS crane_certificates (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            crane_id ${idType} NOT NULL,
            certificate_name VARCHAR(255) NOT NULL,
            issue_date DATE NOT NULL,
            expire_date DATE NOT NULL,
            file_name VARCHAR(255) NULL,
            file_data LONGBLOB NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_crane_certificates_crane_id (crane_id),
            CONSTRAINT fk_crane_certificates_crane
                FOREIGN KEY (crane_id) REFERENCES cranes(id)
                ON DELETE CASCADE
        )
    `);

    // لو الجدول كان موجود قبل كده من غير أعمدة الـ PDF
    for (const [column, definition] of [["file_name", "VARCHAR(255) NULL"], ["file_data", "LONGBLOB NULL"]]) {
        try {
            await pool.query(`ALTER TABLE crane_certificates ADD COLUMN ${column} ${definition}`);
        } catch (error) {
            if (error.errno !== 1060 && error.code !== "ER_DUP_FIELDNAME") {
                console.error(`Schema update for certificates.${column} failed:`, error.message);
            }
        }
    }
}

async function ensurePersonsTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS persons (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            role VARCHAR(150) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_persons_name (name)
        )
    `);

    // معاملات الشخص (مصروفات / دفعات) - هتتستخدم في صفحة Open Account
    await pool.query(`
        CREATE TABLE IF NOT EXISTS person_transactions (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            person_id INT UNSIGNED NOT NULL,
            type ENUM('expense','payment') NOT NULL,
            transaction_date DATE NOT NULL,
            amount DECIMAL(14,2) NOT NULL,
            details VARCHAR(500) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_person_transactions_person (person_id),
            CONSTRAINT fk_person_transactions_person
                FOREIGN KEY (person_id) REFERENCES persons(id)
                ON DELETE CASCADE
        )
    `);
}

async function ensureCompanyTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS company_transactions (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            category ENUM('ahmed','abdalla','ayman','aly','general','revenue') NOT NULL,
            transaction_date DATE NOT NULL,
            amount DECIMAL(14,2) NOT NULL,
            details VARCHAR(500) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_company_tx_date (transaction_date)
        )
    `);
}

async function ensureSchema() {
    // These columns are added only if they don't already exist.
    const additions = [
        ["maintenance_details", "TEXT NULL"],
        ["finance_details", "TEXT NULL"],
        ["image_data", "LONGTEXT NULL"]
    ];

    for (const [column, definition] of additions) {
        try {
            await pool.query(`ALTER TABLE cranes ADD COLUMN ${column} ${definition}`);
        } catch (error) {
            // MySQL error 1060 = duplicate column; ignore it.
            if (error.errno !== 1060 && error.code !== "ER_DUP_FIELDNAME") {
                console.error(`Schema update for ${column} failed:`, error.message);
            }
        }
    }
}

// تسجيل الدخول
app.post("/api/login", async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, message: "Username and password are required." });
        }

        const [rows] = await pool.execute(
            `SELECT id, username, email, password_hash, role, is_active FROM users WHERE username = ? OR email = ? LIMIT 1`,
            [username, username]
        );

        if (rows.length === 0) {
            return res.status(401).json({ success: false, message: "Invalid username or password." });
        }

        const user = rows[0];
        if (!user.is_active) {
            return res.status(403).json({ success: false, message: "This account is disabled." });
        }

        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) {
            return res.status(401).json({ success: false, message: "Invalid username or password." });
        }

        res.json({
            success: true,
            message: "Login successful.",
            user: { id: user.id, username: user.username, email: user.email, role: user.role }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Database/server error." });
    }
});

// جلب الرافعات
app.get("/api/cranes", async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT * FROM cranes ORDER BY id DESC");
        res.json({ success: true, cranes: rows });
    } catch (error) {
        console.error("Error fetching cranes:", error);
        res.status(500).json({ success: false, message: "Database error while fetching cranes." });
    }
});

// جلب رافعة واحدة
app.get("/api/cranes/:id", async (req, res) => {
    try {
        const [cranes] = await pool.execute("SELECT * FROM cranes WHERE id = ? LIMIT 1", [req.params.id]);
        if (!cranes.length) {
            return res.status(404).json({ success: false, message: "Crane not found." });
        }

        res.json({ success: true, crane: cranes[0] });
    } catch (error) {
        console.error("Error fetching crane:", error);
        res.status(500).json({ success: false, message: "Database error while fetching crane." });
    }
});

// تعديل Current Location و Status
app.patch("/api/cranes/:id/status-location", async (req, res) => {
    try {
        const { current_location, status } = req.body;
        const allowedStatuses = ["Active", "Under Maintenance", "Inactive"];

        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid status." });
        }

        const fields = ["current_location = ?", "status = ?"];
        const values = [current_location || null, status];
        // Crane operator / helper (optional - only updated when sent)
        for (const col of ["operator_name", "helper_name"]) {
            if (req.body[col] !== undefined) {
                fields.push(`${col} = ?`);
                values.push(String(req.body[col] || "").trim().slice(0, 255) || null);
            }
        }
        values.push(req.params.id);
        await pool.execute(`UPDATE cranes SET ${fields.join(", ")} WHERE id = ?`, values);

        res.json({ success: true, message: "Crane status and location updated." });
    } catch (error) {
        console.error("Error updating crane status/location:", error);
        res.status(500).json({ success: false, message: "Database error while updating crane." });
    }
});

// حفظ Finance details (و Maintenance notes القديمة لو اتبعتت)
app.patch("/api/cranes/:id/details", async (req, res) => {
    try {
        const fields = [];
        const values = [];
        if (req.body.maintenance_details !== undefined) {
            fields.push("maintenance_details = ?");
            values.push(req.body.maintenance_details || null);
        }
        if (req.body.finance_details !== undefined) {
            fields.push("finance_details = ?");
            values.push(req.body.finance_details || null);
        }
        if (!fields.length) {
            return res.status(400).json({ success: false, message: "Nothing to update." });
        }
        values.push(req.params.id);
        await pool.execute(`UPDATE cranes SET ${fields.join(", ")} WHERE id = ?`, values);
        res.json({ success: true, message: "Details saved successfully." });
    } catch (error) {
        console.error("Error saving crane details:", error);
        res.status(500).json({ success: false, message: "Database error while saving details." });
    }
});

// ===== Maintenance records (حقول ثابتة) =====
app.get("/api/cranes/:id/maintenance", async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id, crane_id, DATE_FORMAT(maintenance_date, '%Y-%m-%d') AS maintenance_date,
                    problem_cause, repaired_by, spare_part_used, cost_egp,
                    invoice_name, (invoice_name IS NOT NULL) AS has_invoice
             FROM crane_maintenance_records
             WHERE crane_id = ?
             ORDER BY maintenance_date DESC, id DESC`,
            [req.params.id]
        );
        res.json({ success: true, records: rows });
    } catch (error) {
        console.error("Error fetching maintenance records:", error);
        res.status(500).json({ success: false, message: "Database error while fetching maintenance records." });
    }
});

app.post("/api/cranes/:id/maintenance", async (req, res) => {
    try {
        const { maintenance_date, problem_cause, repaired_by, spare_part_used, cost_egp } = req.body;

        if (!maintenance_date || !problem_cause || !String(problem_cause).trim() || !repaired_by || !String(repaired_by).trim()) {
            return res.status(400).json({ success: false, message: "Date, problem cause and repaired by are required." });
        }

        const cost = cost_egp === "" || cost_egp === undefined || cost_egp === null ? 0 : Number(cost_egp);
        if (!Number.isFinite(cost) || cost < 0) {
            return res.status(400).json({ success: false, message: "Cost must be a valid number." });
        }

        const [result] = await pool.execute(
            `INSERT INTO crane_maintenance_records
             (crane_id, maintenance_date, problem_cause, repaired_by, spare_part_used, cost_egp)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                req.params.id,
                maintenance_date,
                String(problem_cause).trim(),
                String(repaired_by).trim(),
                spare_part_used && String(spare_part_used).trim() ? String(spare_part_used).trim() : null,
                cost
            ]
        );
        res.json({ success: true, message: "Maintenance record added.", record_id: result.insertId });
    } catch (error) {
        console.error("Error adding maintenance record:", error);
        res.status(500).json({ success: false, message: "Database error while adding maintenance record." });
    }
});

// رفع فاتورة PDF لسجل صيانة (raw body، الاسم في query)
app.post(
    "/api/cranes/:id/maintenance/:recordId/invoice",
    express.raw({ type: "application/pdf", limit: "10mb" }),
    async (req, res) => {
        try {
            const file = req.body;
            if (!Buffer.isBuffer(file) || file.length === 0) {
                return res.status(400).json({ success: false, message: "Please send a PDF file." });
            }
            if (file.subarray(0, 5).toString("latin1") !== "%PDF-") {
                return res.status(400).json({ success: false, message: "The file is not a valid PDF." });
            }

            let name = String(req.query.filename || "invoice.pdf").replace(/[\\/\r\n"]/g, "_").slice(0, 200);
            if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";

            const [result] = await pool.execute(
                "UPDATE crane_maintenance_records SET invoice_name = ?, invoice_data = ? WHERE id = ? AND crane_id = ?",
                [name, file, req.params.recordId, req.params.id]
            );
            if (!result.affectedRows) {
                return res.status(404).json({ success: false, message: "Maintenance record not found." });
            }
            res.json({ success: true, message: "Invoice uploaded." });
        } catch (error) {
            console.error("Error uploading invoice:", error);
            res.status(500).json({ success: false, message: "Database error while uploading invoice." });
        }
    }
);

// فتح/تحميل الفاتورة
app.get("/api/cranes/:id/maintenance/:recordId/invoice", async (req, res) => {
    try {
        const [rows] = await pool.execute(
            "SELECT invoice_name, invoice_data FROM crane_maintenance_records WHERE id = ? AND crane_id = ? LIMIT 1",
            [req.params.recordId, req.params.id]
        );
        if (!rows.length || !rows[0].invoice_data) {
            return res.status(404).json({ success: false, message: "No invoice for this record." });
        }
        const name = rows[0].invoice_name || "invoice.pdf";
        res.set({
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`
        });
        res.send(rows[0].invoice_data);
    } catch (error) {
        console.error("Error fetching invoice:", error);
        res.status(500).json({ success: false, message: "Database error while fetching invoice." });
    }
});

// حذف الفاتورة فقط (السجل يفضل)
app.delete("/api/cranes/:id/maintenance/:recordId/invoice", async (req, res) => {
    try {
        await pool.execute(
            "UPDATE crane_maintenance_records SET invoice_name = NULL, invoice_data = NULL WHERE id = ? AND crane_id = ?",
            [req.params.recordId, req.params.id]
        );
        res.json({ success: true, message: "Invoice removed." });
    } catch (error) {
        console.error("Error removing invoice:", error);
        res.status(500).json({ success: false, message: "Database error while removing invoice." });
    }
});

app.delete("/api/cranes/:id/maintenance/:recordId", async (req, res) => {
    try {
        await pool.execute(
            "DELETE FROM crane_maintenance_records WHERE id = ? AND crane_id = ?",
            [req.params.recordId, req.params.id]
        );
        res.json({ success: true, message: "Maintenance record deleted." });
    } catch (error) {
        console.error("Error deleting maintenance record:", error);
        res.status(500).json({ success: false, message: "Database error while deleting maintenance record." });
    }
});

// إضافة رافعة
app.post("/api/cranes", async (req, res) => {
    try {
        const {
            model_name,
            serial_number,
            location,
            current_location,
            model_year,
            status,
            capacity_tons,
            operator_name,
            helper_name,
            additional_notes,
            image_data
        } = req.body;

        if (!model_name || !serial_number) {
            return res.status(400).json({ success: false, message: "Model Name and Serial Number are required." });
        }

        const sql = `
            INSERT INTO cranes
            (model_name, serial_number, location, current_location, model_year, status, capacity_tons, operator_name, helper_name, additional_notes, image_data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        await pool.execute(sql, [
            model_name,
            serial_number,
            location || null,
            current_location || null,
            model_year ? parseInt(model_year) : null,
            status || "Active",
            capacity_tons ? parseFloat(capacity_tons) : null,
            operator_name || null,
            helper_name || null,
            additional_notes || null,
            image_data || null
        ]);

        res.json({ success: true, message: "Crane added successfully." });
    } catch (error) {
        console.error("Error inserting crane:", error);
        if (error.code === "ER_DUP_ENTRY") {
            return res.status(400).json({ success: false, message: "Serial Number already exists." });
        }
        res.status(500).json({ success: false, message: "Database error: " + error.message });
    }
});

// تعديل بيانات رافعة كاملة (Edit)
app.put("/api/cranes/:id", async (req, res) => {
    try {
        const {
            model_name, serial_number, location, current_location, model_year,
            status, capacity_tons, operator_name, helper_name, additional_notes, image_data
        } = req.body;

        if (!model_name || !String(model_name).trim() || !serial_number || !String(serial_number).trim()) {
            return res.status(400).json({ success: false, message: "Model Name and Serial Number are required." });
        }
        const allowedStatuses = ["Active", "Under Maintenance", "Inactive"];
        if (status && !allowedStatuses.includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid status." });
        }

        const fields = [
            "model_name = ?", "serial_number = ?", "location = ?", "current_location = ?", "model_year = ?",
            "status = ?", "capacity_tons = ?", "operator_name = ?", "helper_name = ?", "additional_notes = ?"
        ];
        const values = [
            String(model_name).trim(),
            String(serial_number).trim(),
            location || null,
            current_location || null,
            model_year ? parseInt(model_year) : null,
            status || "Active",
            capacity_tons ? parseFloat(capacity_tons) : null,
            operator_name || null,
            helper_name || null,
            additional_notes || null
        ];
        // الصورة تتغير بس لو اتبعتت صورة جديدة
        if (image_data) {
            fields.push("image_data = ?");
            values.push(image_data);
        }
        values.push(req.params.id);

        const [result] = await pool.execute(`UPDATE cranes SET ${fields.join(", ")} WHERE id = ?`, values);
        if (!result.affectedRows) {
            return res.status(404).json({ success: false, message: "Crane not found." });
        }
        res.json({ success: true, message: "Crane updated successfully." });
    } catch (error) {
        console.error("Error updating crane:", error);
        if (error.code === "ER_DUP_ENTRY") {
            return res.status(400).json({ success: false, message: "Serial Number already exists." });
        }
        res.status(500).json({ success: false, message: "Database error: " + error.message });
    }
});

// حذف رافعة (السجلات المرتبطة بتتحذف تلقائي ON DELETE CASCADE)
app.delete("/api/cranes/:id", async (req, res) => {
    try {
        const [result] = await pool.execute("DELETE FROM cranes WHERE id = ?", [req.params.id]);
        if (!result.affectedRows) {
            return res.status(404).json({ success: false, message: "Crane not found." });
        }
        res.json({ success: true, message: "Crane deleted." });
    } catch (error) {
        console.error("Error deleting crane:", error);
        res.status(500).json({ success: false, message: "Database error while deleting crane." });
    }
});

// ===== Finance: revenue & expenses =====
app.get("/api/cranes/:id/finance", async (req, res) => {
    try {
        const year = Number(req.query.year);
        if (!Number.isInteger(year) || year < 2008 || year > 2040) {
            return res.status(400).json({ success: false, message: "Year must be between 2008 and 2040." });
        }
        const [rows] = await pool.execute(
            `SELECT id, type, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date, amount, details
             FROM crane_finance_transactions
             WHERE crane_id = ? AND transaction_date >= ? AND transaction_date <= ?
             ORDER BY transaction_date ASC, id ASC`,
            [req.params.id, `${year}-01-01`, `${year}-12-31`]
        );
        res.json({ success: true, year, transactions: rows });
    } catch (error) {
        console.error("Error fetching finance transactions:", error);
        res.status(500).json({ success: false, message: "Database error while fetching finance data." });
    }
});

app.post("/api/cranes/:id/finance", async (req, res) => {
    try {
        const { type, year, month, day, amount, details } = req.body;

        if (type !== "revenue" && type !== "expense") {
            return res.status(400).json({ success: false, message: "Type must be revenue or expense." });
        }

        const y = Number(year), m = Number(month), d = Number(day);
        const check = new Date(Date.UTC(y, m - 1, d));
        if (
            !Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) ||
            y < 2008 || y > 2040 ||
            check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d
        ) {
            return res.status(400).json({ success: false, message: "Please enter a valid day, month and year (2008-2040)." });
        }

        const value = Number(amount);
        if (!Number.isFinite(value) || value <= 0 || value > 999999999999) {
            return res.status(400).json({ success: false, message: "Amount must be a number greater than 0." });
        }

        const text = String(details || "").trim();
        if (!text) {
            return res.status(400).json({ success: false, message: "Transaction details are required." });
        }

        const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        await pool.execute(
            `INSERT INTO crane_finance_transactions (crane_id, type, transaction_date, amount, details)
             VALUES (?, ?, ?, ?, ?)`,
            [req.params.id, type, date, value, text.slice(0, 500)]
        );
        res.json({ success: true, message: type === "revenue" ? "Revenue added." : "Expense added." });
    } catch (error) {
        console.error("Error adding finance transaction:", error);
        res.status(500).json({ success: false, message: "Database error while adding transaction." });
    }
});

app.delete("/api/cranes/:id/finance/:txId", async (req, res) => {
    try {
        await pool.execute(
            "DELETE FROM crane_finance_transactions WHERE id = ? AND crane_id = ?",
            [req.params.txId, req.params.id]
        );
        res.json({ success: true, message: "Transaction deleted." });
    } catch (error) {
        console.error("Error deleting finance transaction:", error);
        res.status(500).json({ success: false, message: "Database error while deleting transaction." });
    }
});

// ===== Certificates =====
function isValidDateString(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
    const [y, m, d] = value.split("-").map(Number);
    const check = new Date(Date.UTC(y, m - 1, d));
    return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}

app.get("/api/cranes/:id/certificates", async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id, crane_id, certificate_name,
                    DATE_FORMAT(issue_date, '%Y-%m-%d') AS issue_date,
                    DATE_FORMAT(expire_date, '%Y-%m-%d') AS expire_date,
                    file_name, (file_name IS NOT NULL) AS has_file
             FROM crane_certificates
             WHERE crane_id = ?
             ORDER BY expire_date ASC, id ASC`,
            [req.params.id]
        );
        res.json({ success: true, certificates: rows });
    } catch (error) {
        console.error("Error fetching certificates:", error);
        res.status(500).json({ success: false, message: "Database error while fetching certificates." });
    }
});

app.post("/api/cranes/:id/certificates", async (req, res) => {
    try {
        const { certificate_name, issue_date, expire_date } = req.body;
        const name = String(certificate_name || "").trim();

        if (!name || !isValidDateString(issue_date) || !isValidDateString(expire_date)) {
            return res.status(400).json({ success: false, message: "Certificate name, issue date and expire date are required." });
        }
        if (expire_date < issue_date) {
            return res.status(400).json({ success: false, message: "Expire date cannot be before the issue date." });
        }

        const [result] = await pool.execute(
            `INSERT INTO crane_certificates (crane_id, certificate_name, issue_date, expire_date)
             VALUES (?, ?, ?, ?)`,
            [req.params.id, name.slice(0, 255), issue_date, expire_date]
        );
        res.json({ success: true, message: "Certificate added.", certificate_id: result.insertId });
    } catch (error) {
        console.error("Error adding certificate:", error);
        res.status(500).json({ success: false, message: "Database error while adding certificate." });
    }
});

app.delete("/api/cranes/:id/certificates/:certId", async (req, res) => {
    try {
        await pool.execute(
            "DELETE FROM crane_certificates WHERE id = ? AND crane_id = ?",
            [req.params.certId, req.params.id]
        );
        res.json({ success: true, message: "Certificate deleted." });
    } catch (error) {
        console.error("Error deleting certificate:", error);
        res.status(500).json({ success: false, message: "Database error while deleting certificate." });
    }
});

app.post(
    "/api/cranes/:id/certificates/:certId/file",
    express.raw({ type: "application/pdf", limit: "10mb" }),
    async (req, res) => {
        try {
            const file = req.body;
            if (!Buffer.isBuffer(file) || file.length === 0) {
                return res.status(400).json({ success: false, message: "Please send a PDF file." });
            }
            if (file.subarray(0, 5).toString("latin1") !== "%PDF-") {
                return res.status(400).json({ success: false, message: "The file is not a valid PDF." });
            }

            let name = String(req.query.filename || "certificate.pdf").replace(/[\\/\r\n"]/g, "_").slice(0, 200);
            if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";

            const [result] = await pool.execute(
                "UPDATE crane_certificates SET file_name = ?, file_data = ? WHERE id = ? AND crane_id = ?",
                [name, file, req.params.certId, req.params.id]
            );
            if (!result.affectedRows) {
                return res.status(404).json({ success: false, message: "Certificate not found." });
            }
            res.json({ success: true, message: "Certificate PDF uploaded." });
        } catch (error) {
            console.error("Error uploading certificate PDF:", error);
            res.status(500).json({ success: false, message: "Database error while uploading certificate PDF." });
        }
    }
);

app.get("/api/cranes/:id/certificates/:certId/file", async (req, res) => {
    try {
        const [rows] = await pool.execute(
            "SELECT file_name, file_data FROM crane_certificates WHERE id = ? AND crane_id = ? LIMIT 1",
            [req.params.certId, req.params.id]
        );
        if (!rows.length || !rows[0].file_data) {
            return res.status(404).json({ success: false, message: "No PDF for this certificate." });
        }
        res.set({
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(rows[0].file_name || "certificate.pdf")}`
        });
        res.send(rows[0].file_data);
    } catch (error) {
        console.error("Error fetching certificate PDF:", error);
        res.status(500).json({ success: false, message: "Database error while fetching certificate PDF." });
    }
});

app.delete("/api/cranes/:id/certificates/:certId/file", async (req, res) => {
    try {
        await pool.execute(
            "UPDATE crane_certificates SET file_name = NULL, file_data = NULL WHERE id = ? AND crane_id = ?",
            [req.params.certId, req.params.id]
        );
        res.json({ success: true, message: "Certificate PDF removed." });
    } catch (error) {
        console.error("Error removing certificate PDF:", error);
        res.status(500).json({ success: false, message: "Database error while removing certificate PDF." });
    }
});

// ===== Summary (Crane Summary page) =====
app.get("/api/summary", async (req, res) => {
    try {
        // السنين المتاحة من المعاملات
        const [yearRows] = await pool.query(
            `SELECT DISTINCT YEAR(transaction_date) AS y
             FROM crane_finance_transactions
             ORDER BY y DESC`
        );
        const years = yearRows.map((r) => r.y);

        // السنة المختارة: "all" أو رقم
        const yearNum = Number(req.query.year);
        const year = Number.isInteger(yearNum) && yearNum >= 2000 && yearNum <= 2100 ? yearNum : null;

        // الرافعات + المالية + الصيانة لكل رافعة
        const financeFilter = year ? "AND YEAR(transaction_date) = ?" : "";
        const params = year ? [year] : [];

        const [craneRows] = await pool.query(
            `SELECT c.id, c.model_name, c.serial_number, c.status,
                    COALESCE(f.revenue, 0)  AS revenue,
                    COALESCE(f.expenses, 0) AS expenses,
                    COALESCE(m.cnt, 0)      AS maintenance_count,
                    COALESCE(m.cost, 0)     AS maintenance_cost
             FROM cranes c
             LEFT JOIN (
                 SELECT crane_id,
                        SUM(CASE WHEN type = 'revenue' THEN amount ELSE 0 END) AS revenue,
                        SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS expenses
                 FROM crane_finance_transactions
                 WHERE 1=1 ${financeFilter}
                 GROUP BY crane_id
             ) f ON f.crane_id = c.id
             LEFT JOIN (
                 SELECT crane_id, COUNT(*) AS cnt, SUM(cost_egp) AS cost
                 FROM crane_maintenance_records
                 GROUP BY crane_id
             ) m ON m.crane_id = c.id
             ORDER BY c.id ASC`,
            params
        );

        const cranes = craneRows.map((c) => {
            const revenue = Number(c.revenue);
            const expenses = Number(c.expenses);
            return {
                id: c.id,
                model_name: c.model_name,
                serial_number: c.serial_number,
                status: c.status,
                revenue,
                expenses,
                net: revenue - expenses,
                maintenance_count: Number(c.maintenance_count),
                maintenance_cost: Number(c.maintenance_cost)
            };
        });

        // Fleet
        const fleet = {
            total: cranes.length,
            active: cranes.filter((c) => c.status === "Active").length,
            maintenance: cranes.filter((c) => c.status === "Under Maintenance").length,
            inactive: cranes.filter((c) => c.status === "Inactive").length
        };

        // Finance totals
        const revenue = cranes.reduce((a, c) => a + c.revenue, 0);
        const expenses = cranes.reduce((a, c) => a + c.expenses, 0);
        const finance = { revenue, expenses, net: revenue - expenses };

        // آخر سجلات الصيانة
        const [recentRows] = await pool.query(
            `SELECT r.crane_id, c.model_name, c.serial_number,
                    DATE_FORMAT(r.maintenance_date, '%Y-%m-%d') AS maintenance_date,
                    r.problem_cause, r.repaired_by, r.cost_egp
             FROM crane_maintenance_records r
             JOIN cranes c ON c.id = r.crane_id
             ORDER BY r.maintenance_date DESC, r.id DESC
             LIMIT 8`
        );
        const recent_maintenance = recentRows.map((r) => ({ ...r, cost_egp: Number(r.cost_egp) }));

        // تنبيهات الشهادات (منتهية أو هتنتهي خلال شهر)
        const [certRows] = await pool.query(
            `SELECT cc.crane_id, c.model_name, c.serial_number, cc.certificate_name,
                    DATE_FORMAT(cc.expire_date, '%Y-%m-%d') AS expire_date,
                    DATEDIFF(cc.expire_date, CURDATE()) AS days_left
             FROM crane_certificates cc
             JOIN cranes c ON c.id = cc.crane_id
             WHERE cc.expire_date <= DATE_ADD(CURDATE(), INTERVAL 1 MONTH)
             ORDER BY cc.expire_date ASC`
        );
        const items = certRows.map((x) => ({ ...x, days_left: Number(x.days_left) }));
        const certificate_alerts = {
            total: items.length,
            expired: items.filter((x) => x.days_left < 0).length,
            soon: items.filter((x) => x.days_left >= 0).length,
            items
        };

        res.json({
            success: true,
            year,          // null = All time
            years,
            fleet,
            finance,
            cranes,
            recent_maintenance,
            certificate_alerts
        });
    } catch (error) {
        console.error("Error building summary:", error);
        res.status(500).json({ success: false, message: "Database error while building summary." });
    }
});

// ===== Persons =====
app.get("/api/persons", async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT p.id, p.name, p.role,
                    COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount END), 0) AS total_expenses,
                    COALESCE(SUM(CASE WHEN t.type = 'payment' THEN t.amount END), 0) AS total_payments
             FROM persons p
             LEFT JOIN person_transactions t ON t.person_id = p.id
             GROUP BY p.id, p.name, p.role
             ORDER BY p.id ASC`
        );
        const persons = rows.map((row) => {
            const expenses = Number(row.total_expenses);
            const payments = Number(row.total_payments);
            return {
                id: row.id,
                name: row.name,
                role: row.role,
                total_expenses: expenses,
                total_payments: payments,
                balance: expenses - payments
            };
        });
        res.json({ success: true, persons });
    } catch (error) {
        console.error("Error fetching persons:", error);
        res.status(500).json({ success: false, message: "Database error while fetching persons." });
    }
});

function readPersonBody(body) {
    const name = String(body.name || "").trim();
    const role = String(body.role || "").trim();
    if (!name || !role) return { error: "Name and role are required." };
    if (name.length > 255 || role.length > 150) return { error: "Name or role is too long." };
    return { name, role };
}

app.post("/api/persons", async (req, res) => {
    try {
        const person = readPersonBody(req.body);
        if (person.error) return res.status(400).json({ success: false, message: person.error });

        const [result] = await pool.execute(
            "INSERT INTO persons (name, role) VALUES (?, ?)",
            [person.name, person.role]
        );
        res.json({ success: true, message: "Person added.", person_id: result.insertId });
    } catch (error) {
        console.error("Error adding person:", error);
        res.status(500).json({ success: false, message: "Database error while adding person." });
    }
});

app.put("/api/persons/:id", async (req, res) => {
    try {
        const person = readPersonBody(req.body);
        if (person.error) return res.status(400).json({ success: false, message: person.error });

        const [result] = await pool.execute(
            "UPDATE persons SET name = ?, role = ? WHERE id = ?",
            [person.name, person.role, req.params.id]
        );
        if (!result.affectedRows) {
            return res.status(404).json({ success: false, message: "Person not found." });
        }
        res.json({ success: true, message: "Person updated." });
    } catch (error) {
        console.error("Error updating person:", error);
        res.status(500).json({ success: false, message: "Database error while updating person." });
    }
});

app.delete("/api/persons/:id", async (req, res) => {
    try {
        await pool.execute("DELETE FROM persons WHERE id = ?", [req.params.id]);
        res.json({ success: true, message: "Person deleted." });
    } catch (error) {
        console.error("Error deleting person:", error);
        res.status(500).json({ success: false, message: "Database error while deleting person." });
    }
});

// ===== Excel export =====
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad2 = (n) => String(n).padStart(2, "0");

// شكل دفتر الحسابات: Date | Details | Expense | Payments - كل أيام الشهر في صفوف
function buildLedgerRows(list, year, month) {
    const H = (v) => ({ v, s: STYLE.L_HEADER });
    const rows = [[H("Date"), H("Details"), H("Expense"), H("Payments")]];

    const groups = new Map();
    for (const t of list) {
        const key = t.transaction_date.slice(0, 7);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
    }
    if (year && month) {
        const key = `${year}-${pad2(month)}`;
        if (!groups.has(key)) groups.set(key, []);
    }
    const keys = [...groups.keys()].sort();

    if (!keys.length) {
        rows.push([{ v: "", s: STYLE.L_DATE }, { v: "No transactions", s: STYLE.L_TEXT }, { v: "", s: STYLE.L_MONEY }, { v: "", s: STYLE.L_MONEY }]);
        return rows;
    }

    let grandE = 0;
    let grandP = 0;
    let lastTotalRow = 0;

    for (const key of keys) {
        const [y, m] = key.split("-").map(Number);
        const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const byDay = new Map();
        for (const t of groups.get(key)) {
            const d = Number(t.transaction_date.slice(8, 10));
            if (!byDay.has(d)) byDay.set(d, []);
            byDay.get(d).push(t);
        }

        const startRow = rows.length + 1;
        let monthE = 0;
        let monthP = 0;
        for (let d = 1; d <= days; d++) {
            const dateCell = { v: excelDate(`${key}-${pad2(d)}`), s: STYLE.L_DATE };
            const items = byDay.get(d) || [];
            if (!items.length) {
                rows.push([dateCell, { v: "", s: STYLE.L_TEXT }, { v: "", s: STYLE.L_MONEY }, { v: "", s: STYLE.L_MONEY }]);
                continue;
            }
            for (const t of items) {
                const amount = Number(t.amount);
                const isExpense = t.type === "expense";
                if (isExpense) monthE += amount; else monthP += amount;
                rows.push([
                    dateCell,
                    { v: t.details || "", s: STYLE.L_TEXT },
                    { v: isExpense ? amount : "", s: STYLE.L_MONEY },
                    { v: isExpense ? "" : amount, s: STYLE.L_MONEY }
                ]);
            }
        }
        const endRow = rows.length;
        rows.push([
            { v: "Total", s: STYLE.L_TOTAL_LABEL },
            { v: `${MONTH_NAMES[m - 1]} ${y}`, s: STYLE.L_TOTAL_LABEL },
            { v: monthE, s: STYLE.L_TOTAL_MONEY, f: `SUM(C${startRow}:C${endRow})` },
            { v: monthP, s: STYLE.L_TOTAL_MONEY, f: `SUM(D${startRow}:D${endRow})` }
        ]);
        lastTotalRow = rows.length;
        grandE += monthE;
        grandP += monthP;
    }

    if (keys.length > 1) {
        const last = rows.length;
        rows.push([
            { v: "GRAND TOTAL", s: STYLE.L_TOTAL_LABEL },
            { v: "", s: STYLE.L_TOTAL_LABEL },
            { v: grandE, s: STYLE.L_TOTAL_MONEY, f: `SUMIF(A2:A${last},"Total",C2:C${last})` },
            { v: grandP, s: STYLE.L_TOTAL_MONEY, f: `SUMIF(A2:A${last},"Total",D2:D${last})` }
        ]);
        lastTotalRow = rows.length;
    }

    rows.push([
        { v: "Balance", s: STYLE.L_TOTAL_LABEL },
        { v: "Expenses − Payments", s: STYLE.L_TOTAL_LABEL },
        { v: grandE - grandP, s: STYLE.L_TOTAL_MONEY, f: `C${lastTotalRow}-D${lastTotalRow}` },
        { v: "", s: STYLE.L_TOTAL_LABEL }
    ]);
    return rows;
}

function safeSheetName(name, id, used) {
    let base = String(name || "Person").replace(/[\[\]:*?\/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Person";
    let candidate = base;
    if (used.has(candidate.toLowerCase())) {
        const suffix = ` (${id})`;
        candidate = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(candidate.toLowerCase());
    return candidate;
}

// تصدير Excel: Summary + شيت لكل شخص بشكل دفتر الحسابات
app.post("/api/persons/export", async (req, res) => {
    try {
        const ids = Array.isArray(req.body.ids)
            ? [...new Set(req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
            : [];
        const yearNum = Number(req.body.year);
        const monthNum = Number(req.body.month);
        const year = Number.isInteger(yearNum) && yearNum >= 2000 && yearNum <= 2100 ? yearNum : null;
        const month = Number.isInteger(monthNum) && monthNum >= 1 && monthNum <= 12 ? monthNum : null;

        let people;
        if (ids.length) {
            [people] = await pool.query("SELECT id, name, role FROM persons WHERE id IN (?) ORDER BY id ASC", [ids]);
        } else {
            [people] = await pool.query("SELECT id, name, role FROM persons ORDER BY id ASC");
        }

        let txs = [];
        if (people.length) {
            [txs] = await pool.query(
                `SELECT person_id, type, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date, amount, details
                 FROM person_transactions
                 WHERE person_id IN (?)
                 ORDER BY person_id ASC, transaction_date ASC, id ASC`,
                [people.map((p) => p.id)]
            );
        }
        txs = txs.filter((t) =>
            (!year || Number(t.transaction_date.slice(0, 4)) === year) &&
            (!month || Number(t.transaction_date.slice(5, 7)) === month)
        );

        const perPerson = new Map(people.map((p) => [p.id, { person: p, list: [], expenses: 0, payments: 0 }]));
        for (const t of txs) {
            const entry = perPerson.get(t.person_id);
            if (!entry) continue;
            entry.list.push(t);
            if (t.type === "expense") entry.expenses += Number(t.amount);
            else entry.payments += Number(t.amount);
        }

        // Summary sheet
        const summaryRows = [["ID", "Name", "Role", "Total Expenses (EGP)", "Total Payments (EGP)", "Balance (EGP)"].map((v) => ({ v, s: STYLE.HEADER }))];
        let sumExp = 0;
        let sumPay = 0;
        people.forEach((p, i) => {
            const e = perPerson.get(p.id);
            const r = i + 2;
            sumExp += e.expenses;
            sumPay += e.payments;
            summaryRows.push([
                p.id, p.name, p.role,
                { v: e.expenses, s: STYLE.MONEY },
                { v: e.payments, s: STYLE.MONEY },
                { v: e.expenses - e.payments, s: STYLE.MONEY, f: `D${r}-E${r}` }
            ]);
        });
        if (people.length) {
            const last = people.length + 1;
            summaryRows.push([
                { v: "", s: STYLE.TOTAL_LABEL }, { v: "TOTAL", s: STYLE.TOTAL_LABEL }, { v: "", s: STYLE.TOTAL_LABEL },
                { v: sumExp, s: STYLE.TOTAL_MONEY, f: `SUM(D2:D${last})` },
                { v: sumPay, s: STYLE.TOTAL_MONEY, f: `SUM(E2:E${last})` },
                { v: sumExp - sumPay, s: STYLE.TOTAL_MONEY, f: `D${last + 1}-E${last + 1}` }
            ]);
        }

        // كل المعاملات في شيت واحد (بالتفاصيل والتاريخ)
        const txRows = [["Person ID", "Name", "Role", "Date", "Type", "Amount (EGP)", "Details"].map((v) => ({ v, s: STYLE.HEADER }))];
        for (const t of txs) {
            const entry = perPerson.get(t.person_id);
            if (!entry) continue;
            txRows.push([
                t.person_id,
                entry.person.name,
                entry.person.role,
                { v: excelDate(t.transaction_date), s: STYLE.DATE },
                t.type === "expense" ? "Expense" : "Payment",
                { v: Number(t.amount), s: STYLE.MONEY },
                { v: t.details || "", s: STYLE.WRAP }
            ]);
        }

        const sheets = [
            { name: "Summary", widths: [8, 28, 26, 22, 22, 18], rows: summaryRows, freezeHeader: true },
            { name: "All Transactions", widths: [11, 28, 26, 14, 12, 18, 60], rows: txRows, freezeHeader: true, autoFilter: true }
        ];
        const used = new Set(["summary", "all transactions"]);
        for (const p of people) {
            const entry = perPerson.get(p.id);
            sheets.push({
                name: safeSheetName(p.name, p.id, used),
                widths: [14, 48, 16, 16],
                rows: buildLedgerRows(entry.list, year, month),
                freezeHeader: true
            });
        }

        const buffer = buildXlsx(sheets);
        const stamp = new Date().toISOString().slice(0, 10);
        const baseName = people.length === 1
            ? `${String(people[0].name).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "person"}-account`
            : "persons";
        res.set({
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="persons-${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent(`${baseName}-${stamp}.xlsx`)}`
        });
        res.send(buffer);
    } catch (error) {
        console.error("Error exporting persons:", error);
        res.status(500).json({ success: false, message: "Could not generate the Excel file." });
    }
});

// ----- Person account (expenses & payments) -----
app.get("/api/persons/:id/account", async (req, res) => {
    try {
        const [people] = await pool.execute("SELECT id, name, role FROM persons WHERE id = ? LIMIT 1", [req.params.id]);
        if (!people.length) {
            return res.status(404).json({ success: false, message: "Person not found." });
        }
        const [rows] = await pool.execute(
            `SELECT id, type, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date, amount, details
             FROM person_transactions
             WHERE person_id = ?
             ORDER BY transaction_date DESC, id DESC`,
            [req.params.id]
        );
        const transactions = rows.map((r) => ({ ...r, amount: Number(r.amount) }));
        const total_expenses = transactions.filter((t) => t.type === "expense").reduce((a, t) => a + t.amount, 0);
        const total_payments = transactions.filter((t) => t.type === "payment").reduce((a, t) => a + t.amount, 0);
        res.json({
            success: true,
            person: people[0],
            transactions,
            totals: { total_expenses, total_payments, balance: total_expenses - total_payments }
        });
    } catch (error) {
        console.error("Error fetching person account:", error);
        res.status(500).json({ success: false, message: "Database error while fetching the account." });
    }
});

app.post("/api/persons/:id/transactions", async (req, res) => {
    try {
        const { type, transaction_date, amount, details } = req.body;
        if (type !== "expense" && type !== "payment") {
            return res.status(400).json({ success: false, message: "Type must be expense or payment." });
        }
        if (!isValidDateString(transaction_date)) {
            return res.status(400).json({ success: false, message: "Please enter a valid date." });
        }
        const value = Number(amount);
        if (!Number.isFinite(value) || value <= 0 || value > 999999999999) {
            return res.status(400).json({ success: false, message: "Amount must be a number greater than 0." });
        }
        const text = String(details || "").trim().slice(0, 500) || null;

        const [people] = await pool.execute("SELECT id FROM persons WHERE id = ? LIMIT 1", [req.params.id]);
        if (!people.length) {
            return res.status(404).json({ success: false, message: "Person not found." });
        }

        await pool.execute(
            `INSERT INTO person_transactions (person_id, type, transaction_date, amount, details)
             VALUES (?, ?, ?, ?, ?)`,
            [req.params.id, type, transaction_date, value, text]
        );
        res.json({ success: true, message: type === "expense" ? "Expense added." : "Payment added." });
    } catch (error) {
        console.error("Error adding person transaction:", error);
        res.status(500).json({ success: false, message: "Database error while adding the transaction." });
    }
});

app.delete("/api/persons/:id/transactions/:txId", async (req, res) => {
    try {
        await pool.execute(
            "DELETE FROM person_transactions WHERE id = ? AND person_id = ?",
            [req.params.txId, req.params.id]
        );
        res.json({ success: true, message: "Transaction deleted." });
    } catch (error) {
        console.error("Error deleting person transaction:", error);
        res.status(500).json({ success: false, message: "Database error while deleting the transaction." });
    }
});

// ===== Company Finance =====
const COMPANY_CATEGORIES = ["ahmed", "abdalla", "ayman", "aly", "general", "revenue"];

app.get("/api/company", async (req, res) => {
    try {
        const { from, to } = req.query;
        if (!isValidDateString(from) || !isValidDateString(to) || to < from) {
            return res.status(400).json({ success: false, message: "Valid from/to dates are required." });
        }
        const [rows] = await pool.execute(
            `SELECT id, category, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date, amount, details
             FROM company_transactions
             WHERE transaction_date >= ? AND transaction_date <= ?
             ORDER BY transaction_date ASC, id ASC`,
            [from, to]
        );
        res.json({ success: true, transactions: rows.map((r) => ({ ...r, amount: Number(r.amount) })) });
    } catch (error) {
        console.error("Error fetching company transactions:", error);
        res.status(500).json({ success: false, message: "Database error while fetching company transactions." });
    }
});

app.post("/api/company", async (req, res) => {
    try {
        const { category, transaction_date, amount, details } = req.body;
        if (!COMPANY_CATEGORIES.includes(category)) {
            return res.status(400).json({ success: false, message: "Invalid category." });
        }
        if (!isValidDateString(transaction_date)) {
            return res.status(400).json({ success: false, message: "Please enter a valid date." });
        }
        const value = Number(amount);
        if (!Number.isFinite(value) || value <= 0 || value > 999999999999) {
            return res.status(400).json({ success: false, message: "Amount must be a number greater than 0." });
        }
        const text = String(details || "").trim().slice(0, 500) || null;

        await pool.execute(
            `INSERT INTO company_transactions (category, transaction_date, amount, details) VALUES (?, ?, ?, ?)`,
            [category, transaction_date, value, text]
        );
        res.json({ success: true, message: "Transaction added." });
    } catch (error) {
        console.error("Error adding company transaction:", error);
        res.status(500).json({ success: false, message: "Database error while adding the transaction." });
    }
});

app.delete("/api/company/:id", async (req, res) => {
    try {
        await pool.execute("DELETE FROM company_transactions WHERE id = ?", [req.params.id]);
        res.json({ success: true, message: "Transaction deleted." });
    } catch (error) {
        console.error("Error deleting company transaction:", error);
        res.status(500).json({ success: false, message: "Database error while deleting the transaction." });
    }
});

app.use((err, req, res, next) => {
    if (err && err.type === "entity.too.large") {
        return res.status(413).json({ success: false, message: "File is too large (max 10 MB)." });
    }
    next(err);
});

async function start() {
    try {
        await ensureSchema();
        await ensureMaintenanceTable();
        await ensureFinanceTable();
        await ensureCertificatesTable();
        await ensurePersonsTables();
        await ensureCompanyTable();
        app.listen(PORT, () => {
            console.log(`Liebherr website running on http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error("Could not initialize database schema:", error);
        process.exit(1);
    }
}

start();
