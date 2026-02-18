import dotenv from 'dotenv';
dotenv.config();

import sql from 'mssql';

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT),
  database: process.env.DB_NAME,
  options: {
    encrypt: process.env.DB_ENCRYPT === 'true',            // true or false
    trustServerCertificate: process.env.DB_TRUST_CERT === 'true', // true or false
  },
};

async function connectToDb() {
  try {
    const pool = await sql.connect(config);
    console.log('Connected to SQL Server!');
    return pool;
  } catch (err) {
    console.error('Database connection failed:', err);
  }
}

// Example usage
connectToDb();
