const domain = require("./domain.queries");
const visit = require("./visit.queries");
const link = require("./target.queries");
const target = require("./link.queries");
const user = require("./user.queries");
const host = require("./host.queries");

module.exports = {
  domain,
  host,
  link,
  target,
  user,
  visit
};
