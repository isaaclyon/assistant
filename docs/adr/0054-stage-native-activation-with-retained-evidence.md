---
status: accepted
relates-to: ADR-0003, ADR-0005, ADR-0020, ADR-0030, ADR-0051, ADR-0052, ADR-0053
---

# Stage native activation with retained evidence

## Context

C0 approves separate native releases and explicit per-instance advancement.
The existing isolated deployment coordinates one system-managed personal runtime,
user-managed peers and an independent trusted broker. Its hold, paired checkpoint
and irreversible startup barrier already prevent unsafe code/state rewind.
Legacy pending inbox rows can survive admission. Session text therefore cannot
establish whether old work or its external effects complete.

## Decision

Extend the existing administrator adapter with a private complete runtime map.
Each stage changes one selected instance to a distinct full native release SHA.
Unchanged peers keep their approved executable, configuration and release.
The broker retains its independently installed release. A full fleet restart
under coordinated holds can occur without changing peers' runtime selections.
The map is administrator input, never a model-facing runtime switch.

Build exact reviewed commits in a separate release root using an external
allowlist. Record the immutable tree digest. Administrator handover makes the
staged tree, its digest sidecar and their ancestors root-owned before activation.
The adapter verifies that result and copies it into the installed release root.
It reads native configuration and the selected Telegram identity as data before
the checkpoint. It never imports candidate code during preflight.
The rendered unit pins the native configuration digest. Daemon and inspector
entrypoints verify it on every start; isolated configurations require the pin.
Runtime-owned configuration rewrites cannot change administrator-bound authority
on an automatic restart. Native startup owns full schema/provider validation
after the startup barrier.

A first legacy-to-native transition requires a known empty legacy inbox before
holds and again after quiescence. Pending or unknown work requires preserved
copies and separate reconciliation; the adapter never drains or deletes it.
Native-to-native upgrades use the native source-binding recovery checks.

Keep the existing sequence: hold, stop, verify quiescence, checkpoint, migrate
selected supported assets, install, mark candidate startup, authorize, start,
verify exact readiness, revoke authorization, enable, and release holds.
Record root-owned stage/readiness receipts and the current map. Failure keeps
writers held and disabled. There is no automatic rewind after candidate startup.

A separate observation invocation verifies a scheduled native run through its
admission, exact source binding, submission identity and completed state. It
performs a controlled restart and verifies a distinct stable process at the
selected release. The full configured interval starts at initial readiness.
Retain the proof, observation and digest. Advancement requires the exact previous
map chain and its observation, then a new explicit stage invocation.

Frozen-copy migration is a separate preservation operation. Inventory and apply
retain canonical bytes, historical anchors, domain stores, Telegram/broker
ownership evidence and browser gates. Unknown old work remains quarantined.
Operator receipt files require independent verification; ownership and digests
alone do not authenticate their producer. No legacy JavaScript stack or task
checkpoint is synthesized. C6 migration output always remains held and cannot
be installed through this tool as executable native work.

## Consequences

- Staged activation and frozen-copy preservation have separate evidence and
  acceptance boundaries. Passing one cannot silently authorize the other.
- The supported isolated topology remains explicit. This does not create a
  generic deployment framework or broaden runtime privileges.
- Scheduled admission does not establish task completion or external delivery.
  Uncertain delivery and blocked task evidence prevent canary advancement.
- Root-owned receipts, matching checkpoints and canonical operation receipts
  remain available for reconciliation. Git/Obsidian use does not retire receipts.
- Disposable synthetic Linux acceptance does not authorize production rollout,
  prove live integrations or remove the separate C7 gate.

See the [C6 rehearsal guide](../pi-durable-c6-rehearsal.md) for command ownership,
held-output limits and validation scope.
