CREATE DATABASE IF NOT EXISTS liebherr_site
CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci;

USE liebherr_site;

CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cranes (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    model_name VARCHAR(255) NOT NULL,
    serial_number VARCHAR(100) NOT NULL UNIQUE,
    location VARCHAR(255) NULL,
    current_location VARCHAR(255) NULL,
    model_year INT NULL,
    status ENUM('Active', 'Under Maintenance', 'Inactive') NOT NULL DEFAULT 'Active',
    capacity_tons DECIMAL(10,2) NULL,
    operator_name VARCHAR(255) NULL,
    helper_name VARCHAR(255) NULL,
    additional_notes TEXT NULL,
    maintenance_details TEXT NULL,
    finance_details TEXT NULL,
    image_data LONGTEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crane_certificates (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    crane_id INT UNSIGNED NOT NULL,
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
);

CREATE TABLE IF NOT EXISTS crane_maintenance_records (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    crane_id INT UNSIGNED NOT NULL,
    maintenance_date DATE NOT NULL,
    problem_cause VARCHAR(500) NOT NULL,
    repaired_by VARCHAR(255) NOT NULL,
    spare_part_used VARCHAR(500) NULL,
    cost_egp DECIMAL(12,2) NOT NULL DEFAULT 0,
    invoice_name VARCHAR(255) NULL,
    invoice_data LONGBLOB NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_crane_maintenance_crane_id (crane_id),
    CONSTRAINT fk_crane_maintenance_crane
        FOREIGN KEY (crane_id) REFERENCES cranes(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS crane_finance_transactions (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    crane_id INT UNSIGNED NOT NULL,
    type ENUM('revenue','expense') NOT NULL,
    transaction_date DATE NOT NULL,
    amount DECIMAL(14,2) NOT NULL,
    details VARCHAR(500) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_crane_finance_crane_date (crane_id, transaction_date),
    CONSTRAINT fk_crane_finance_crane
        FOREIGN KEY (crane_id) REFERENCES cranes(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS persons (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(150) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_persons_name (name)
);

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
);

CREATE TABLE IF NOT EXISTS company_transactions (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    category ENUM('ahmed','abdalla','ayman','aly','general','revenue') NOT NULL,
    transaction_date DATE NOT NULL,
    amount DECIMAL(14,2) NOT NULL,
    details VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_company_tx_date (transaction_date)
);