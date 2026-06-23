CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL
);

CREATE TABLE mailboxes (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    app_password VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'active',
    sent_today INT DEFAULT 0,
    last_sent_date DATE,
    daily_limit INT DEFAULT 30,
    fail_count INT DEFAULT 0,
    warmup_mode BOOLEAN DEFAULT false,
    warmup_enabled BOOLEAN DEFAULT true,
    warmup_sent_today INT DEFAULT 0,
    warmup_daily_limit INT DEFAULT 5
);

CREATE TABLE campaigns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'draft',
    loaded INT DEFAULT 0,
    sent INT DEFAULT 0,
    pending INT DEFAULT 0,
    bounced INT DEFAULT 0,
    failed INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE leads (
    id SERIAL PRIMARY KEY,
    campaign_id INT REFERENCES campaigns(id),
    recipient_email VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    website VARCHAR(255),
    subject TEXT,
    body TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE replies (
    id SERIAL PRIMARY KEY,
    from_email VARCHAR(255),
    to_email VARCHAR(255),
    subject TEXT,
    body TEXT,
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE manual_actions (
    id SERIAL PRIMARY KEY,
    from_email VARCHAR(255),
    to_email VARCHAR(255),
    subject TEXT,
    body TEXT,
    status VARCHAR(50) DEFAULT 'pending'
);

CREATE TABLE warmup_threads (
    id SERIAL PRIMARY KEY,
    sender_email VARCHAR(255),
    receiver_email VARCHAR(255),
    subject TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
