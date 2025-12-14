// Vercel serverless entrypoint
const { app, initApp } = require("../server");

module.exports = async (req, res) => {
  await initApp();
  return app(req, res);
};
