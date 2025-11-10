const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { validationResult } = require('express-validator');

// --- add at top (below imports) ---
const COOKIE_NAME = 'authToken';

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,           // frontend JS se readable na ho (secure)
    sameSite: 'lax',          // CSR ke liye safe
    secure: process.env.NODE_ENV === 'production', // prod me HTTPS chahiye
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}


// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

// Sign up new user
const signUp = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { name, email, password, phone } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    // Create new user (public signup -> default role cleaner)
    const user = new User({
      name,
      email,
      password,
      phone,
      role: 'cleaner',
      rating: 0,
      specialties: [],
      availability: {
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: true,
        saturday: false,
        sunday: false
      },
      isActive: true
    });

    await user.save();

    const token = generateToken(user._id);
    setAuthCookie(res, token);

    // ✅ Top-level {token, user} response, no password
    res.status(201).json({
      success: true,
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        phone: user.phone ?? ''
      }
    });
  } catch (error) {
    console.error('Sign up error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// Login with password
const loginWithPassword = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email, password } = req.body;

    // ⚠️ select('+password') if password has select:false in schema
    const user = await User.findOne({ email, isActive: true }).select('+password');
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = generateToken(user._id);
    setAuthCookie(res, token);

    // ✅ Top-level {token, user} response
    res.json({
      success: true,
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        phone: user.phone ?? ''
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// Request OTP
const requestOTP = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email } = req.body;

    const user = await User.findOne({ email, isActive: true });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const otp = '123456'; // dev only
    user.otp = otp;
    user.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    res.json({
      success: true,
      message: 'OTP sent successfully'
      // Do NOT return OTP in production
    });
  } catch (error) {
    console.error('Request OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// Login with OTP
const loginWithOTP = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email, otp } = req.body;

    const user = await User.findOne({
      email,
      isActive: true,
      otp,
      otpExpiresAt: { $gt: new Date() }
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid OTP or OTP expired'
      });
    }

    user.otp = undefined;
    user.otpExpiresAt = undefined;
    user.lastLogin = new Date();
    await user.save();

    const token = generateToken(user._id);
    setAuthCookie(res, token);

    // ✅ Top-level {token, user} response
    res.json({
      success: true,
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        phone: user.phone ?? ''
      }
    });
  } catch (error) {
    console.error('OTP login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// Get current user
const getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        phone: user.phone ?? ''
      }
    });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// Logout

 const logout = async (_req, res) => {
   clearAuthCookie(res);
   res.json({ success: true, message: 'Logout successful' });
 };

// Refresh token
const refreshToken = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }
    const token = generateToken(user._id);
 setAuthCookie(res, token);
 res.json({ success: true, token });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = {
  signUp,
  loginWithPassword,
  requestOTP,
  loginWithOTP,
  getCurrentUser,
  logout,
  refreshToken
};


