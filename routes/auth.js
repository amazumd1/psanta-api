// services/api/routes/auth.js
const express = require('express');
const { body } = require('express-validator');
const { auth } = require('../middleware/auth');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

const {
  signUp,
  loginWithPassword,
  requestOTP,
  loginWithOTP,
  getCurrentUser,
  logout,
  refreshToken
} = require('../controllers/authController');

// Validators
const signUpValidation = [
  body('name').trim().notEmpty(),
  body('email').isEmail(),
  body('password').isLength({ min: 6 })
];

const loginValidation = [
  body('email').isEmail(),
  body('password').isLength({ min: 6 })
];

const otpRequestValidation = [ body('email').isEmail() ];
const otpLoginValidation = [
  body('email').isEmail(),
  body('otp').isLength({ min: 4, max: 8 })
];

// Routes
router.post('/signup', signUpValidation, signUp);
router.post('/login', loginValidation, loginWithPassword);
router.post('/request-otp', otpRequestValidation, requestOTP);
router.post('/login-otp', otpLoginValidation, loginWithOTP);
router.get('/me', auth, getCurrentUser);
router.post('/logout', auth, logout);
router.post('/refresh', auth, refreshToken);

// POST /api/auth/request-reset  { email }
router.post('/request-reset', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ ok:false, error:'EMAIL_REQUIRED' });

    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    // Enumeration avoid: always say ok
    if (!user) return res.json({ ok: true });

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    user.resetPasswordToken = token;
    user.resetPasswordExpires = expires;
    await user.save();

    // TODO: send email with link containing ?token=...
    // For dev convenience, return token only in non-production
    const devToken = process.env.NODE_ENV === 'production' ? undefined : token;
    return res.json({ ok: true, devToken });
  } catch (e) {
    console.error('request-reset error', e);
    return res.status(500).json({ ok:false, error:'SERVER_ERROR' });
  }
});

// POST /api/auth/reset-password  { token, newPassword }
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) {
      return res.status(400).json({ ok:false, error:'BAD_REQUEST' });
    }
    if (String(newPassword).length < 8 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return res.status(400).json({ ok:false, error:'WEAK_PASSWORD', message:'Min 8 chars with letters & numbers' });
    }

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() }
    });
    if (!user) return res.status(400).json({ ok:false, error:'TOKEN_INVALID_OR_EXPIRED' });

    // hash using pre-save hook or manually:
    // if your model doesn't auto-hash, uncomment this:
    // user.password = await bcrypt.hash(String(newPassword), 10);
    user.password = String(newPassword);
    user.mustSetPassword = false;
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();

    return res.json({ ok: true });
  } catch (e) {
    console.error('reset-password error', e);
    return res.status(500).json({ ok:false, error:'SERVER_ERROR' });
  }
});


module.exports = router;
