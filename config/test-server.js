var express = require("express");
var app = express();
var path = require("path");

// Routes used by the navigation tests. They live under /nav so they never shadow static pages.
var flakyCounters = {};

// Responds only after ?ms= milliseconds (default 30 s); used to exercise navigation timeouts.
app.get("/nav/slow", function (req, res) {
  var ms = parseInt(req.query.ms, 10) || 30000;
  var timer = setTimeout(function () {
    res.send("<html><head><title>slow</title></head><body>slow</body></html>");
  }, ms);
  req.on("close", function () {
    clearTimeout(timer);
  });
});

// First request per key answers 503, later ones 200, so a single retry recovers.
app.get("/nav/flaky/:key", function (req, res) {
  var key = req.params.key;
  flakyCounters[key] = (flakyCounters[key] || 0) + 1;
  if (flakyCounters[key] === 1) {
    res.status(503).send("unavailable");
    return;
  }
  res.send("<html><head><title>flaky</title></head><body>recovered</body></html>");
});

app.use(express.static(path.join(__dirname, "..", "__tests__/test-pages")));
app.listen(8125);
