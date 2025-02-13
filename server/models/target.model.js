async function createTargetTable(knex) {
  const hasTable = await knex.schema.hasTable("targets");

  if (!hasTable) {
    await knex.schema.createTable("targets", table => {
      table.increments("id").primary();
      table.string("language");
      table.string("target", 2040).notNullable();
      table.timestamps(false, true);
      table.integer("link_id").unsigned()
      table.foreign("link_id").references("id").inTable("links").onDelete("CASCADE").withKeyName("targets_link_id_foreign")
    });
  }

  const hasUUID = await knex.schema.hasColumn("targets", "uuid");
  if (!hasUUID) {
    await knex.schema.alterTable("targets", table => {
      table
        .uuid("uuid")
        .notNullable()
        .defaultTo(knex.fn.uuid());
    });
  }
}

module.exports = {
    createTargetTable
}