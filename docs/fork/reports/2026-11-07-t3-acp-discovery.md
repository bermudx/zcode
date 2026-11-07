# T3 ACP provider discovery

The operator asked whether the local setup worked. Read-only inspection of
the connected T3 server on 2026-11-07 confirmed:

- Provider instance `acpRegistry_piz`, display name `Piz`, is registered.
- T3's capabilities response lists no availability constraints for it.
- Its model catalog contains `account:zai-individual-coding-plan/GLM-5.3`
  and `account:zai-individual-coding-plan/GLM-5.3-Flash`.
- Both models expose `plan` and `build` modes.

This confirms provider registration and a populated T3 catalog, not a
completed model turn. The top-level thread listing returned 80 threads;
none was assigned to `acpRegistry_piz`. No conversation content was read.

To check the next boundary, create a T3 thread with the Piz provider,
choose a reported model, and send a short text prompt. A completed response
would establish a basic end-to-end turn; signing, allowance eligibility,
cancel/rollback behavior and resource cost need separate evidence.

No test prompts, model requests, provider changes, credential reads,
builds, restarts, installations, or network fetches were performed.

## Operator follow-up: visible response

The operator then supplied a T3 screenshot showing a completed response,
the `GLM-5.3-Flash` composer selection, and an open mention picker listing
past threads and workspace files. The response describes the current
repository, branch, and untracked backup directory. This is operator-supplied
evidence of a basic working conversation, beyond the earlier catalog check.
The operator also reports that mentions work; the screenshot alone shows
the picker, not delivery of a selected conversation's contents to the model.

This does not demonstrate MCP support. Source inspection of
`acp-agent.ts` confirms that `session/new` logs and ignores client-provided
`mcpServers`. `acp-project.ts` separately accepts text and resource prompt
blocks, so receiving context is not evidence of callable T3 tools.

Recommendation: treat basic ACP use as working and MCP integration as a
separate optional feature, needed if the agent must call T3's tools. Before
calling the whole integration accepted, retain the outstanding permission,
cancel/resume, signing/allowance and resource checks. No MCP implementation
or new model turn was started in response to the operator's question.
