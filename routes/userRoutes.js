const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const {
  getUsers,
  createUser,
  updateUser,
  deleteUser
} = require('../controllers/userController');

// Protect all user management routes
router.use(auth, requireRole(['admin']));

// Routes
router.get('/', getUsers);
router.post('/', createUser);
router.put('/:id', updateUser);
router.delete('/:id', deleteUser);

module.exports = router;
