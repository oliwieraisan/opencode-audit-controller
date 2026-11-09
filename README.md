# OpenCode Audit Controller

A local Node.js controller that uses [OpenCode](https://opencode.ai/) to split an evidence audit into small, resumable batches. It was built to make a long source-checking workflow easier to inspect, pause, and resume.

Each batch starts in a fresh session with a source verifier or a methodology reviewer. The controller limits file access to the batch, records checkpoints, and validates result structure, claim coverage, source hashes, and quoted passages. It keeps the two roles' results separate for human review.

## Try it offline

With Node.js 22 or later, run these commands from the repository root:

```sh
node demo.mjs
node controller.mjs status .demo/CODEX_Licencjat/04_ROBOCZE_CODEX/run/registry.json
node controller.mjs preview .demo/CODEX_Licencjat/04_ROBOCZE_CODEX/run/registry.json
node --test controller.test.mjs
```

The fictional demo prepares two batches and writes prompt previews under `.demo/`. The tests exercise the controller with a simulated provider, including interruption, resumption, and rejection of invalid evidence. These commands require no OpenCode installation, API credentials, or model calls.

For a live run, use a compatible OpenCode v2 CLI with the session API. Set `OPENCODE_MODEL` to `providerID/modelID` and optionally set `OPENCODE_CLI` to the executable path before creating a fresh `.demo/`. Then run `node controller.mjs run <registry-path>`. A live run sends the batch prompt and any evidence the agent reads to the configured provider. The included demo was verified offline. A human reviewer decides whether the evidence supports a claim.
