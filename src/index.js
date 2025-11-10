// services/api/src/index.js
const express = require("express");
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// (optional) print service if you have a separate global print API:
app.use("/api/print", require("./routes/print.route"));

module.exports = app;

// error handler(s) ...
// services/api/models/index.js
module.exports = {
    Task: require('./Task'),
    WarehouseOrder: require('./WarehouseOrder'),
    Alert: require('./Alert'),
    User: require('./User'),
    Property: require('./Property'),
};

