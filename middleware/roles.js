// services/api/middleware/roles.js

function requireRole(allowed = []) {
  return (req, res, next) => {
    const user = req?.userDoc || {};
    // normalize: prefer array 'roles'; fallback to single 'role'
    const roles = Array.isArray(user.roles) && user.roles.length ? user.roles
                 : (user.role ? [user.role] : []);
    if (!roles.length) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const ok = roles.some(r => allowed.includes(r));
    if (!ok) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    next();
  };
}
module.exports = { requireRole };


