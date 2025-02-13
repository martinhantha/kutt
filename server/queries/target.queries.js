const bcrypt = require("bcryptjs");

const utils = require("../utils");
const redis = require("../redis");
const knex = require("../knex");
const env = require("../env");

const CustomError = utils.CustomError;

const selectable = [
  "targets.id",
  "targets.language",
  "targets.target",
];

const selectable_admin = [
  ...selectable,
];

function normalizeMatch(match) {
  const newMatch = { ...match };

  if (newMatch.language) {
    newMatch["targets.language"] = newMatch.language;
    delete newMatch.language;
  }
  if (newMatch.target) {
    newMatch["targets.target"] = newMatch.target;
    delete newMatch.target;
  }

  if (newMatch.uuid) {
    newMatch["targets.uuid"] = newMatch.uuid;
    delete newMatch.uuid;
  }

  return newMatch;
}

async function total(match, params) {
  const normalizedMatch = normalizeMatch(match);
  const query = knex("links");
  
  Object.entries(normalizedMatch).forEach(([key, value]) => {
    query.andWhere(key, ...(Array.isArray(value) ? value : [value]));
  });

  if (params?.search) {
    query[knex.compatibleILIKE](
      knex.raw("concat_ws(' ', description, links.address, target, domains.address)"), 
      "%" + params.search + "%"
    );
  }
  query.leftJoin("domains", "links.domain_id", "domains.id");
  query.count("* as count");
  
  const [{ count }] = await query;

  return typeof count === "number" ? count : parseInt(count);
}

async function totalAdmin(match, params) {
  const query = knex("links");

  Object.entries(normalizeMatch(match)).forEach(([key, value]) => {
    query.andWhere(key, ...(Array.isArray(value) ? value : [value]));
  });
  
  if (params?.user) {
    const id = parseInt(params?.user);
    if (Number.isNaN(id)) {
      query[knex.compatibleILIKE]("users.email", "%" + params.user + "%");
      } else {
      query.andWhere("links.user_id", params.user);
    }
  }

  if (params?.search) {
    query[knex.compatibleILIKE](
      knex.raw("concat_ws(' ', description, links.address, target)"),
      "%" + params.search + "%"
    );
  }

  if (params?.domain) {
    query[knex.compatibleILIKE]("domains.address", "%" + params.domain + "%");
  }
  
  query.leftJoin("domains", "links.domain_id", "domains.id");
  query.leftJoin("users", "links.user_id", "users.id");
  query.count("* as count");

  const [{ count }] = await query;

  return typeof count === "number" ? count : parseInt(count);
}

async function get(match, params) {
  const query = knex("targets")
    .select(...selectable)
    .where(normalizeMatch(match))
    .offset(params.skip)
    .limit(params.limit)
    .orderBy("targets.id", "desc");
  
  if (params?.search) {
    query[knex.compatibleILIKE](
      knex.raw("concat_ws(' ', language, target)"), 
      "%" + params.search + "%"
    );
  }
  
  query.leftJoin("links", "targets.link_id", "links.id");

  return query;
}

async function getAdmin(match, params) {
  const query = knex("links").select(...selectable_admin);

  Object.entries(normalizeMatch(match)).forEach(([key, value]) => {
    query.andWhere(key, ...(Array.isArray(value) ? value : [value]));
  });

  query
    .orderBy("links.id", "desc")
    .offset(params.skip)
    .limit(params.limit)
  
  if (params?.user) {
    const id = parseInt(params?.user);
    if (Number.isNaN(id)) {
      query[knex.compatibleILIKE]("users.email", "%" + params.user + "%");
    } else {
      query.andWhere("links.user_id", params.user);
    }
  }

  if (params?.search) {
    query[knex.compatibleILIKE](
      knex.raw("concat_ws(' ', description, links.address, target)"),
      "%" + params.search + "%"
    );
  }

  if (params?.domain) {
    query[knex.compatibleILIKE]("domains.address", "%" + params.domain + "%");
  }
  
  query.leftJoin("domains", "links.domain_id", "domains.id");
  query.leftJoin("users", "links.user_id", "users.id");

  return query;
}

async function find(match) {
  if (match.address && match.domain_id !== undefined && env.REDIS_ENABLED) {
    const key = redis.key.link(match.address, match.domain_id);
    const cachedLink = await redis.client.get(key);
    if (cachedLink) return JSON.parse(cachedLink);
  }
  
  const link = await knex("targets")
    .select(...selectable)
    .where(normalizeMatch(match))
    .leftJoin("domains", "links.domain_id", "domains.id")
    .first();
  
  if (link && env.REDIS_ENABLED) {
    const key = redis.key.link(link.address, link.domain_id);
    redis.client.set(key, JSON.stringify(link), "EX", 60 * 15);
  }
  
  return link;
}

async function create(params, link_id = null) {
  
  let [target] = await knex(
    "targets"
  ).insert(
    {
      link_id,
      language: params.language,
      target: params.target
    },
    "*"
  );

  // mysql doesn't return the whole link, but rather the id number only
  // so we need to fetch the link ourselves
  if (typeof target === "number") {
    target = await knex("targets").where("id", target).first();
  }

  return target;
}

async function remove(match) {
  const link = await knex("links").where(match).first();
  
  if (!link) {
    return { isRemoved: false, error: "Could not find the link.", link: null }
  }

  const deletedLink = await knex("links").where("id", link.id).delete();

  if (env.REDIS_ENABLED) {
    redis.remove.link(link);
  }
  
  return { isRemoved: !!deletedLink, link };
}

async function batchRemove(match) {
  const query = knex("links");
  
  Object.entries(match).forEach(([key, value]) => {
    query.andWhere(key, ...(Array.isArray(value) ? value : [value]));
  });
  
  const links = await query.clone();
  
  await query.delete();
  
  if (env.REDIS_ENABLED) {
    links.forEach(redis.remove.link);
  }
}

async function update(match, update) {
  if (update.password) {
    const salt = await bcrypt.genSalt(12);
    update.password = await bcrypt.hash(update.password, salt);
  }

  // if the links' adddress or domain is changed,
  // make sure to delete the original links from cache 
  let links = []
  if (env.REDIS_ENABLED && (update.address || update.domain_id)) {
    links = await knex("links").select('*').where(match);
  }
  
  await knex("links")
    .where(match)
    .update({ ...update, updated_at: utils.dateToUTC(new Date()) });

  const updated_links = await knex("links").select('*').where(match);

  if (env.REDIS_ENABLED) {
    links.forEach(redis.remove.link);
    updated_links.forEach(redis.remove.link);
  }
  
  return updated_links;
}

function incrementVisit(match) {
  return knex("links").where(match).increment("visit_count", 1);
}

module.exports = {
  normalizeMatch,
  batchRemove,
  create,
  find,
  get,
  getAdmin,
  incrementVisit,
  remove,
  total,
  totalAdmin,
  update,
}
