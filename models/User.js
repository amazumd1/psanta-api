const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    trim: true,
    default: '',
    required: function () {
      return !this.firebaseUid && !this.phone;
    }
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },

  // Legacy password auth (transitional)
  password: {
    type: String,
    minlength: 6,
    required: function () {
      return !this.phone && !this.firebaseUid;
    }
  },

  // Firebase-first auth fields
  firebaseUid: {
    type: String,
    index: true,
    unique: true,
    sparse: true,
    default: null
  },
  authProvider: {
    type: String,
    enum: ['password', 'firebase', 'hybrid'],
    default: 'password'
  },
  emailVerified: {
    type: Boolean,
    default: false
  },

  // SaaS-ready identity metadata
  defaultTenantId: {
    type: String,
    default: null
  },
  activeTenantIds: [{
    type: String,
    trim: true
  }],
  tokenVersion: {
    type: Number,
    default: 0
  },

  mustSetPassword: { type: Boolean, default: false },
  resetPasswordToken: { type: String, default: null },
  resetPasswordExpires: { type: Date, default: null },

  phone: {
    type: String,
    trim: true,
    required: function () {
      return !this.password && !this.firebaseUid;
    }
  },

  role: {
    type: String,
    enum: ['admin', 'cleaner', 'customer', 'warehouse'],
    default: 'customer'
  },

  avatar: {
    type: String,
    default: null
  },
  rating: {
    type: Number,
    default: 0,
    min: 0,
    max: 5
  },
  specialties: [{
    type: String,
    trim: true
  }],
  availability: {
    monday: { type: Boolean, default: true },
    tuesday: { type: Boolean, default: true },
    wednesday: { type: Boolean, default: true },
    thursday: { type: Boolean, default: true },
    friday: { type: Boolean, default: true },
    saturday: { type: Boolean, default: false },
    sunday: { type: Boolean, default: false }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: {
    type: Date,
    default: null
  },
  unlockLockedUntil: { type: Date },
  psCooldownUntil: { type: Date },
  otp: String,
  otpExpiresAt: Date
}, {
  timestamps: true
});

// Hash password before saving (legacy password users only)
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  if (!this.password) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.toJSON = function () {
  const user = this.toObject();
  delete user.password;
  delete user.otp;
  delete user.otpExpiresAt;
  delete user.resetPasswordToken;
  delete user.resetPasswordExpires;
  return user;
};

module.exports = mongoose.model('User', userSchema);