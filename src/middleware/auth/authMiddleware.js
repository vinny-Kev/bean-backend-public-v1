import { compareToPattern, inRangeOfLength } from '../../util/validations.js';
import { pool } from '../../db/pool.js';
import bcrypt from 'bcrypt';

export const validateSignupData = async (req, res, next) => {
    const { username, email, password } = req.body;
    
    const normalizedUsername =
        typeof username=== 'string' ? username.trim(): '';

    console.log('[AUTH MIDDLEWARE]  START Validating signup data:', { username, email });
    if (!normalizedUsername)  {
        console.log('[AUTH MIDDLEWARE]: End Process -  Username is required.');
        return res.status(400).json({ message: 'Username is required are required.' });
    }    
    if (!compareToPattern(normalizedUsername, "alphanumeric") || !inRangeOfLength(normalizedUsername, 3, 20)) {
        console.log('[AUTH MIDDLEWARE]: End Process - Username is invalid.');
        return res.status(400).json({ message: 'Username must be alphanumeric.' });
    }

    if (!email) {
        console.log('[AUTH MIDDLEWARE]: End Process - Email is required.');
        return res.status(400).json({ message: 'Email is required.' });
    }
    if (!compareToPattern(email, "email")) {
        console.log('[AUTH MIDDLEWARE]: End Process - Email is invalid.');
        return res.status(400).json({ message: 'Email is not valid.' });
    }
    if (!password) {
        console.log('[AUTH MIDDLEWARE]: End Process - Password is required.');
        return res.status(400).json({ message: 'Password is required.' });
    }
    if (!compareToPattern(password, "password") ||
    !inRangeOfLength(password, 8, 20)) {
        console.log('[AUTH MIDDLEWARE]: End Process - Password is invalid.');
        return res.status(400).json({ message: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character.' });
    }
    console.log('[AUTH MIDDLEWARE]: End Process - Checking for duplicate database records.');
    const existingUserQuery = 'SELECT EXISTS ( SELECT 1 FROM users WHERE email = $1) AS exists';
    const existingUserResult = await pool.query(existingUserQuery, [email]);
    if (existingUserResult.rows[0].exists) {
        console.log('[AUTH MIDDLEWARE]: End Process - User already exists.');
        return res.status(400).json({ message: 'User with this email already exists.' });
    }
    console.log('[AUTH MIDDLEWARE]: End Process SUCCESS - Signup data validation passed.');
    next();
};

export const validateLoginData = async (req, res ,next) => {
    const { email, password} = req.body ?? {};

    if (typeof email !== 'string' || !email.trim() ){
        console.log('[AUTH MIDDLEWARE]: End Process - Email is required.');
        return res.status(400).json({message: ' Email is required.'})
    }

    if (typeof password !== 'string' || !password ){
        console.log('[AUTH MIDDLEWARE]: End Process - password is required.');
        return res.status(400).json({message: ' password is required.'})
    }

    try{
        const trimmedEmail = email.trim().toLowerCase();

        const result = await pool.query(
            `SELECT id, email, username, password_hash, role_id
            FROM users
            WHERE email = $1`,
            [trimmedEmail]
        )

        const user = result.rows[0];

        const passwordIsValid = user && await bcrypt.compare(password, user.password_hash)

        if (!passwordIsValid){
            console.log("[AUTH MIIDDLEWARE]: End Process - Invalid email or password.")
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        req.user = {
            id: user.id,
            email: user.email,
            username: user.username,
            role: user.role_id
        };

        console.log("[AUTH MIIDDLEWARE]: End Process SUCCESS - Login Validation Passed")
        return next();
    }catch(error){
        console.log("[AUTH MIDDLEWARE]: End Process - Error during login validation:", error)
        return res.status(500).json({ message: 'Internal server error during login validation.' });
    }
};

