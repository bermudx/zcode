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
