# The Rails app's dump of the two tables schema.prisma declares again.
# The comments in schema.prisma say where the copy disagrees with it.

ActiveRecord::Schema[7.1].define(version: 2024_06_01_000000) do
  enable_extension "plpgsql"

  create_enum "order_state", ["pending", "paid", "shipped"]

  create_table "attachments", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "blob_id", null: false
    t.references "order", null: false, foreign_key: true
    t.string "filename", null: false
    t.datetime "created_at", null: false
  end

  create_table "orders", force: :cascade do |t|
    t.bigint "customer_id", null: false
    t.string "status", default: "pending", null: false
    t.integer "priority", null: false
    t.integer "quantity", limit: 2, null: false
    t.decimal "total", precision: 10, scale: 2, null: false
    t.float "weight"
    t.boolean "paid", default: false, null: false
    t.uuid "public_id", null: false
    t.jsonb "metadata"
    t.binary "receipt"
    t.string "tags", default: [], null: false, array: true
    t.enum "state", default: "pending", null: false, enum_type: "order_state"
    t.date "ship_on"
    t.text "notes"
    t.string "reference", null: false
    t.string "legacy_code"
    t.timestamps
  end

  add_foreign_key "orders", "users", column: "customer_id"
end
