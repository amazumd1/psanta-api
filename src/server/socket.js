// services/api/src/server/socket.js
let io = null;

function attachIO(httpServer) {
  try {
    const { Server } = require('socket.io');
    io = new Server(httpServer, {
      cors: { origin: true, credentials: true },
    });
    io.on('connection', (socket) => {
      // TODO: auth ke baad role-based rooms
      socket.join('admins');
    });
    console.log('✅ socket.io attached');
  } catch (e) {
    console.warn('⚠️ socket.io not available:', e.message);
    io = null;
  }
}

module.exports = {
  attachIO,
  get io() { return io; }, // <-- services yahi se io read karenge
};
