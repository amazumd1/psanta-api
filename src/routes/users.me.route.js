const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { auth } = require('../../middleware/auth');
const User = require('../../models/User');

// PATCH /api/users/me/password
router.patch('/me/password', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const { currentPassword, newPassword } = req.body || {};

    if (!newPassword || String(newPassword).length < 8 ||
        !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return res.status(400).json({ ok:false, error:'WEAK_PASSWORD', message:'Min 8 chars with letters & numbers' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ ok:false, error:'USER_NOT_FOUND' });

    if (!user.mustSetPassword) {
      if (!currentPassword) return res.status(400).json({ ok:false, error:'CURRENT_PASSWORD_REQUIRED' });
      const ok = await bcrypt.compare(String(currentPassword), String(user.password || ''));
      if (!ok) return res.status(400).json({ ok:false, error:'CURRENT_PASSWORD_INCORRECT' });
    }

    user.password = await bcrypt.hash(String(newPassword), 10);
    user.mustSetPassword = false;
    await user.save();

    res.json({ ok:true });
  } catch (e) {
    console.error('users.me.password', e);
    res.status(500).json({ ok:false, error:'SERVER_ERROR' });
  }
});

module.exports = router;
