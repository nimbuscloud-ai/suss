# @suss/manifest-aws

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

Reads a CloudFormation or SAM template into plain data: the resources, what each one declares, the globals every function inherits, the nested stacks, and the ARNs and event patterns written across them.

Two kinds of reader work from that data. `@suss/contract-cloudformation` and `@suss/contract-serverless` turn a template into summaries. The Lambda pack pairs a handler in code with the route or queue the template assigns to it. Both used to parse the template themselves, and they disagreed about its contents.

## Where it fits

It depends on `@suss/behavioral-ir` and a YAML parser. It produces plain data, and the readers build summaries from it. The readers also decide what each resource means, and this package leaves that to them.

## More

- [Contract sources](https://suss.sh/packs/contract-sources)
- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

![coverage](../../../.github/badges/coverage-manifest-aws.svg)

Apache 2.0. See [LICENSE](../../../LICENSE).
