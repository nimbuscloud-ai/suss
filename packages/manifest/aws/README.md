# @suss/manifest-aws

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

Reads a CloudFormation or SAM template into plain data: the resources, what each one declares, the globals every function inherits, the nested stacks, and the ARNs and event patterns written across them.

Two kinds of reader work from that data. `@suss/contract-cloudformation` and `@suss/contract-serverless` turn a template into summaries, and the Lambda pack pairs a handler in code against the route or queue the template gives it. Both used to parse the template themselves, and they disagreed about what it said.

## Where it fits

It depends on `@suss/behavioral-ir` and a YAML parser, and it produces data rather than summaries. Nothing here decides what a resource means; a reader does.

## More

- [Contract sources](https://nimbuscloud-ai.github.io/suss/contract-sources)
- [Documentation](https://nimbuscloud-ai.github.io/suss/)
- [Every package and pack suss ships](https://nimbuscloud-ai.github.io/suss/reference/packages)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

![coverage](../../../.github/badges/coverage-manifest-aws.svg)

Apache 2.0. See [LICENSE](../../../LICENSE).
