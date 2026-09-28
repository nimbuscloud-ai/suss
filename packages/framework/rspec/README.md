# @suss/framework-rspec

The pack for RSpec tests. It reads each example as a `test` unit, so a
PRD scenario can say which test covers it and `suss check --intent`
can check that the test is still there, still runs, and still reaches
what the scenario is about.

```ruby
RSpec.describe Order do
  describe "cancel" do
    it "changes nothing the second time" do
      expect(Order.cancel("o-1")[:status]).to eq(:cancelled)
    end
  end
end
```

That example becomes a unit named
`Order > cancel > changes nothing the second time`, and a PRD lists it
with the file in front, the same way a vitest case is listed:

```yaml
coveredBy: spec/models/order_spec.rb > Order > cancel > changes nothing the second time
```

A test is no boundary, so its unit pairs with nothing. Its calls are
followed into the project methods they reach, the same way a
controller action's are.

## Usage

Read only the spec files your PRDs list:

```bash
suss extract --lang ruby -f rspec -f rails --intent intent/ -o .suss/code.json
suss check --dir .suss --intent intent/
```

`--intent` reads the `coveredBy` lines in the PRDs under `intent/` and
hands the pack those files. Without it the pack reads every
`*_spec.rb` file, which can double what an extract walks, so
`suss init` does not suggest the pack. To name the files yourself,
write them to a config file:

```bash
suss extract --lang ruby -f rspec=rspec.json
```

```json
{ "files": ["spec/models/order_spec.rb"] }
```

A file matches on whole path segments from the end.

## What it records

- The example's title path: each `describe`, `context` or `feature`
  title, then the `it`, `specify`, `example` or `scenario` title,
  joined with ` > `. A group given a constant is titled by the constant
  as written, so `describe Orders::Cancel` gives `Orders::Cancel`. A
  title that is not a plain string, or an example with no title such
  as `it { is_expected.to be_open }`, keeps its source text and is
  recorded under `metadata.test.unresolvedTitle`.
- What the example runs. Its own block, every `before` hook and `let!`
  in the groups around it, and each `let` or `subject` it reads by
  name, from the nearest group that defines it. `is_expected` reads the
  subject. Their calls count as the example's own.
- Whether the example runs. `xit`, `skip` and `pending` examples, any
  example under `xdescribe` or `xcontext`, `:skip` or `skip: true`
  metadata on the example or a group, and a `skip` or `pending`
  statement in the example or a `before` hook are all recorded as
  `metadata.test.skipped`.
- What the example replaces, under `metadata.test.mocks`.
  `allow(Order).to receive(:cancel)` and `expect(...).to receive`
  record the file that defines `Order` and the method `cancel`;
  `receive_messages` records each key. A receiver that is not a
  constant the run defines records the method name alone.
  `stub_const("Order", ...)` records the whole file. A double such as
  `instance_double(Order)` replaces nothing the test would otherwise
  reach, so it records only the call, unless the test makes it the
  constant with `as_stubbed_const`.

The intent check refuses to count a path into a mocked method as
reaching the subject, and says which mock was in the way.

## What this leaves out

- Examples inside `shared_examples` and `shared_context`, and the
  groups that include them with `it_behaves_like`.
- `described_class`, which is read as a call RSpec handles and not
  followed to the class it describes.
- Minitest. Its tests are methods on a class or blocks under a class,
  and need their own pattern.
- Tests generated in a loop, such as `%w[a b].each { |x| it x do ... }`.
  The example is read once, under its title as written.
