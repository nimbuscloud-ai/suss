# @suss/framework-fabrication

The pack for [Fabrication](https://fabricationgem.org). It tells suss
which class each fabricator builds, so a test that builds a record and
calls a method on it reaches that method. Run it next to a test pack
such as `rspec`:

```bash
suss extract --lang ruby -f rails -f rspec -f fabrication --intent intent/ -o .suss/code.json
```

```ruby
Fabricator(:status) do
  text "hello"
end

Fabricator(:reblog, from: :status) do
end

RSpec.describe Status do
  let(:reblog) { Fabricate(:reblog) }

  it "is a reblog" do
    expect(reblog.reblog?).to be true
  end
end
```

`Fabricate(:reblog)` gives back a `Status`, since `reblog` builds on
`status`, so `reblog.reblog?` reaches `Status#reblog?` and a PRD
scenario can list the test under `coveredBy`.

## What it reads

- Definitions: `Fabricator(:name)` wherever the run reads it, such as
  `spec/fabricators`. A fabricator's class is its `class_name:`, else
  the fabricator or class it gives as `from:`, else the class its own
  name camelizes to, with the project's inflection acronyms.
- Builds: `Fabricate(:name)`, `Fabricate.build(:name)` and
  `Fabricate.create(:name)`. Only builds in the files the run reads as
  tests are typed.

## What this leaves out

- `Fabricate.times` and the list builders, which give back an array,
  and `Fabricate.attributes_for`, which gives back a hash.
- A fabricator whose class the run does not define, such as one for a
  class a gem provides.
