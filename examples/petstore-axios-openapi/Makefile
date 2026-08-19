SUSS := node ../../packages/cli/dist/bin.js
OUT  := out

.PHONY: all extract contract check inspect-consumer inspect-provider clean

all: extract contract check

# Build the CLI from this monorepo before anything else if dist is missing.
$(OUT):
	mkdir -p $(OUT)

# Extract behavioral summaries from the TS consumer.
extract: $(OUT)
	$(SUSS) extract -p tsconfig.json -f axios -o $(OUT)/consumer.json

# Derive the provider summary from the OpenAPI spec.
contract: $(OUT)
	$(SUSS) contract --from openapi petstore-openapi.json -o $(OUT)/provider.json

# Cross-boundary check both files together. The consumer's bugs are
# warnings, so gate on warnings to fail the run on them.
check: $(OUT)/consumer.json $(OUT)/provider.json
	$(SUSS) check --dir $(OUT) --fail-on warning

# Render the human-readable view of either side.
inspect-consumer:
	$(SUSS) inspect $(OUT)/consumer.json

inspect-provider:
	$(SUSS) inspect $(OUT)/provider.json

clean:
	rm -rf $(OUT)
