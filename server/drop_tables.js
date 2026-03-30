import db from './database.js';

const dropTables = () => {
    try {
        console.log('Fetching list of tables...');
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('users', 'sqlite_sequence')").all();

        if (tables.length === 0) {
            console.log('No tables found to drop.');
            return;
        }

        console.log(`Found ${tables.length} tables to drop: ${tables.map(t => t.name).join(', ')}`);

        for (const table of tables) {
            console.log(`Dropping table: ${table.name}...`);
            db.prepare(`DROP TABLE IF EXISTS ${table.name}`).run();
        }

        console.log('✓ All identified tables have been dropped.');
    } catch (error) {
        console.error('Error dropping tables:', error);
    }
};

dropTables();
