SUSS := node ../../packages/cli/dist/index.js
OUT  := out

.PHONY: all extract stub check inspect-consumer inspect-provider clean

all: extract stub check

# Build the CLI from this monorepo before anything else if dist is missing.
$(OUT):
	mkdir -p $(OUT)

# Extract behavioral summaries from the TS consumer.
extract: $(OUT)
	$(SUSS) extract -p tsconfig.json -f axios -o $(OUT)/consumer.json

# Stub the OpenAPI spec into a provider summary file.
stub: $(OUT)
	$(SUSS) stub --from openapi petstore-openapi.json -o $(OUT)/provider.json

# Cross-boundary check both files together.
check: $(OUT)/consumer.json $(OUT)/provider.json
	$(SUSS) check --dir $(OUT)

# Render the human-readable view of either side.
inspect-consumer:
	$(SUSS) inspect $(OUT)/consumer.json

inspect-provider:
	$(SUSS) inspect $(OUT)/provider.json

clean:
	rm -rf $(OUT)
