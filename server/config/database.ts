import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'nova_leadup';

export const pool = mysql.createPool({
 host: DB_HOST,
 user: DB_USER,
 password: DB_PASSWORD,
 database: DB_NAME,
 waitForConnections: true,
 connectionLimit: 20,
 queueLimit: 0,
 enableKeepAlive: true,
 keepAliveInitialDelay: 0,
});

export async function initDatabase() {
 try {
 // First connect without database to create it if needed
 const tempPool = mysql.createPool({
 host: DB_HOST,
 user: DB_USER,
 password: DB_PASSWORD,
 waitForConnections: true,
 connectionLimit: 5,
 });

 await tempPool.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
 await tempPool.end();

 // Now use the main pool with the database
 const connection = await pool.getConnection();

 // Enable foreign key checks
 await connection.query('SET FOREIGN_KEY_CHECKS = 1');

 // Create users table
 await connection.query(`
 CREATE TABLE IF NOT EXISTS \`users\` (
 \`id\` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 \`email\` VARCHAR(255) NOT NULL UNIQUE,
 \`password_hash\` VARCHAR(255) NOT NULL,
 \`name\` VARCHAR(255) NOT NULL,
 \`role\` ENUM('admin', 'manager', 'user') DEFAULT 'user' NOT NULL,
 \`is_active\` BOOLEAN DEFAULT TRUE NOT NULL,
 \`last_login\` DATETIME NULL,
 \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 INDEX \`idx_email\` (\`email\`),
 INDEX \`idx_role\` (\`role\`),
 INDEX \`idx_is_active\` (\`is_active\`)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
 `);

 // Create leads table with enhanced schema
 await connection.query(`
 CREATE TABLE IF NOT EXISTS \`leads\` (
 \`id\` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 \`first_name\` VARCHAR(100) NOT NULL,
 \`last_name\` VARCHAR(100) NOT NULL,
 \`email\` VARCHAR(255) NOT NULL,
 \`phone\` VARCHAR(20) NOT NULL,
 \`company\` VARCHAR(255) NOT NULL,
 \`source\` ENUM('website', 'referral', 'social_media', 'advertisement', 'cold_call', 'other') DEFAULT 'other' NOT NULL,
 \`status\` ENUM('new', 'contacted', 'qualified', 'converted', 'lost') DEFAULT 'new' NOT NULL,
 \`notes\` TEXT,
 \`score\` INT UNSIGNED DEFAULT 0,
 \`assigned_to\` INT UNSIGNED NULL,
 \`is_active\` BOOLEAN DEFAULT TRUE NOT NULL,
 \`deleted_at\` DATETIME NULL,
 \`created_by\` INT UNSIGNED NOT NULL,
 \`updated_by\` INT UNSIGNED NOT NULL,
 \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 INDEX \`idx_status\` (\`status\`),
 INDEX \`idx_source\` (\`source\`),
 INDEX \`idx_email\` (\`email\`),
 INDEX \`idx_company\` (\`company\`),
 INDEX \`idx_created_at\` (\`created_at\`),
 INDEX \`idx_assigned_to\` (\`assigned_to\`),
 INDEX \`idx_is_active\` (\`is_active\`),
 INDEX \`idx_deleted_at\` (\`deleted_at\`),
 INDEX \`idx_score\` (\`score\`),
 CONSTRAINT \`fk_leads_created_by\` FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT \`fk_leads_updated_by\` FOREIGN KEY (\`updated_by\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT \`fk_leads_assigned_to\` FOREIGN KEY (\`assigned_to\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
 `);

 // Create lead_activities table for tracking interactions
 await connection.query(`
 CREATE TABLE IF NOT EXISTS \`lead_activities\` (
 \`id\` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 \`lead_id\` INT UNSIGNED NOT NULL,
 \`user_id\` INT UNSIGNED NOT NULL,
 \`activity_type\` ENUM('call', 'email', 'meeting', 'note', 'status_change', 'assignment') NOT NULL,
 \`description\` TEXT NOT NULL,
 \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT \`fk_activities_lead_id\` FOREIGN KEY (\`lead_id\`) REFERENCES \`leads\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT \`fk_activities_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE,
 INDEX \`idx_lead_id\` (\`lead_id\`),
 INDEX \`idx_user_id\` (\`user_id\`),
 INDEX \`idx_activity_type\` (\`activity_type\`),
 INDEX \`idx_created_at\` (\`created_at\`)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
 `);

 // Create audit_logs table for system-wide audit trail
 await connection.query(`
 CREATE TABLE IF NOT EXISTS \`audit_logs\` (
 \`id\` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 \`user_id\` INT UNSIGNED NULL,
 \`action\` VARCHAR(100) NOT NULL,
 \`entity_type\` VARCHAR(50) NOT NULL,
 \`entity_id\` INT UNSIGNED NOT NULL,
 \`old_values\` JSON NULL,
 \`new_values\` JSON NULL,
 \`ip_address\` VARCHAR(45) NULL,
 \`user_agent\` TEXT NULL,
 \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT \`fk_audit_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE,
 INDEX \`idx_user_id\` (\`user_id\`),
 INDEX \`idx_entity\` (\`entity_type\`, \`entity_id\`),
 INDEX \`idx_action\` (\`action\`),
 INDEX \`idx_created_at\` (\`created_at\`)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
 `);

 // Create default admin user if not exists (password: admin123 - should be changed immediately)
 const [users] = await connection.query('SELECT COUNT(*) as count FROM users WHERE role = ?', ['admin']);
 if (users[0].count === 0) {
 const bcrypt = await import('bcryptjs');
 const passwordHash = bcrypt.hashSync('admin123', 10);
 await connection.query(
 'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
 ['admin@novaleadup.com', passwordHash, 'System Administrator', 'admin']
 );
 console.log('Default admin user created: admin@novaleadup.com / admin123');
 }

 await connection.release();
 console.log('Database initialized successfully');
 } catch (error) {
 console.error('Database initialization error:', error);
 throw error;
 }
}
