import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedRateCard } from './seeds/rateCard202608.js';
import { importRateWorkbook } from './utils/rateImport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.DB_PATH || path.join(__dirname, '../database.db');

let rawDb = null; // native better-sqlite3 Database
let db = null;    // sql.js-compatible shim (keeps existing code + call sites working)

// better-sqlite3 rejects `undefined` and boolean bind params; sql.js tolerated
// them. Coerce undefined→null and boolean→0/1 to preserve existing behaviour.
const normParams = (params) => (Array.isArray(params) ? params : [params]).map((p) =>
  p === undefined ? null : (typeof p === 'boolean' ? (p ? 1 : 0) : p)
);

// Minimal shim so the existing migration/seed code and every `db.exec(...)`
// result-reader (which expected sql.js's [{columns, values}] shape) keep working
// unchanged on top of the native driver.
const makeShim = (raw) => ({
  prepare: (sql) => {
    const stmt = raw.prepare(sql);
    return {
      run: (...params) => stmt.run(...normParams(params)),
      get: (...params) => stmt.get(...normParams(params)) ?? null,
      all: (...params) => stmt.all(...normParams(params)),
    };
  },
  // DDL / no-param → exec; parameterised → prepared run
  run: (sql, params) => {
    if (params === undefined) { raw.exec(sql); return; }
    raw.prepare(sql).run(...normParams(params));
  },
  // Row-returning SQL (SELECT/PRAGMA) → sql.js-shaped [{columns, values}];
  // everything else just executes (supports multi-statement DDL).
  exec: (sql) => {
    const head = String(sql).replace(/^[\s(]+/, '').slice(0, 6).toUpperCase();
    if (head === 'SELECT' || head === 'PRAGMA') {
      const rows = raw.prepare(sql).all();
      if (!rows.length) return [];
      const columns = Object.keys(rows[0]);
      return [{ columns, values: rows.map((r) => columns.map((c) => r[c])) }];
    }
    raw.exec(sql);
    return [];
  },
});

// Initialize the database (synchronous with better-sqlite3)
const initDatabase = () => {
  rawDb = new Database(dbPath);
  rawDb.pragma('journal_mode = WAL'); // durability + real concurrency
  // Match the previous engine (sql.js) which did NOT enforce foreign keys, so this
  // migration changes durability only — not insert/delete semantics. (Can be turned
  // on later as a separate, tested change.)
  rawDb.pragma('foreign_keys = OFF');
  db = makeShim(rawDb);

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ps_number TEXT UNIQUE,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('vendor', 'coordinator', 'admin', 'manager', 'initiator', 'user', 'final_approver')),
      manager_id INTEGER,
      must_change_password INTEGER DEFAULT 1,
      profile_completed INTEGER DEFAULT 1,
      profile_verified_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (manager_id) REFERENCES users(id)
    )
  `);


  db.run(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      vendor_name TEXT,
      invoice_number TEXT,
      amount DECIMAL(10, 2),
      invoice_date DATE,
      file_path TEXT,
      assigned_to TEXT,
      assigned_to_user_id INTEGER,
      assigned_to_name TEXT,
      assigned_by_user_id INTEGER,
      assigned_by_name TEXT,
      assigned_at DATETIME,
      accepted_by_user_id INTEGER,
      accepted_by_name TEXT,
      accepted_at DATETIME,
      voucher_submitted_at DATETIME,
      completed_at DATETIME,
      po_number TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'assigned', 'voucher_created')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS invoice_assignment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      action_by_user_id INTEGER,
      action_by_name TEXT,
      assigned_to_user_id INTEGER,
      assigned_to_name TEXT,
      voucher_id INTEGER,
      notes TEXT,
      action_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (action_by_user_id) REFERENCES users(id),
      FOREIGN KEY (assigned_to_user_id) REFERENCES users(id)
    )
  `);

  // Purchase Orders Table
  db.run(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_number TEXT UNIQUE NOT NULL,
      description TEXT,
      vendor_name TEXT,
      buyer_name TEXT,
      buyer_email TEXT,
      total_budget DECIMAL(15, 2) NOT NULL,
      start_date DATE,
      end_date DATE,
      po_date DATE,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'closed', 'hold')),
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  // Migration: Add po_date if it doesn't exist
  try {
    const tableInfoResult = db.exec("PRAGMA table_info(purchase_orders)");
    const columns = tableInfoResult.length > 0 ? tableInfoResult[0].values : [];
    const columnNames = columns.map(col => col[1]);

    if (!columnNames.includes('po_date')) {
      console.log('Adding po_date column to purchase_orders table...');
      db.exec('ALTER TABLE purchase_orders ADD COLUMN po_date DATE');
      saveDatabase();
      console.log('✓ po_date column added successfully');
    }

    if (!columnNames.includes('buyer_name')) {
      db.exec('ALTER TABLE purchase_orders ADD COLUMN buyer_name TEXT');
      saveDatabase();
      console.log('✓ buyer_name column added to purchase_orders');
    }

    if (!columnNames.includes('buyer_email')) {
      db.exec('ALTER TABLE purchase_orders ADD COLUMN buyer_email TEXT');
      saveDatabase();
      console.log('✓ buyer_email column added to purchase_orders');
    }
  } catch (error) {
    console.error('Error adding po_date column:', error);
  }

  // Seed buyer contact for an existing PO (idempotent update)
  try {
    const buyerName = 'JIGNESH R SHAH';
    const buyerEmail = 'JIGNESH.SHAH@LARSENTOUBRO.COM';

    db.prepare(`
      UPDATE purchase_orders
      SET buyer_name = ?, buyer_email = ?
      WHERE upper(trim(po_number)) IN ('P0L010766', 'POL010766')
    `).run(buyerName, buyerEmail);
    saveDatabase();
  } catch (error) {
    console.error('Error seeding buyer contact for PO:', error);
  }

  // Migration: Update invoices table CHECK constraint to include 'voucher_created' status
  try {
    const tableSchema = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='invoices'");
    const tableSql = tableSchema.length > 0 && tableSchema[0].values.length > 0 ? tableSchema[0].values[0][0] : '';

    // Check if the table exists but doesn't have 'voucher_created' in the CHECK constraint
    if (tableSql && !tableSql.includes("'voucher_created'")) {
      console.log('Updating invoices table to include voucher_created status...');

      // Create the new table with the FULL schema (this previously listed only a
      // subset of columns, which silently dropped the assignment/acceptance
      // columns and their data on rebuild).
      db.exec(`
        CREATE TABLE invoices_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          vendor_name TEXT,
          invoice_number TEXT,
          amount DECIMAL(10, 2),
          invoice_date DATE,
          file_path TEXT,
          assigned_to TEXT,
          assigned_to_user_id INTEGER,
          assigned_to_name TEXT,
          assigned_by_user_id INTEGER,
          assigned_by_name TEXT,
          assigned_at DATETIME,
          accepted_by_user_id INTEGER,
          accepted_by_name TEXT,
          accepted_at DATETIME,
          voucher_submitted_at DATETIME,
          completed_at DATETIME,
          po_number TEXT,
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'assigned', 'voucher_created')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);

      // Copy every column that actually exists in the old table (intersection),
      // so no data is lost regardless of how old the source schema is.
      const targetCols = ['id', 'user_id', 'vendor_name', 'invoice_number', 'amount', 'invoice_date', 'file_path', 'assigned_to', 'assigned_to_user_id', 'assigned_to_name', 'assigned_by_user_id', 'assigned_by_name', 'assigned_at', 'accepted_by_user_id', 'accepted_by_name', 'accepted_at', 'voucher_submitted_at', 'completed_at', 'po_number', 'status', 'created_at'];
      const oldInvoiceCols = (db.exec("PRAGMA table_info(invoices)")[0]?.values || []).map(c => c[1]);
      const copyCols = targetCols.filter(c => oldInvoiceCols.includes(c));
      db.exec(`INSERT INTO invoices_new (${copyCols.join(', ')}) SELECT ${copyCols.join(', ')} FROM invoices`);

      // Drop old table + rename
      db.exec('DROP TABLE invoices');
      db.exec('ALTER TABLE invoices_new RENAME TO invoices');

      saveDatabase();
      console.log('✓ Invoices table updated with voucher_created status support (all columns preserved)');
    }
  } catch (error) {
    console.error('Error updating invoices table constraint:', error);
  }

  // Migrate existing invoices table if it doesn't have the new columns
  try {
    const columns = db.exec("PRAGMA table_info(invoices)")[0];
    if (columns) {
      const columnNames = columns.values.map(col => col[1]);
      let didAddInvoiceColumn = false;
      const invoiceColumnsToAdd = [
        { name: 'assigned_to', type: 'TEXT' },
        { name: 'assigned_to_user_id', type: 'INTEGER' },
        { name: 'assigned_to_name', type: 'TEXT' },
        { name: 'assigned_by_user_id', type: 'INTEGER' },
        { name: 'assigned_by_name', type: 'TEXT' },
        { name: 'assigned_at', type: 'DATETIME' },
        { name: 'accepted_by_user_id', type: 'INTEGER' },
        { name: 'accepted_by_name', type: 'TEXT' },
        { name: 'accepted_at', type: 'DATETIME' },
        { name: 'voucher_submitted_at', type: 'DATETIME' },
        { name: 'completed_at', type: 'DATETIME' },
        { name: 'po_number', type: 'TEXT' }
      ];

      invoiceColumnsToAdd.forEach(col => {
        if (!columnNames.includes(col.name)) {
          db.run(`ALTER TABLE invoices ADD COLUMN ${col.name} ${col.type}`);
          console.log(`✓ Added ${col.name} column to invoices`);
          didAddInvoiceColumn = true;
        }
      });

      if (didAddInvoiceColumn) {
        saveDatabase();
      }
    }
  } catch (error) {
    // Table might not exist yet, which is fine
    console.log('Skipping migration check (table might be new)');
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS jcc_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      coordinator_id INTEGER NOT NULL,
      category TEXT,
      description TEXT,
      approved_amount DECIMAL(10, 2),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (coordinator_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS voucher_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      claimed_by TEXT,
      department TEXT,
      claimed_date DATE,
      supplier TEXT,
      buyer_name TEXT,
      buyer_email TEXT,
      expense_booking_location TEXT,
      description TEXT,
      invoice_number TEXT,
      invoice_date DATE,
      outdoor_duty INTEGER DEFAULT 0,
      outdoor_from DATE,
      outdoor_to DATE,
      outdoor_remark TEXT,
      info_requested_level INTEGER,
      info_request_note TEXT,
      info_request_by TEXT,
      info_request_at DATETIME,
      info_response_note TEXT,
      approval_nonce INTEGER DEFAULT 0,
      recall_reason TEXT,
      recalled_by TEXT,
      recalled_at DATETIME,
      basic_amount DECIMAL(10, 2),
      gross_amount DECIMAL(10, 2),
      nature_of_expenses TEXT,
      po_number TEXT,
      project_code TEXT,
      project_name TEXT,
      project_amount DECIMAL(10, 2),
      attachment_path TEXT,
      approver1_name TEXT,
      approver1_status TEXT DEFAULT 'pending',
      approver1_remark TEXT,
      approver1_date DATETIME,
      approver2_name TEXT,
      approver2_status TEXT DEFAULT 'pending',
      approver2_remark TEXT,
      approver2_date DATETIME,
      current_approval_level INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending_approval_1',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS voucher_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      amount DECIMAL(10, 2),
      project_code TEXT,
      project_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (voucher_id) REFERENCES voucher_requests(id) ON DELETE CASCADE
    )
  `);

  // Migration: Mark existing invoices that have vouchers created as 'voucher_created'.
  // Runs here (after voucher_requests exists) — previously it ran before the table
  // was created, so on a fresh DB the backfill silently never ran.
  try {
    db.exec(`
      UPDATE invoices
      SET status = 'voucher_created'
      WHERE invoice_number IN (
        SELECT DISTINCT invoice_number FROM voucher_requests WHERE invoice_number IS NOT NULL AND invoice_number != ''
      )
      AND status IN ('pending', 'assigned')
    `);
    console.log('✓ Migrated invoices with existing vouchers to voucher_created status');
  } catch (error) {
    console.log('Note: Could not run invoice voucher_created backfill:', error.message);
  }

  // Migration: Add approval columns if they don't exist
  try {
    const tableInfoResult = db.exec("PRAGMA table_info(voucher_requests)");
    const columns = tableInfoResult.length > 0 ? tableInfoResult[0].values : [];
    const columnNames = columns.map(col => col[1]);

    const columnsToAdd = [
      { name: 'approver1_name', type: 'TEXT' },
      { name: 'approver1_status', type: 'TEXT DEFAULT \'pending\'' },
      { name: 'approver1_remark', type: 'TEXT' },
      { name: 'approver1_date', type: 'DATETIME' },
      { name: 'approver2_name', type: 'TEXT' },
      { name: 'approver2_status', type: 'TEXT DEFAULT \'pending\'' },
      { name: 'approver2_remark', type: 'TEXT' },
      { name: 'approver2_date', type: 'DATETIME' },
      { name: 'current_approval_level', type: 'INTEGER DEFAULT 1' }
    ];

    columnsToAdd.forEach(col => {
      if (!columnNames.includes(col.name)) {
        console.log(`Adding ${col.name} column to voucher_requests table...`);
        db.exec(`ALTER TABLE voucher_requests ADD COLUMN ${col.name} ${col.type}`);
        saveDatabase();
      }
    });

    console.log('✓ Approval columns checked/added');
  } catch (error) {
    console.error('Error checking/adding approval columns:', error);
  }

  // Add buyer contact columns to voucher_requests
  try {
    const voucherInfo = db.exec("PRAGMA table_info(voucher_requests)");
    const voucherColumns = voucherInfo.length > 0 ? voucherInfo[0].values : [];
    const voucherColumnNames = voucherColumns.map(col => col[1]);

    const buyerColumns = [
      { name: 'buyer_name', type: 'TEXT' },
      { name: 'buyer_email', type: 'TEXT' }
    ];

    buyerColumns.forEach(col => {
      if (!voucherColumnNames.includes(col.name)) {
        db.exec(`ALTER TABLE voucher_requests ADD COLUMN ${col.name} ${col.type}`);
        saveDatabase();
      }
    });
  } catch (error) {
    console.error('Error adding buyer columns to voucher_requests:', error);
  }

  // Add outdoor-duty exception columns to voucher_requests
  try {
    const voucherInfo = db.exec("PRAGMA table_info(voucher_requests)");
    const voucherColumns = voucherInfo.length > 0 ? voucherInfo[0].values : [];
    const voucherColumnNames = voucherColumns.map(col => col[1]);

    const outdoorColumns = [
      { name: 'outdoor_duty', type: 'INTEGER DEFAULT 0' },
      { name: 'outdoor_from', type: 'DATE' },
      { name: 'outdoor_to', type: 'DATE' },
      { name: 'outdoor_remark', type: 'TEXT' }
    ];

    outdoorColumns.forEach(col => {
      if (!voucherColumnNames.includes(col.name)) {
        console.log(`Adding ${col.name} column to voucher_requests table...`);
        db.exec(`ALTER TABLE voucher_requests ADD COLUMN ${col.name} ${col.type}`);
        saveDatabase();
      }
    });
  } catch (error) {
    console.error('Error adding outdoor-duty columns to voucher_requests:', error);
  }

  // Add "Request more info" (soft-return) columns to voucher_requests
  try {
    const voucherInfo = db.exec("PRAGMA table_info(voucher_requests)");
    const voucherColumns = voucherInfo.length > 0 ? voucherInfo[0].values : [];
    const voucherColumnNames = voucherColumns.map(col => col[1]);

    const infoColumns = [
      { name: 'info_requested_level', type: 'INTEGER' },
      { name: 'info_request_note', type: 'TEXT' },
      { name: 'info_request_by', type: 'TEXT' },
      { name: 'info_request_at', type: 'DATETIME' },
      { name: 'info_response_note', type: 'TEXT' },
      { name: 'approval_nonce', type: 'INTEGER DEFAULT 0' },
      { name: 'recall_reason', type: 'TEXT' },
      { name: 'recalled_by', type: 'TEXT' },
      { name: 'recalled_at', type: 'DATETIME' }
    ];

    infoColumns.forEach(col => {
      if (!voucherColumnNames.includes(col.name)) {
        console.log(`Adding ${col.name} column to voucher_requests table...`);
        db.exec(`ALTER TABLE voucher_requests ADD COLUMN ${col.name} ${col.type}`);
        saveDatabase();
      }
    });
  } catch (error) {
    console.error('Error adding info-request columns to voucher_requests:', error);
  }

  // ===== NEW: Customer Management Tables =====

  // Customers table
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_code TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL,
      contact_person TEXT,
      email TEXT,
      phone TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      pincode TEXT,
      gst_number TEXT,
      pan_number TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Vendors table
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_code TEXT UNIQUE NOT NULL,
      vendor_name TEXT NOT NULL,
      address TEXT,
      contact_number TEXT,
      mail_id TEXT,
      bp_id TEXT,
      bp_name TEXT,
      city TEXT,
      country TEXT,
      nda_date TEXT,
      nda_expiry_date TEXT,
      nda_period_year TEXT,
      project_name TEXT,
      signed_hard_copy_depository_location TEXT,
      signed_hard_copy_depository_location_fp TEXT,
      item_type TEXT,
      vendor_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: Add vendor NDA columns if they don't exist
  try {
    const vendorInfoResult = db.exec("PRAGMA table_info(vendors)");
    const vendorColumns = vendorInfoResult.length > 0 ? vendorInfoResult[0].values : [];
    const vendorColumnNames = new Set(vendorColumns.map(col => col[1]));

    const vendorColumnsToAdd = [
      { name: 'bp_id', type: 'TEXT' },
      { name: 'bp_name', type: 'TEXT' },
      { name: 'city', type: 'TEXT' },
      { name: 'country', type: 'TEXT' },
      { name: 'nda_date', type: 'TEXT' },
      { name: 'nda_expiry_date', type: 'TEXT' },
      { name: 'nda_period_year', type: 'TEXT' },
      { name: 'project_name', type: 'TEXT' },
      { name: 'signed_hard_copy_depository_location', type: 'TEXT' },
      { name: 'signed_hard_copy_depository_location_fp', type: 'TEXT' },
      { name: 'item_type', type: 'TEXT' },
      { name: 'vendor_path', type: 'TEXT' }
    ];

    let didAddVendorColumn = false;
    vendorColumnsToAdd.forEach(col => {
      if (!vendorColumnNames.has(col.name)) {
        db.exec(`ALTER TABLE vendors ADD COLUMN ${col.name} ${col.type}`);
        didAddVendorColumn = true;
        console.log(`\u2713 Added ${col.name} column to vendors table`);
      }
    });

    if (didAddVendorColumn) {
      saveDatabase();
    }
  } catch (error) {
    console.error('Error adding vendor NDA columns:', error);
  }

  // Seed vendor master list (idempotent by vendor name)
  try {
    const defaultVendorNames = [
      'ALLWYN JUMBO PRINTS AND EXCHANGER PVT LTD',
      'Armoured Vehicles Nigam Limited',
      'Asha Furniture Works',
      'Balaji Arts',
      'Bharat Electronics Limited',
      'CHANDRAHAS SHETTY',
      'DDSPLM Pvt. Ltd.',
      'Delos Consulting Pvt. Ltd.',
      'DesignTech Systems Pvt. Ltd.',
      'GenieHR Solutions Pvt. Ltd.',
      'Global Publishing Solutions Ltd.',
      'Hornbill Studios Pvt Ltd',
      'JUSTVFX STUDIOS',
      'LOUISCIAGA OVERSEAS PVT. LTD',
      'MICROPOINT COMPUTERS PRIVATE LIMITED',
      'Pentagon System And Services Pvt. Ltd',
      'PEREVODRU',
      'PEREVODRU GLOBAL TRANSLATION SERVICES',
      'Pixlar Art Creation',
      'RAC IT SOLUTIONS PVT. LTD.',
      'Schneider Electric India Pvt. Limited (SEIPL)',
      'Shezarweb Technologies',
      'Shivam Computers',
      'SIEMENS INDUSTRY SOFTWARE (INDIA)',
      'Smartify Software Solutions LLP',
      'Somshanti Enterprises',
      'Urgent Courier',
      'Voice Kraft Productions',
      'White Globe Pvt. Ltd.',
      'Track On Courier'
    ];

    const vendorNameExists = (name) => {
      return !!db.prepare(`
        SELECT id FROM vendors
        WHERE LOWER(TRIM(vendor_name)) = LOWER(TRIM(?))
        LIMIT 1
      `).get(name);
    };

    const vendorCodeExists = (code) => {
      return !!db.prepare('SELECT id FROM vendors WHERE vendor_code = ? LIMIT 1').get(code);
    };

    let seededCount = 0;
    defaultVendorNames.forEach((name, index) => {
      if (vendorNameExists(name)) return;

      let code = `DEF${String(index + 1).padStart(3, '0')}`;
      let suffix = 1;
      while (vendorCodeExists(code)) {
        code = `DEF${String(index + 1).padStart(3, '0')}_${suffix}`;
        suffix += 1;
      }

      db.run(
        'INSERT INTO vendors (vendor_code, vendor_name) VALUES (?, ?)',
        [code, name]
      );
      seededCount += 1;
    });

    if (seededCount > 0) {
      saveDatabase();
      console.log(`✓ Seeded ${seededCount} vendor names into vendor master`);
    }
  } catch (error) {
    console.error('Error seeding vendor names:', error);
  }

  // Projects table
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_code TEXT UNIQUE NOT NULL,
      project_name TEXT NOT NULL,
      customer_id INTEGER NOT NULL,
      contract_number TEXT,
      contract_date DATE,
      contract_value DECIMAL(15, 2),
      start_date DATE,
      end_date DATE,
      status TEXT DEFAULT 'active',
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  // Milestones table
  db.exec(`
    CREATE TABLE IF NOT EXISTS milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      milestone_name TEXT NOT NULL,
      description TEXT,
      target_date DATE,
      completion_date DATE,
      status TEXT DEFAULT 'pending',
      value DECIMAL(15, 2),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `);

  // Correspondences table
  db.exec(`
    CREATE TABLE IF NOT EXISTS correspondences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correspondence_number TEXT UNIQUE NOT NULL,
      project_id INTEGER,
      customer_id INTEGER NOT NULL,
      milestone_id INTEGER,
      subject TEXT NOT NULL,
      content TEXT,
      correspondence_type TEXT DEFAULT 'letter',
      direction TEXT DEFAULT 'outgoing',
      status TEXT DEFAULT 'draft',
      qr_code TEXT,
      digital_signature TEXT,
      sent_date DATETIME,
      received_date DATETIME,
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (milestone_id) REFERENCES milestones(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  // Correspondence attachments table
  db.exec(`
    CREATE TABLE IF NOT EXISTS correspondence_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correspondence_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (correspondence_id) REFERENCES correspondences(id)
    )
  `);

  // Correspondence trail table (audit log)
  db.exec(`
    CREATE TABLE IF NOT EXISTS correspondence_trail (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correspondence_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      action_by INTEGER NOT NULL,
      remarks TEXT,
      action_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (correspondence_id) REFERENCES correspondences(id),
      FOREIGN KEY (action_by) REFERENCES users(id)
    )
  `);

  // Add JCC classification columns to voucher_requests
  try {
    const voucherInfo = db.exec("PRAGMA table_info(voucher_requests)");
    const voucherColumns = voucherInfo.length > 0 ? voucherInfo[0].values : [];
    const voucherColumnNames = voucherColumns.map(col => col[1]);

    if (!voucherColumnNames.includes('jcc_category')) {
      db.exec("ALTER TABLE voucher_requests ADD COLUMN jcc_category TEXT DEFAULT 'general'");
    }
    if (!voucherColumnNames.includes('authority_level')) {
      db.exec("ALTER TABLE voucher_requests ADD COLUMN authority_level TEXT");
    }

    console.log('✓ JCC classification columns checked/added');
  } catch (error) {
    console.error('Error adding JCC classification columns:', error);
  }

  // Add payment tracking columns to voucher_requests
  try {
    const voucherInfo = db.exec("PRAGMA table_info(voucher_requests)");
    const voucherColumns = voucherInfo.length > 0 ? voucherInfo[0].values : [];
    const voucherColumnNames = voucherColumns.map(col => col[1]);

    const paymentColumns = [
      { name: 'payment_status', type: "TEXT DEFAULT 'awaiting_approval'" },
      { name: 'payment_reference', type: 'TEXT' },
      { name: 'payment_remarks', type: 'TEXT' },
      { name: 'payment_submitted_at', type: 'DATETIME' },
      { name: 'payment_initiated_at', type: 'DATETIME' },
      { name: 'payment_debited_at', type: 'DATETIME' },
      { name: 'payment_settled_at', type: 'DATETIME' },
      { name: 'payment_failed_at', type: 'DATETIME' },
      { name: 'payment_reversed_at', type: 'DATETIME' }
    ];

    let didAddPaymentColumn = false;
    paymentColumns.forEach(col => {
      if (!voucherColumnNames.includes(col.name)) {
        db.exec(`ALTER TABLE voucher_requests ADD COLUMN ${col.name} ${col.type}`);
        didAddPaymentColumn = true;
      }
    });

    if (didAddPaymentColumn) {
      saveDatabase();
    }

    console.log('✓ Voucher payment columns checked/added');
  } catch (error) {
    console.error('Error adding voucher payment columns:', error);
  }

  // Add supplier acknowledgement columns to voucher_requests
  try {
    const voucherInfo = db.exec("PRAGMA table_info(voucher_requests)");
    const voucherColumns = voucherInfo.length > 0 ? voucherInfo[0].values : [];
    const voucherColumnNames = voucherColumns.map(col => col[1]);

    const supplierAckColumns = [
      { name: 'supplier_ack_status', type: "TEXT DEFAULT 'not_sent'" },
      { name: 'supplier_ack_email', type: 'TEXT' },
      { name: 'supplier_ack_sent_at', type: 'DATETIME' },
      { name: 'supplier_ack_expires_at', type: 'DATETIME' },
      { name: 'supplier_ack_at', type: 'DATETIME' },
      { name: 'supplier_ack_by_email', type: 'TEXT' },
      { name: 'supplier_ack_remarks', type: 'TEXT' }
    ];

    let didAddSupplierAckColumn = false;
    supplierAckColumns.forEach(col => {
      if (!voucherColumnNames.includes(col.name)) {
        db.exec(`ALTER TABLE voucher_requests ADD COLUMN ${col.name} ${col.type}`);
        didAddSupplierAckColumn = true;
      }
    });

    if (didAddSupplierAckColumn) {
      saveDatabase();
    }

    console.log('✓ Supplier acknowledgement columns checked/added');
  } catch (error) {
    console.error('Error adding supplier acknowledgement columns:', error);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS voucher_payment_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      old_status TEXT,
      new_status TEXT NOT NULL,
      reference_no TEXT,
      amount DECIMAL(10, 2),
      remarks TEXT,
      action_source TEXT DEFAULT 'manual',
      action_by_user_id INTEGER,
      action_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (voucher_id) REFERENCES voucher_requests(id),
      FOREIGN KEY (action_by_user_id) REFERENCES users(id)
    )
  `);

  // Materials table for multiple Project Details entries in Voucher Requests
  db.run(`
    CREATE TABLE IF NOT EXISTS voucher_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      amount DECIMAL(10, 2),
      project_code TEXT,
      project_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (voucher_id) REFERENCES voucher_requests(id)
    )
  `);

  // Migration: Add description_of_material column to voucher_materials if it doesn't exist
  try {
    const tableInfoResult = db.exec("PRAGMA table_info(voucher_materials)");
    const columns = tableInfoResult.length > 0 ? tableInfoResult[0].values : [];
    const columnNames = columns.map(col => col[1]);

    if (!columnNames.includes('description_of_material')) {
      console.log('Adding description_of_material column to voucher_materials table...');
      db.exec("ALTER TABLE voucher_materials ADD COLUMN description_of_material TEXT");
      saveDatabase();
      console.log('✓ description_of_material column added successfully');
    }
  } catch (error) {
    console.error('Error adding description_of_material column:', error);
  }

  // Asset lifecycle tracking
  db.run(`
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_uid TEXT UNIQUE NOT NULL,
      vendor_name TEXT NOT NULL,
      category TEXT,
      asset_name TEXT NOT NULL,
      serial_number TEXT,
      model TEXT,
      status TEXT DEFAULT 'available' CHECK(status IN ('available', 'issued', 'returned', 'maintenance', 'lost')),
      daily_rate DECIMAL(10, 2),
      monthly_rate DECIMAL(10, 2),
      remarks TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS asset_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL,
      assigned_to_name TEXT NOT NULL,
      assigned_to_type TEXT DEFAULT 'employee',
      project_code TEXT,
      location TEXT,
      start_date DATE NOT NULL,
      expected_return_date DATE,
      actual_return_date DATE,
      charge_type TEXT NOT NULL CHECK(charge_type IN ('daily', 'monthly', 'fixed')),
      rate DECIMAL(10, 2),
      fixed_charge DECIMAL(10, 2),
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'closed')),
      remarks TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (asset_id) REFERENCES assets(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS asset_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL,
      assignment_id INTEGER,
      event_type TEXT NOT NULL CHECK(event_type IN ('created', 'issued', 'returned', 'status_changed', 'charge_updated')),
      event_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      performed_by INTEGER,
      details TEXT,
      FOREIGN KEY (asset_id) REFERENCES assets(id),
      FOREIGN KEY (assignment_id) REFERENCES asset_assignments(id),
      FOREIGN KEY (performed_by) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS monthly_asset_vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_month TEXT NOT NULL,
      vendor_name TEXT NOT NULL,
      total_amount DECIMAL(12, 2) DEFAULT 0,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'generated', 'finalized')),
      generated_by INTEGER,
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(voucher_month, vendor_name),
      FOREIGN KEY (generated_by) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS monthly_asset_voucher_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      asset_id INTEGER NOT NULL,
      assignment_id INTEGER NOT NULL,
      billable_start DATE,
      billable_end DATE,
      billable_days INTEGER DEFAULT 0,
      charge_amount DECIMAL(12, 2) NOT NULL,
      charge_type TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (voucher_id) REFERENCES monthly_asset_vouchers(id) ON DELETE CASCADE,
      FOREIGN KEY (asset_id) REFERENCES assets(id),
      FOREIGN KEY (assignment_id) REFERENCES asset_assignments(id)
    )
  `);

  console.log('✓ All database tables created successfully');


  db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_name TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      details TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_name TEXT,
      session_id TEXT,
      device_id TEXT,
      event_name TEXT NOT NULL,
      module TEXT,
      screen TEXT,
      entity_type TEXT,
      entity_id INTEGER,
      duration_ms INTEGER,
      success INTEGER DEFAULT 1,
      status_code INTEGER,
      metadata TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_activity_logs_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_log_id INTEGER,
      user_id INTEGER,
      user_name TEXT,
      session_id TEXT,
      device_id TEXT,
      event_name TEXT NOT NULL,
      module TEXT,
      screen TEXT,
      entity_type TEXT,
      entity_id INTEGER,
      duration_ms INTEGER,
      success INTEGER DEFAULT 1,
      status_code INTEGER,
      metadata TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at DATETIME,
      archived_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_log_id)
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_user_activity_logs_created_at ON user_activity_logs(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_user_activity_logs_event_name ON user_activity_logs(event_name)');
  db.run('CREATE INDEX IF NOT EXISTS idx_user_activity_logs_module ON user_activity_logs(module)');
  db.run('CREATE INDEX IF NOT EXISTS idx_user_activity_logs_user_id ON user_activity_logs(user_id)');

  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'info',
      read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // ═══════════════════════════════════════════════════════════════════════════
  // PRINTING MODULE (JCC Jobs) — sibling to the JCC/voucher module.
  // Two tables: print_jobs (request header, Form 1 + lifecycle) and
  // print_job_documents (one row per document; a job has many). See
  // docs/PRINTING_MODULE_PLAN.md for the full workflow spec.
  // ═══════════════════════════════════════════════════════════════════════════

  // Debit Code drives the Phase-1 project dropdown (projects filtered by debit_code).
  // Idempotent: the column may already exist on re-run.
  try {
    db.exec('ALTER TABLE projects ADD COLUMN debit_code TEXT');
  } catch (_) { /* column already exists */ }

  // Module-scoped printing roles — INDEPENDENT of the global JCC `role`. A user can
  // be a plain JCC `user` yet a Printing Coordinator/Operator. Kept as flags rather
  // than new global roles so JCC permissions are never affected.
  try {
    db.exec('ALTER TABLE users ADD COLUMN is_printer_operator INTEGER DEFAULT 0');
  } catch (_) { /* column already exists */ }
  try {
    db.exec('ALTER TABLE users ADD COLUMN is_printer_coordinator INTEGER DEFAULT 0');
  } catch (_) { /* column already exists */ }

  // ── Multi-site locations ────────────────────────────────────────────────────
  // A site/branch (e.g. Talegaon, Powai). Jobs are routed to coordinators/operators
  // at the job's location. Users have a home location captured at profile setup.
  db.run(`
    CREATE TABLE IF NOT EXISTS locations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      code       TEXT,
      active     INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Seed a couple of example sites on first run (admin can rename/add/remove).
  try {
    const locCount = db.prepare('SELECT COUNT(*) AS c FROM locations').get().c;
    if (locCount === 0) {
      const insertLoc = db.prepare('INSERT INTO locations (name, code) VALUES (?, ?)');
      insertLoc.run('Powai', 'PWI');
      insertLoc.run('Talegaon', 'TLG');
    }
  } catch (e) { console.error('location seed failed:', e); }

  // Home location for the user (nullable — set at profile setup or by admin).
  try {
    db.exec('ALTER TABLE users ADD COLUMN location_id INTEGER');
  } catch (_) { /* column already exists */ }
  // Target site where a print job should be handled (defaults from the requester).
  try {
    db.exec('ALTER TABLE print_jobs ADD COLUMN location_id INTEGER');
  } catch (_) { /* column already exists */ }

  // Extended Request Information fields (Initiator / Recipient / Printing Requirement).
  const printJobExtraColumns = [
    'shipset_batch TEXT',
    'classification TEXT',
    'number_of_pages INTEGER',
    'lead_name TEXT',
    'edc TEXT',
    'recipient_name TEXT',
    'recipient_contact TEXT',
    'recipient_address TEXT',
    'vl_review TEXT',
    'drp_remarks TEXT',
    'pre_printing_checklist TEXT',
    'purpose TEXT',
    'printing_form_available TEXT',
  ];
  printJobExtraColumns.forEach((col) => {
    try { db.exec(`ALTER TABLE print_jobs ADD COLUMN ${col}`); } catch (_) { /* exists */ }
  });

  // Rush/priority flag (1 = rush → jumps the queue).
  try { db.exec('ALTER TABLE print_jobs ADD COLUMN priority INTEGER DEFAULT 0'); } catch (_) { /* exists */ }

  // Dispatch / courier tracking (optional stage after Ready for Collection).
  const printJobDispatchColumns = [
    'courier_name TEXT',
    'docket_no TEXT',
    'dispatch_books INTEGER',
    'dispatch_packets TEXT',
    'dispatch_remarks TEXT',
    'dispatched_by TEXT',
    'dispatched_at DATETIME',
    'received_by TEXT',
    'delivered_at DATETIME',
  ];
  printJobDispatchColumns.forEach((col) => {
    try { db.exec(`ALTER TABLE print_jobs ADD COLUMN ${col}`); } catch (_) { /* exists */ }
  });

  // Receipt confirmation. Handover used to close a job on the coordinator's
  // click alone, so 'completed' recorded who *gave* the materials and nothing
  // about who got them. Handover now parks the job at 'awaiting_receipt' and
  // only the requestor's own confirmation completes it, stamping these.
  const printJobReceiptColumns = [
    'handed_over_at DATETIME',
    'handed_over_by TEXT',
    'received_at DATETIME',
    'received_by_user_id INTEGER',
  ];
  printJobReceiptColumns.forEach((col) => {
    try { db.exec(`ALTER TABLE print_jobs ADD COLUMN ${col}`); } catch (_) { /* exists */ }
  });

  // Rework / proof-review cycle. current_version and rework_count are derivable
  // from print_job_reworks, but the coordinator's job lists render on a 30s poll
  // and would need a correlated subquery per row; both are written in the same
  // statement batch as the rework insert so they cannot drift.
  // Content hash of each document's PDF. Lets a resubmit distinguish "same file,
  // different specs" from "file replaced", and rescues a rename from looking like a
  // deletion plus an addition. Null on rows uploaded before this existed.
  try { db.exec('ALTER TABLE print_job_documents ADD COLUMN pdf_sha256 TEXT'); } catch (_) { /* exists */ }
  // Some bindings are priced by a variant rather than by paper size — a box file is
  // charged on its spine thickness (1 inc, 1.5, 2, 2.5, 3). Without this the rate
  // master cannot be matched and the line reads as unpriced.
  try { db.exec('ALTER TABLE print_job_documents ADD COLUMN binding_variant TEXT'); } catch (_) { /* exists */ }
  // Optional extras the rate master prices but that have no dedicated field — pouch
  // lamination, board stock, scanning, packing. JSON array of
  // { code, size, gsm, colour, variant, quantity }; the dimensions are stored rather
  // than a rate-line id so a superseded card never strands a saved document.
  try { db.exec('ALTER TABLE print_job_documents ADD COLUMN extra_services TEXT'); } catch (_) { /* exists */ }

  // A cost line records the dimensions it was priced at. The requestor's spec is an
  // estimate — the operator at the machine decides the real A3/A4/colour split — so a
  // line has to carry its own size/GSM/colour to be re-priced when corrected.
  for (const col of ['paper_size TEXT', 'paper_gsm TEXT', 'colour_mode TEXT', 'variant TEXT']) {
    try { db.exec(`ALTER TABLE job_cost_lines ADD COLUMN ${col}`); } catch (_) { /* exists */ }
  }

  // Which annexure version a line belongs to. NULL means "not yet issued" — the
  // working set an operator can correct before a coordinator issues the first
  // annexure. Without this, every version of a job's annexure shared one row set,
  // so correcting a reissued draft would silently rewrite the superseded version's
  // frozen line-by-line breakdown too, even though its totals stayed frozen.
  try { db.exec('ALTER TABLE job_cost_lines ADD COLUMN annexure_id INTEGER'); } catch (_) { /* exists */ }

  const printJobRecallColumns = ['recalled_at DATETIME', 'recall_reason TEXT'];
  printJobRecallColumns.forEach((col) => {
    try { db.exec(`ALTER TABLE print_jobs ADD COLUMN ${col}`); } catch (_) { /* exists */ }
  });

  const printJobReworkColumns = [
    'current_version INTEGER DEFAULT 1',
    'rework_count INTEGER DEFAULT 0',
    'proof_released_at DATETIME',
    'last_rework_at DATETIME',
  ];
  printJobReworkColumns.forEach((col) => {
    try { db.exec(`ALTER TABLE print_jobs ADD COLUMN ${col}`); } catch (_) { /* exists */ }
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id            TEXT UNIQUE NOT NULL,        -- REQ0001 (created at Phase 1)
      job_number            TEXT UNIQUE,                 -- JOB0001 (assigned at submit, NULL until then)
      request_date          DATETIME DEFAULT CURRENT_TIMESTAMP,

      -- Form 1 (Request Information)
      employee_name         TEXT,
      employee_id           TEXT,
      department_name       TEXT,
      department_code       TEXT,
      debit_code            TEXT,
      project_name          TEXT,
      dt_number             TEXT,
      remarks               TEXT,

      -- Lifecycle
      status                TEXT NOT NULL DEFAULT 'draft',
      created_by            INTEGER NOT NULL,
      coordinator_id        INTEGER,
      coordinator_remarks   TEXT,
      return_reason         TEXT,
      reject_reason         TEXT,
      assigned_operator_id  INTEGER,

      -- Per-phase timestamps (tracking + reports)
      submitted_at          DATETIME,
      accepted_at           DATETIME,
      returned_at           DATETIME,
      rejected_at           DATETIME,
      assigned_at           DATETIME,
      printing_started_at   DATETIME,
      printing_completed_at DATETIME,
      ready_at              DATETIME,
      completed_at          DATETIME,

      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by)           REFERENCES users(id),
      FOREIGN KEY (coordinator_id)       REFERENCES users(id),
      FOREIGN KEY (assigned_operator_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS print_job_documents (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id              INTEGER NOT NULL,
      document_name       TEXT NOT NULL,
      quantity            INTEGER NOT NULL DEFAULT 1,
      pdf_path            TEXT,
      num_pages           INTEGER,
      print_side          TEXT,
      paper_size          TEXT,
      paper_gsm           TEXT,
      color_mode          TEXT,
      cover_page          TEXT,
      soft_lamination     INTEGER DEFAULT 0,
      separators          INTEGER DEFAULT 0,
      separator_thickness TEXT,
      hole_punch          INTEGER DEFAULT 0,
      binding_type        TEXT,
      file_colour         TEXT,
      remarks             TEXT,
      finishing_done      INTEGER DEFAULT 0,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES print_jobs(id) ON DELETE CASCADE
    )
  `);

  // ── Printing rate master ───────────────────────────────────────────────────
  // Rates are a matrix, not a list of named services: the printed card prices
  // (service x paper size x GSM x colour x variant). Modelling each cell as its own
  // service would mean a new service every time a paper weight is added.
  //
  // Money is stored as integers. rate_milli is the rate x 1000 (the card carries
  // three decimals, e.g. 1.150 -> 1150) and amounts elsewhere are paise, so no
  // floating point ever enters a total that has to reconcile by hand.
  db.run(`
    CREATE TABLE IF NOT EXISTS service_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code          TEXT UNIQUE NOT NULL,      -- PRINT | BIND_SPIRAL | SCAN …
      label         TEXT NOT NULL,
      domain        TEXT NOT NULL DEFAULT 'printing',
      uom           TEXT NOT NULL,             -- page | copy | sheet | piece | box | job
      pricing_kind  TEXT NOT NULL DEFAULT 'per_unit',
      cost_group    TEXT NOT NULL,             -- printing | binding | finishing | misc
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS rate_versions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      code           TEXT UNIQUE NOT NULL,     -- RC-2026-08
      label          TEXT,
      location_id    INTEGER,                  -- NULL = global card
      effective_from DATE NOT NULL,
      effective_to   DATE,
      status         TEXT NOT NULL DEFAULT 'draft',   -- draft | approved | superseded
      source_note    TEXT,                     -- provenance, e.g. which sheet it came from
      approved_by    INTEGER,
      approved_at    DATETIME,
      created_by     INTEGER,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id),
      FOREIGN KEY (approved_by) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS rate_lines (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id       INTEGER NOT NULL,
      service_code     TEXT NOT NULL,
      paper_size       TEXT,                   -- NULL = applies to any
      paper_gsm        TEXT,
      colour_mode      TEXT,                   -- BW | COLOUR | NULL
      variant          TEXT,                   -- VIP | BLUE | 5PLY … free dimension
      rate_milli       INTEGER NOT NULL,
      min_charge_paise INTEGER,
      needs_review     INTEGER NOT NULL DEFAULT 0,  -- transcribed but unconfirmed
      note             TEXT,
      FOREIGN KEY (version_id)   REFERENCES rate_versions(id) ON DELETE CASCADE,
      FOREIGN KEY (service_code) REFERENCES service_items(code),
      UNIQUE (version_id, service_code, paper_size, paper_gsm, colour_mode, variant)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_rate_lines_lookup
          ON rate_lines(version_id, service_code, paper_size, paper_gsm, colour_mode)`);
  // Only one approved card per scope per effective date.
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rate_version_live
          ON rate_versions(COALESCE(location_id, 0), effective_from) WHERE status = 'approved'`);

  // ── Job cost lines and the Cost Annexure ───────────────────────────────────
  // A cost line copies the rate it was priced at, rather than pointing to it. Editing
  // a rate card must never change a figure on an issued annexure, so the snapshot is
  // the record. Amounts are paise, rates are millirupees; no floats.
  db.run(`
    CREATE TABLE IF NOT EXISTS job_cost_lines (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id           INTEGER NOT NULL,
      document_id      INTEGER,            -- which document this priced, if any
      rework_id        INTEGER,            -- set when the line is rework, not original
      service_code     TEXT NOT NULL,
      label            TEXT NOT NULL,
      cost_group       TEXT NOT NULL,      -- printing | binding | finishing | misc
      quantity         INTEGER NOT NULL,
      uom              TEXT NOT NULL,
      rate_version_id  INTEGER,            -- which card was in force
      rate_milli       INTEGER NOT NULL,   -- snapshot, not a reference
      amount_paise     INTEGER NOT NULL,
      min_charge_applied INTEGER NOT NULL DEFAULT 0,
      is_manual        INTEGER NOT NULL DEFAULT 0,
      manual_reason    TEXT,
      detail           TEXT,               -- e.g. "A4 / 80 / BW · 250pp x 5"
      accrued_by       INTEGER,
      accrued_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id)          REFERENCES print_jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id)     REFERENCES print_job_documents(id),
      FOREIGN KEY (rework_id)       REFERENCES print_job_reworks(id),
      FOREIGN KEY (rate_version_id) REFERENCES rate_versions(id)
    )
  `);
  // A line whose rate is not on the card yet still belongs on the annexure — it is
  // listed as "Rate Not Configured" and excluded from the totals, so an unpriced
  // service never blocks the job and never silently costs zero either.
  try { db.exec("ALTER TABLE job_cost_lines ADD COLUMN rate_status TEXT NOT NULL DEFAULT 'priced'"); } catch (_) { /* exists */ }

  db.run('CREATE INDEX IF NOT EXISTS idx_cost_lines_job ON job_cost_lines(job_id, cost_group)');
  db.run('CREATE INDEX IF NOT EXISTS idx_cost_lines_accrued ON job_cost_lines(accrued_at)');

  db.run(`
    CREATE TABLE IF NOT EXISTS cost_annexures (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      annexure_no       TEXT UNIQUE NOT NULL,     -- PCA-2026-0001
      job_id            INTEGER NOT NULL,
      version           INTEGER NOT NULL DEFAULT 1,
      supersedes_id     INTEGER,
      status            TEXT NOT NULL DEFAULT 'draft',  -- draft | under_review | approved | superseded
      rate_version_id   INTEGER,
      printing_paise    INTEGER NOT NULL DEFAULT 0,
      binding_paise     INTEGER NOT NULL DEFAULT 0,
      finishing_paise   INTEGER NOT NULL DEFAULT 0,
      misc_paise        INTEGER NOT NULL DEFAULT 0,
      rework_paise      INTEGER NOT NULL DEFAULT 0,
      basic_paise       INTEGER NOT NULL DEFAULT 0,
      grand_total_paise INTEGER NOT NULL DEFAULT 0,
      line_count        INTEGER NOT NULL DEFAULT 0,
      payload_sha256    TEXT,                     -- set at approval; proves the figures
      reissue_reason    TEXT,
      issued_by         INTEGER,
      issued_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id)          REFERENCES print_jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (supersedes_id)   REFERENCES cost_annexures(id),
      FOREIGN KEY (rate_version_id) REFERENCES rate_versions(id),
      FOREIGN KEY (issued_by)       REFERENCES users(id),
      UNIQUE (job_id, version)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_annexure_job ON cost_annexures(job_id, version)');
  db.run('CREATE INDEX IF NOT EXISTS idx_annexure_status ON cost_annexures(status, issued_at)');

  db.run(`
    CREATE TABLE IF NOT EXISTS annexure_approvals (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      annexure_id  INTEGER NOT NULL,
      role         TEXT NOT NULL,          -- prepared | reviewed | approved | returned
      user_id      INTEGER NOT NULL,
      employee_id  TEXT,
      designation  TEXT,
      department   TEXT,
      remarks      TEXT,
      ip_address   TEXT,
      acted_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (annexure_id) REFERENCES cost_annexures(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)     REFERENCES users(id)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_annexure_approvals ON annexure_approvals(annexure_id, acted_at)');

  // Gap-free document numbering, independent of rowid so a cancelled document does
  // not leave a hole in the series.
  db.run(`
    CREATE TABLE IF NOT EXISTS doc_sequences (
      name       TEXT PRIMARY KEY,
      next_value INTEGER NOT NULL DEFAULT 1
    )
  `);

  // An approved annexure is frozen. Belt and braces alongside the route guard,
  // because this is a financial record.
  db.run(`
    CREATE TRIGGER IF NOT EXISTS trg_annexure_immutable
    BEFORE UPDATE OF grand_total_paise, basic_paise, line_count, rate_version_id
    ON cost_annexures
    WHEN OLD.status = 'approved'
    BEGIN SELECT RAISE(ABORT, 'An approved annexure cannot be modified'); END
  `);

  // ── Submission history ─────────────────────────────────────────────────────
  // One row per submit. Lets any two submissions be compared, so a resubmit after
  // a recall (or after the coordinator returns a job) can show exactly what the
  // requestor changed instead of leaving the verifier to re-read the whole form.
  //
  // The header and document lists are stored as JSON on purpose: a snapshot is a
  // historical record and must not be re-interpreted by a future column list.
  db.run(`
    CREATE TABLE IF NOT EXISTS print_job_submissions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id         INTEGER NOT NULL,
      seq            INTEGER NOT NULL,          -- 1, 2, 3 … per job
      submitted_by   INTEGER NOT NULL,
      submitted_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      trigger_kind   TEXT,                      -- initial | after_recall | after_return
      trigger_reason TEXT,                      -- recall reason / coordinator remark
      header_json    TEXT NOT NULL,
      documents_json TEXT NOT NULL,
      books          INTEGER,
      copies         INTEGER,
      pages          INTEGER,
      FOREIGN KEY (job_id)       REFERENCES print_jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (submitted_by) REFERENCES users(id),
      UNIQUE (job_id, seq)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_job_submissions ON print_job_submissions(job_id, seq)');

  // ── Rework versions ────────────────────────────────────────────────────────
  // Append-only ledger of revised PDFs. A rework never edits the original job or
  // its documents: each correction round inserts a new row carrying its own PDF,
  // so the full history survives and V1 (the original submission) stays intact in
  // print_job_documents. Version 1 is therefore NOT a row here — the version list
  // is a union of the original document and these rows.
  db.run(`
    CREATE TABLE IF NOT EXISTS print_job_reworks (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      rework_id            TEXT UNIQUE NOT NULL,     -- RWK0001
      job_id               INTEGER NOT NULL,
      document_id          INTEGER,                  -- NULL = single-document job
      version_no           INTEGER NOT NULL,         -- 2, 3, 4 …

      pdf_path             TEXT NOT NULL,
      pdf_original_name    TEXT,
      pdf_size_bytes       INTEGER,
      pdf_sha256           TEXT,
      num_pages            INTEGER,

      modified_pages       TEXT NOT NULL,            -- exactly as typed
      modified_pages_norm  TEXT,                     -- canonical, e.g. 5,8,30-36
      modified_page_count  INTEGER,
      additional_pages     INTEGER NOT NULL DEFAULT 0,
      insert_position      TEXT,
      change_description   TEXT NOT NULL,
      coordinator_remarks  TEXT,

      created_by           INTEGER NOT NULL,
      assigned_operator_id INTEGER,
      status               TEXT NOT NULL DEFAULT 'pending',
      cancel_reason        TEXT,

      created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
      assigned_at          DATETIME,
      started_at           DATETIME,
      completed_at         DATETIME,

      FOREIGN KEY (job_id)               REFERENCES print_jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id)          REFERENCES print_job_documents(id),
      FOREIGN KEY (created_by)           REFERENCES users(id),
      FOREIGN KEY (assigned_operator_id) REFERENCES users(id),
      UNIQUE (job_id, version_no)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_reworks_job ON print_job_reworks(job_id, version_no)');
  db.run('CREATE INDEX IF NOT EXISTS idx_reworks_operator ON print_job_reworks(assigned_operator_id, status)');
  // At most one open rework per job — two in flight would race for the same
  // version number and leave the history ambiguous.
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_reworks_one_open
          ON print_job_reworks(job_id) WHERE status IN ('pending','in_progress')`);

  // Saved JCC drafts — one row per unfinished claim form (raw form JSON).
  // Kept separate from voucher_requests so half-filled claims never enter the
  // approval pipeline, trigger PO guards, or consume JCC numbers.
  db.run(`
    CREATE TABLE IF NOT EXISTS voucher_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT,
      form_data TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Manual "remind approver" nudges from the claimant (rate-limited to 1/day/claim).
  // Also serves as an audit trail of who nudged whom and when.
  db.run(`
    CREATE TABLE IF NOT EXISTS jcc_reminder_nudges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      reminded_by_id INTEGER,
      reminded_by_name TEXT,
      approver_name TEXT,
      level INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (voucher_id) REFERENCES voucher_requests(id)
    )
  `);

  // Approver out-of-office delegations. During [from_date, to_date], the delegate
  // sees and can act on the delegator's pending approvals (visibility + audit).
  db.run(`
    CREATE TABLE IF NOT EXISTS approval_delegations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delegator_id INTEGER NOT NULL,
      delegator_name TEXT,
      delegate_id INTEGER NOT NULL,
      delegate_name TEXT,
      from_date DATE NOT NULL,
      to_date DATE NOT NULL,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (delegator_id) REFERENCES users(id),
      FOREIGN KEY (delegate_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    INSERT OR IGNORE INTO app_settings (key, value) VALUES
      ('session_timeout_hours', '8'),
      ('return_maker_checker_enabled', '0'),
      ('return_reminder_advance_days', '2'),
      ('activity_log_retention_days', '180'),
      ('reminder_email_roles', 'admin,manager,coordinator,final_approver'),
      ('reminder_notification_roles', 'admin,manager,coordinator,final_approver')
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS asset_return_reminder_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id INTEGER NOT NULL,
      reminder_type TEXT NOT NULL,
      reminder_date DATE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(assignment_id, reminder_type, reminder_date),
      FOREIGN KEY (assignment_id) REFERENCES asset_assignments(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS jcc_approval_reminder_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      approval_level TEXT NOT NULL,
      reminder_date DATE NOT NULL,
      recipients TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(voucher_id, approval_level, reminder_date),
      FOREIGN KEY (voucher_id) REFERENCES voucher_requests(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS voucher_supplier_ack_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      recipient_email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      used_at DATETIME,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (voucher_id) REFERENCES voucher_requests(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_voucher_supplier_ack_tokens_voucher_id ON voucher_supplier_ack_tokens(voucher_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_voucher_supplier_ack_tokens_expires_at ON voucher_supplier_ack_tokens(expires_at)');

  db.run(`
    CREATE TABLE IF NOT EXISTS voucher_supplier_ack_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      token_id INTEGER,
      event_type TEXT NOT NULL,
      event_by_email TEXT,
      remarks TEXT,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (voucher_id) REFERENCES voucher_requests(id),
      FOREIGN KEY (token_id) REFERENCES voucher_supplier_ack_tokens(id)
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_voucher_supplier_ack_events_voucher_id ON voucher_supplier_ack_events(voucher_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_voucher_supplier_ack_events_event_type ON voucher_supplier_ack_events(event_type)');

  // Email event audit log — tracks every send attempt (success/failure)
  db.run(`
    CREATE TABLE IF NOT EXISTS email_event_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient TEXT NOT NULL,
      subject TEXT,
      template_name TEXT,
      entity_type TEXT,
      entity_id TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      message_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_email_event_logs_status ON email_event_logs(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_email_event_logs_created_at ON email_event_logs(created_at)');

  const feedbackTableExists = (db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback_submissions'")?.[0]?.values?.length || 0) > 0;
  const feedbackStatusIndexExists = (db.exec("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_feedback_submissions_status'")?.[0]?.values?.length || 0) > 0;
  const feedbackCreatedAtIndexExists = (db.exec("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_feedback_submissions_created_at'")?.[0]?.values?.length || 0) > 0;
  const feedbackUserIndexExists = (db.exec("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_feedback_submissions_user_id'")?.[0]?.values?.length || 0) > 0;

  db.run(`
    CREATE TABLE IF NOT EXISTS feedback_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      feedback_type TEXT NOT NULL,
      rating INTEGER,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      module_path TEXT,
      steps_to_reproduce TEXT,
      expected_result TEXT,
      actual_result TEXT,
      attachment_path TEXT,
      contact_allowed INTEGER DEFAULT 0,
      status TEXT DEFAULT 'new',
      priority TEXT DEFAULT 'medium',
      assigned_to INTEGER,
      admin_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (assigned_to) REFERENCES users(id)
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_feedback_submissions_status ON feedback_submissions(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_feedback_submissions_created_at ON feedback_submissions(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_feedback_submissions_user_id ON feedback_submissions(user_id)');

  if (!feedbackTableExists || !feedbackStatusIndexExists || !feedbackCreatedAtIndexExists || !feedbackUserIndexExists) {
    saveDatabase();
    console.log('✓ Feedback table and indexes checked/added');
  }

  // ===== DEVICE BINDING & SINGLE SESSION TABLES =====

  db.run(`
    CREATE TABLE IF NOT EXISTS active_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      session_token TEXT UNIQUE NOT NULL,
      user_agent TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS device_bind_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      device_id TEXT,
      action TEXT NOT NULL,
      performed_by INTEGER,
      ip_address TEXT,
      user_agent TEXT,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (performed_by) REFERENCES users(id)
    )
  `);

  console.log('✓ Device binding tables created');

  // Migration: Add return maker-checker columns to asset_assignments
  try {
    const assignmentInfo = db.exec("PRAGMA table_info(asset_assignments)");
    const assignmentColumns = assignmentInfo.length > 0 ? assignmentInfo[0].values : [];
    const assignmentColNames = assignmentColumns.map(col => col[1]);

    const assignmentColumnsToAdd = [
      { name: 'return_request_status', type: "TEXT DEFAULT 'none'" },
      { name: 'return_requested_date', type: 'DATE' },
      { name: 'return_requested_remarks', type: 'TEXT' },
      { name: 'return_requested_by', type: 'INTEGER' },
      { name: 'return_approved_by', type: 'INTEGER' },
      { name: 'return_approved_at', type: 'DATETIME' },
      { name: 'return_rejection_reason', type: 'TEXT' }
    ];

    assignmentColumnsToAdd.forEach(col => {
      if (!assignmentColNames.includes(col.name)) {
        db.run(`ALTER TABLE asset_assignments ADD COLUMN ${col.name} ${col.type}`);
        console.log(`✓ Added ${col.name} column to asset_assignments table`);
      }
    });
  } catch (error) {
    console.error('Error adding maker-checker columns to asset_assignments table:', error);
  }

  // Migration: Add device binding columns to users table
  try {
    const userTableInfoDev = db.exec("PRAGMA table_info(users)");
    const userColsDev = userTableInfoDev.length > 0 ? userTableInfoDev[0].values : [];
    const userColNamesDev = userColsDev.map(col => col[1]);

    const deviceColumns = [
      { name: 'registered_device_id', type: 'TEXT' },
      { name: 'device_bound_at', type: 'DATETIME' },
      { name: 'device_user_agent', type: 'TEXT' },
      { name: 'device_bound_ip', type: 'TEXT' },
      { name: 'device_unbound_at', type: 'DATETIME' },
      { name: 'device_unbound_by', type: 'INTEGER' },
      { name: 'account_limit', type: 'INTEGER DEFAULT 1' }
    ];

    deviceColumns.forEach(col => {
      if (!userColNamesDev.includes(col.name)) {
        console.log(`Adding ${col.name} column to users table...`);
        db.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
        saveDatabase();
      }
    });

    console.log('✓ Device binding columns checked/added to users table');
  } catch (error) {
    console.error('Error adding device binding columns:', error);
  }

  console.log('✓ Database tables created');

  // Migration: Add attachment_path column if it doesn't exist
  try {
    const tableInfoResult = db.exec("PRAGMA table_info(voucher_requests)");
    const columns = tableInfoResult.length > 0 ? tableInfoResult[0].values : [];
    const hasAttachmentPath = columns.some(col => col[1] === 'attachment_path');

    if (!hasAttachmentPath) {
      console.log('Adding attachment_path column to voucher_requests table...');
      db.exec('ALTER TABLE voucher_requests ADD COLUMN attachment_path TEXT');
      saveDatabase();
      console.log('✓ attachment_path column added successfully');
    }
  } catch (error) {
    console.error('Error adding attachment_path column:', error);
  }

  // Migration: Add ps_number, must_change_password, profile_completed, and profile_verified_at to users table
  try {
    const userTableInfo = db.exec("PRAGMA table_info(users)");
    const userColumns = userTableInfo.length > 0 ? userTableInfo[0].values : [];
    const userColumnNames = userColumns.map(col => col[1]);

    if (!userColumnNames.includes('ps_number')) {
      console.log('Adding ps_number column to users table...');
      db.exec('ALTER TABLE users ADD COLUMN ps_number TEXT');
      saveDatabase();
    }

    if (!userColumnNames.includes('must_change_password')) {
      console.log('Adding must_change_password column to users table...');
      db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 1');
      saveDatabase();
    }

    if (!userColumnNames.includes('profile_completed')) {
      console.log('Adding profile_completed column to users table...');
      db.exec('ALTER TABLE users ADD COLUMN profile_completed INTEGER DEFAULT 1');
      db.exec('UPDATE users SET profile_completed = 1 WHERE profile_completed IS NULL');
      saveDatabase();
    }

    if (!userColumnNames.includes('profile_verified_at')) {
      console.log('Adding profile_verified_at column to users table...');
      db.exec('ALTER TABLE users ADD COLUMN profile_verified_at DATETIME');
      db.exec("UPDATE users SET profile_verified_at = datetime('now') WHERE profile_completed = 1 AND profile_verified_at IS NULL");
      saveDatabase();
    }

    console.log('✓ User management columns checked/added');
  } catch (error) {
    console.error('Error adding user management columns:', error);
  }

  // Migration: Add login security lockout columns to users table
  try {
    const userTableInfo = db.exec("PRAGMA table_info(users)");
    const userColumns = userTableInfo.length > 0 ? userTableInfo[0].values : [];
    const userColumnNames = userColumns.map(col => col[1]);

    const loginSecurityColumns = [
      { name: 'failed_login_attempts', type: 'INTEGER DEFAULT 0' },
      { name: 'locked_until', type: 'DATETIME' }
    ];

    let didAddLoginSecurityColumn = false;
    loginSecurityColumns.forEach(col => {
      if (!userColumnNames.includes(col.name)) {
        console.log(`Adding ${col.name} column to users table...`);
        db.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
        didAddLoginSecurityColumn = true;
      }
    });

    if (didAddLoginSecurityColumn) {
      saveDatabase();
    }

    console.log('✓ Login security columns checked/added');
  } catch (error) {
    console.error('Error adding login security columns:', error);
  }

  // Migration: Update role CHECK constraint to include new roles
  try {
    // Check if we need to update the constraint (checking for 'initiator' or 'final_approver')
    const tableSchema = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
    const tableSql = tableSchema.length > 0 ? tableSchema[0].values[0][0] : '';

    if (tableSql && !tableSql.includes("'initiator'")) {
      console.log('Updating users table to support new role structure...');

      // Create a new table with the updated constraint
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ps_number TEXT UNIQUE,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('vendor', 'coordinator', 'admin', 'manager', 'initiator', 'user', 'final_approver')),
          manager_id INTEGER,
          must_change_password INTEGER DEFAULT 1,
          profile_completed INTEGER DEFAULT 1,
          profile_verified_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (manager_id) REFERENCES users(id)
        )
      `);

      // Copy all data from old table to new table
      // migrate 'vendor' role to 'initiator'
      db.exec(`
         INSERT INTO users_new (id, ps_number, name, email, password, role, manager_id, must_change_password, profile_completed, profile_verified_at, created_at)
        SELECT id, ps_number, name, email, password, 
               CASE 
                 WHEN role = 'vendor' THEN 'initiator'
                 ELSE role
               END,
           manager_id, must_change_password, 1, datetime('now'), created_at
        FROM users
      `);

      // Drop old table
      db.exec('DROP TABLE users');

      // Rename new table to users
      db.exec('ALTER TABLE users_new RENAME TO users');

      saveDatabase();
      console.log('✓ Users table updated with new roles (initiator, final_approver)');
    }
  } catch (error) {
    console.error('Error updating role constraint:', error);
  }

  // Migration: Add manager_id column to users table
  try {
    const userTableInfo = db.exec("PRAGMA table_info(users)");
    const userColumns = userTableInfo.length > 0 ? userTableInfo[0].values : [];
    const userColumnNames = userColumns.map(col => col[1]);

    if (!userColumnNames.includes('manager_id')) {
      console.log('Adding manager_id column to users table...');
      db.exec('ALTER TABLE users ADD COLUMN manager_id INTEGER');
      saveDatabase();
      console.log('✓ manager_id column added');
    }
  } catch (error) {
    console.error('Error adding manager_id column:', error);
  }


  // Create default users if they don't exist
  const result = db.exec('SELECT COUNT(*) as count FROM users');
  const userCount = result.length > 0 ? result[0].values[0][0] : 0;

  // Drop old letter_templates table if it exists with old schema
  try {
    const tableCheck = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='letter_templates'");
    if (tableCheck.length > 0 && tableCheck[0].values[0][0].includes('template_name')) {
      console.log('Dropping old letter_templates table with outdated schema...');
      db.exec('DROP TABLE IF EXISTS letter_templates');
      saveDatabase();
      console.log('✓ Old letter_templates table dropped');
    }
  } catch (error) {
    console.error('Error checking/dropping old letter_templates table:', error);
  }

  // Create letter management tables
  console.log('Creating letter management tables...');

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS incoming_letters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reference_number TEXT UNIQUE,
        subject TEXT,
        sender_name TEXT,
        sender_address TEXT,
        received_date DATE,
        original_file_path TEXT,
        ocr_text TEXT,
        ocr_confidence REAL,
        status TEXT DEFAULT 'pending',
        assigned_to INTEGER,
        project_id INTEGER,
        customer_id INTEGER,
        response_letter_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed_at DATETIME,
        FOREIGN KEY (assigned_to) REFERENCES users(id),
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (customer_id) REFERENCES customers(id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS letter_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        template_type TEXT,
        html_content TEXT NOT NULL,
        variables TEXT,
        header_content TEXT,
        footer_content TEXT,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        FOREIGN KEY (created_by) REFERENCES users(id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS generated_letters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER,
        letter_number TEXT UNIQUE,
        subject TEXT,
        recipient_name TEXT,
        recipient_address TEXT,
        project_id INTEGER,
        customer_id INTEGER,
        milestone_id INTEGER,
        in_response_to INTEGER,
        generated_content TEXT,
        pdf_path TEXT,
        qr_code TEXT,
        verification_token TEXT,
        status TEXT DEFAULT 'draft',
        generated_by INTEGER,
        generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        released_at DATETIME,
        FOREIGN KEY (template_id) REFERENCES letter_templates(id),
        FOREIGN KEY (in_response_to) REFERENCES incoming_letters(id),
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (customer_id) REFERENCES customers(id),
        FOREIGN KEY (generated_by) REFERENCES users(id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS letter_signatures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        letter_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        signature_hash TEXT NOT NULL,
        signature_id TEXT UNIQUE,
        signed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (letter_id) REFERENCES generated_letters(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    saveDatabase();
    console.log('✓ Letter management tables created');

    // ===== Seed single Admin user (PS-based login) =====
    try {
      const adminPsNumber = '123455';
      const adminEmail = 'admin@jcc.com';
      const passwordPlain = 'Admin@123';

      // Check if the admin already exists
      const existingAdmin = db.prepare(`
    SELECT id FROM users WHERE ps_number = ?
  `).get(adminPsNumber);

      if (!existingAdmin) {
        const passwordHash = bcrypt.hashSync(passwordPlain, 10);

        db.run(`
      INSERT INTO users (
        ps_number,
        name,
        email,
        password,
        role,
        must_change_password
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [
          adminPsNumber,
          'Admin User',
          adminEmail,
          passwordHash,
          'admin',
          0
        ]);

        saveDatabase();

        console.log('✓ Admin user seeded');
        console.log('  PS Number:', adminPsNumber);
        console.log('  Password :', passwordPlain);
      } else {
        console.log('✓ Admin user already exists, skipping seed');
      }
    } catch (err) {
      console.error('Error seeding admin user:', err);
    }

    // Draft printing rate card. Idempotent, and it refuses to touch an approved
    // version, so re-seeding on every boot is safe.
    try {
      // The authoritative rate master is the annexure workbook. Import it when the
      // file is present; the photo transcription is only a fallback for environments
      // that do not ship the spreadsheet.
      const wbPath = path.join(__dirname, '..', 'PRINTING ANEXERE_2022 RATE CHANGE1.xlsx');
      if (fs.existsSync(wbPath)) {
        const r = importRateWorkbook(rawDb, wbPath, {
          code: 'RC-2022',
          label: 'Printing & Binding Services — 2022 rate change',
          effectiveFrom: '2022-01-01',
          sourceNote: 'Imported from PRINTING ANEXERE_2022 RATE CHANGE1.xlsx',
        });
        if (r.skipped) console.log(`✓ Rate card RC-2022: ${r.skipped}`);
        else console.log(`✓ Rate card RC-2022 imported — ${r.services} services, ${r.lines} rates`);
        r.warnings?.forEach((w) => console.warn('  [rates]', w));
      } else {
        const result = seedRateCard(rawDb);
        if (result.skipped) console.log('✓ Rate card RC-2026-08 already approved, seed skipped');
        else console.log(`✓ Rate card RC-2026-08 seeded as draft — ${result.lines} lines`);
      }
    } catch (err) {
      console.error('Error seeding rate card:', err.message);
    }
  } catch (error) {
    console.error('Error creating letter management tables:', error);
  }
};

// better-sqlite3 persists automatically (WAL journal) — no manual full-file save
// needed. Kept as a no-op so the many saveDatabase() calls in the migrations above
// remain valid without change.
const saveDatabase = () => {};

// Native transaction: db.transaction(fn) returns a function that runs fn atomically
// when invoked — same shape the callers already use: db.transaction(fn)().
const transaction = (callback) => rawDb.transaction(callback);

// Initialize database on module load (synchronous)
initDatabase();

export default {
  prepare: (sql) => db.prepare(sql), // shim stmt: run/get/all with normalized params
  exec: (sql) => db.exec(sql),       // shim exec: sql.js-shaped results for SELECT/PRAGMA
  transaction,
};
