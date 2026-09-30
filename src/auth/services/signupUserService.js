import bcrypt from 'bcrypt';
import { pool } from '../../db/pool.js';

export const signupUserService = async (req, res) => {
    const { username, email, password } = req.body;
    console.log('[SIGNUP SERVICE] Start Process - Signup user service:', { username, email, password });

    try {
        console.log('[SIGNUP SERVICE]  Hashing password.');
        const hashedPassword = await bcrypt.hash(password, 12);
        
        console.log('[SIGNUP SERVICE]  Inserting user into database.');
        const result = await pool.query(
            `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING *`,
            [username, email, hashedPassword]
        );
        console.log('[SIGNUP SERVICE] End process - User inserted into database:');
        return res.status(201).json({ message: 'User registered successfully.', user: result.rows[0] });

    } catch (error){
        console.error('[SIGNUP SERVICE]  Error during signup:', error);
        res.status(500).json({ message: 'Internal server error during signup.' });
    }
};