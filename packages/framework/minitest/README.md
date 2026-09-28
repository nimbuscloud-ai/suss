# @suss/framework-minitest

The pack for Minitest and the test cases Rails builds on it. It reads
each test as a `test` unit, so a PRD scenario can say which test covers
it and `suss check --intent` can check that the test is still there,
still runs, and still reaches what the scenario is about.

```ruby
class OrderTest < ActiveSupport::TestCase
  setup do
    @order = Order.new
  end

  test "cancels twice without harm" do
    @order.cancel
    @order.cancel
  end
end
```

That test becomes a unit named `OrderTest > test_cancels_twice_without_harm`,
the class and the method Rails defines for the block, and a PRD lists it
with the file in front:

```yaml
coveredBy: test/models/order_test.rb > OrderTest > test_cancels_twice_without_harm
```

## Usage

Read only the test files your PRDs list:

```bash
suss extract --lang ruby -f rails -f minitest -f factory-bot --intent intent/ -o .suss/code.json
suss check --dir .suss --intent intent/
```

`--intent` hands the pack the files the PRDs list under `coveredBy`.
Without it the pack reads every `*_test.rb` file, so `suss init` does
not suggest the pack. A config file can list the files instead:
`-f minitest=minitest.json` with `{ "files": ["test/models/order_test.rb"] }`.

## What it records

- A test class: a class whose ancestry reaches `Minitest::Test`,
  `ActiveSupport::TestCase` or one of the Rails test cases built on it,
  directly or through a project class.
- Each test in it: a `test_*` method, or a `test "..." do` block named
  `test_` and its description with each run of spaces as `_`.
- What the test runs: its own body, then its class's `setup` blocks and
  `setup` method. Their calls count as the test's own, and assertions
  such as `assert_equal` are left out.
- Which class each call was sent to, as `receiverClass` on the call,
  when the receiver is a class the project defines or an instance of
  one, including a finder such as `Order.find(1)` and a column read.
- Whether it runs: a `skip` statement in the test marks it
  `metadata.test.skipped`.
- What it stubs, under `metadata.test.mocks`: `Order.stub(:cancel, 1)`,
  and mocha's `Order.expects(:cancel)` and `Order.stubs(:cancel)`,
  record the file that defines `Order` and the method `cancel`.

## What this leaves out

- `setup` in a project base class the test class extends.
- Rails fixtures such as `orders(:one)`. Nothing says which class a
  fixture accessor gives back yet.
- `Minitest::Spec`'s `describe` and `it`.
