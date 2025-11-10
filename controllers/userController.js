const User = require('../models/User');
const bcrypt = require('bcryptjs');

// Get all users
exports.getUsers = async (req, res) => {
  try {
    const users = await User.find().select('-password -otp -otpExpiresAt');
    res.json(users);
  } catch (error) {
    console.error('Error getting users:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Create a user
exports.createUser = async (req, res) => {
  try {
    const { name, email, password, role, phone } = req.body;
    
    // Check if user exists
    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ 
        success: false,
        message: 'User already exists' 
      });
    }

    // Create new user - password will be hashed by the pre-save hook
    user = new User({
      name,
      email,
      password, // Plain password - will be hashed by pre-save hook
      role: role || 'customer',
      phone: phone || '',
      isActive: true
    });

    await user.save();
    
    // Remove sensitive data before sending response
    user = user.toObject();
    delete user.password;
    delete user.otp;
    delete user.otpExpiresAt;

    res.status(201).json({
      success: true,
      data: user
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ 
      success: false,
      message: 'Error creating user',
      error: error.message 
    });
  }
};

// Update a user
exports.updateUser = async (req, res) => {
  try {
    const { name, email, password, role, phone, isActive } = req.body;
    
    // Create update object with provided fields
    const updateFields = { name, email, role, phone, isActive };
    
    // If password is provided, hash it before updating
    if (password) {
      const salt = await bcrypt.genSalt(10);
      updateFields.password = await bcrypt.hash(password, salt);
    }
    
    const user = await User.findByIdAndUpdate(
      req.params.id,
      updateFields,
      { new: true }
    ).select('-password -otp -otpExpiresAt');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Delete a user
exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json({ message: 'User removed' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
