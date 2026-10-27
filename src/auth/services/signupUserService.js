import bcrypt from 'bcrypt';
import { pool } from '../../db/pool.js';

export const signupUserService = async (req, res, next) => {
    const { username, email, password } = req.body;

    try {
        const hashedPassword = await bcrypt.hash(password, 12);
        const result = await pool.query(
            `INSERT INTO users (username, email, password_hash)
             VALUES ($1, $2, $3)
             RETURNING id, email, username, created_at`,
            [username, email, hashedPassword]
        );

        const user = result.rows[0];

        const responseData = {
            id: user.id,
            username: user.username,
            email: user.email,
            createdAt: user.created_at,
        }

        return res.status(201).json({ message: 'User registered successfully.', responseData });
    } catch (error){
        if (error.code === '23505') {
            return res.status(409).json({ message: 'An account with those details already exists.' });
        }
        return next(error);
    }
};
