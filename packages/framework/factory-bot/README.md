# @suss/framework-factory-bot

The pack for [factory_bot](https://github.com/thoughtbot/factory_bot).
It tells suss which class each factory builds, so a test that builds a
record and calls a method on it reaches that method. Run it next to a
test pack such as `rspec`:

```bash
suss extract --lang ruby -f rails -f rspec -f factory-bot --intent intent/ -o .suss/code.json
```

```ruby
FactoryBot.define do
  factory :order do
    factory :paid_order do
      paid_at { Time.current }
    end
  end
end

RSpec.describe Order do
  it "cancels" do
    order = create(:paid_order)
    order.cancel
  end
end
```

`create(:paid_order)` gives back an `Order`, since `paid_order` is
nested in `order`, so `order.cancel` in the example reaches
`Order#cancel` and a PRD scenario about cancelling can list the test
under `coveredBy`.

## What it reads

- Definitions: `factory :name` wherever the run reads it, such as
  `spec/factories`. A factory's class is its `class:` (a constant or a
  string), else the class of the factory it is nested in or gives as
  `parent:`, else the class its own name camelizes to, with the
  project's inflection acronyms.
- Builds: `create`, `build` and `build_stubbed`, written bare or on
  `FactoryBot`, with the factory's name first. Only builds in the files
  the run reads as tests are typed.

## What this leaves out

- `create_list` and `build_list`, which give back an array, and
  `attributes_for`, which gives back a hash.
- A factory whose class the run does not define, such as one for a
  class a gem provides.
- Traits, transient attributes and callbacks. They change what a
  record holds, and the pack only says which class it is.
