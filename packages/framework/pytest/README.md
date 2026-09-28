# @suss/framework-pytest

The pack for pytest tests. It reads each test as a `test` unit, so a
PRD scenario can say which test covers it and `suss check --intent` can
check that the test is still there, still runs, and still reaches what
the scenario is about.

```python
from app.orders import cancel_order

class TestCancel:
    def test_marks_the_order_cancelled(self):
        assert cancel_order("o-1")["status"] == "cancelled"
```

That test becomes a unit named `TestCancel > test_marks_the_order_cancelled`,
and a PRD lists it by the node id pytest prints:

```yaml
coveredBy: tests/test_orders.py::TestCancel::test_marks_the_order_cancelled
```

A parametrized id such as `test_refund[card]` means the function
`test_refund`. A test is no boundary, so its unit pairs with nothing.
Its body is read like any other unit, so its calls are recorded and a
reach question can follow them.

## Usage

Read only the test files your PRDs list:

```bash
suss extract --lang python -f pytest -f fastapi --intent intent/ -o .suss/code.json
suss check --dir .suss --intent intent/
```

`--intent` reads the `coveredBy` lines in the PRDs under `intent/` and
hands the pack those files. Without it the pack reads every file pytest
would collect, which can double what an extract walks, so `suss init`
does not suggest the pack. To list the files yourself, write them to a
config file:

```bash
suss extract --lang python -f pytest=pytest.json
```

```json
{ "files": ["tests/test_orders.py"] }
```

A file matches on whole path segments from the end, so a repo-relative
path matches a file the run reads from a package directory.

## What it records

- The tests pytest collects with its default settings: `test` functions
  in `test_*.py` and `*_test.py` files, `test` methods on `Test` classes,
  and `test` methods on any `unittest.TestCase` subclass.
- The fixtures each test asks for by parameter name, found on the
  class, in the module, or in a `conftest.py` in the test's directory or
  above, plus every `autouse` fixture in scope and a TestCase's `setUp`.
  The test's unit calls each one, so a path through a fixture counts as
  the test reaching what the fixture calls.
- Whether the test runs. `@pytest.mark.skip`, `skipif`, `xfail`,
  `unittest.skip`, `skipIf`, `skipUnless` and `expectedFailure`, on the
  test, on a class around it, or in a `pytestmark` variable, are recorded
  as `metadata.test.skipped`.
- What the test replaces before it runs, under `metadata.test.mocks`:
  `unittest.mock.patch` and `patch.object` as a decorator or a context
  manager, `mocker.patch` and `mocker.patch.object`, and
  `monkeypatch.setattr`, in the test or in a fixture it runs through. A
  dotted path is followed to the project file that defines the thing
  patched.

The intent check refuses to count a path into a patched function as
reaching the subject, and says which patch was in the way.

## What this leaves out

- A `python_files`, `python_classes` or `python_functions` setting in the
  project's pytest configuration, and tests a plugin collects.
- Fixtures requested through `request.getfixturevalue` or
  `@pytest.mark.usefixtures`.
- `setUpClass`, `setup_method` and `setup_function`.
- A condition on `skipif`. The test is recorded as skipped whatever the
  condition says.
